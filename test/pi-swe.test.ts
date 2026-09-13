import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { loadWorkflow, migrateLegacyWorkflow, saveWorkflow, workflowPath } from "../extensions/pi-swe/src/store.ts";
import { createWorkflow, parseWorkflow, readyTasks, reduceWorkflow } from "../extensions/pi-swe/src/workflow.ts";

const now = "2026-01-01T00:00:00.000Z";

function sample() {
  return createWorkflow({ topic: "demo", goal: "Ship demo", now, tasks: [
    { id: "T1", title: "Core" },
    { id: "T2", title: "Integration", dependsOn: ["T1"] },
  ] });
}

test("workflow reducer selects dependencies, requires verification, and completes", () => {
  let workflow = sample();
  assert.deepEqual(readyTasks(workflow).map((task) => task.id), ["T1"]);
  workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  assert.equal(workflow.activeTask, "T1");
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { command: "node", args: ["--test"], exitCode: 0, at: now } }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "complete-task" }, now).workflow;
  assert.equal(workflow.tasks[0]!.status, "complete");
  assert.equal(workflow.activeTask, "T2");
});

test("workflow parser rejects missing dependencies and cycles", () => {
  assert.throws(() => createWorkflow({ topic: "demo", goal: "x", tasks: [{ id: "A", title: "A", dependsOn: ["missing"] }] }), /missing dependency/);
  assert.throws(() => createWorkflow({ topic: "demo", goal: "x", tasks: [{ id: "A", title: "A", dependsOn: ["B"] }, { id: "B", title: "B", dependsOn: ["A"] }] }), /cycle/);
  assert.throws(() => parseWorkflow({ ...sample(), version: 2 }), /unsupported/);
});

test("store writes one file and rejects stale revisions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-"));
  const workflow = sample();
  saveWorkflow(cwd, workflow);
  assert.equal(loadWorkflow(cwd, "demo")!.workflow.goal, "Ship demo");
  const next = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  saveWorkflow(cwd, next, 1);
  assert.throws(() => saveWorkflow(cwd, workflow, 1), /workflow changed/);
  assert.equal(existsSync(join(cwd, workflowPath("demo"))), true);
});

test("legacy migration preserves executable IDs, dependencies, and active work", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-legacy-"));
  const root = join(cwd, ".model-artifacts/initiatives/legacy");
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "plans/r1"), { recursive: true });
  writeFileSync(join(root, "specs/manifest.json"), JSON.stringify({ schemaVersion: 2, updatedAt: now, activePlan: { revision: 1, path: "plan.md", contractRoot: ".model-artifacts/initiatives/legacy/plans/r1" }, activeContract: { id: "P01-C02" } }));
  writeFileSync(join(root, "plans/r1/contracts.json"), JSON.stringify({ contracts: [
    { id: "P01", kind: "phase", status: "pending" },
    { id: "P01-C01", kind: "subphase", parentId: "P01", status: "complete" },
    { id: "P01-C02", kind: "subphase", parentId: "P01", status: "implementing", dependsOn: ["P01-C01"] },
  ], contractFacts: {} }));
  const preview = loadWorkflow(cwd, "legacy")!;
  assert.equal(preview.kind, "legacy");
  assert.deepEqual(preview.workflow.tasks.map((task) => task.id), ["P01-C01", "P01-C02"]);
  assert.equal(preview.workflow.activeTask, "P01-C02");
  migrateLegacyWorkflow(cwd, "legacy");
  assert.equal(loadWorkflow(cwd, "legacy")!.kind, "native");
  assert.equal(existsSync(join(root, "specs/manifest.json")), true);
});

test("latest verification must pass", () => {
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { command: "node", args: [], exitCode: 0, at: now } }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { command: "node", args: [], exitCode: 1, at: now } }, now).workflow;
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
});

test("extension registers one command and one tool", () => {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  piSwe({ registerCommand: (name: string, value: unknown) => commands.set(name, value), registerTool: (value: { name: string }) => tools.set(value.name, value) } as never);
  assert.deepEqual([...commands], [["swe", commands.get("swe")]]);
  assert.deepEqual([...tools.keys()], ["swe_workflow"]);
});

test("workflow tool creates, starts, objectively verifies, and completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-"));
  let tool: any;
  piSwe({
    registerCommand: () => undefined,
    registerTool: (value: unknown) => { tool = value; },
    exec: async (command: string, args: string[]) => ({ stdout: `${command} ${args.join(" ")}`, stderr: "", code: 0, killed: false }),
  } as never);
  const call = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, { cwd });
  await call({ action: "create", topic: "tool-demo", goal: "Exercise workflow", tasks: [{ id: "T1", title: "Implement", verification: [{ command: "node", args: ["--version"] }] }] });
  await call({ action: "start", topic: "tool-demo" });
  await call({ action: "verify", topic: "tool-demo" });
  await call({ action: "complete", topic: "tool-demo" });
  assert.equal(loadWorkflow(cwd, "tool-demo")!.workflow.status, "complete");
});
