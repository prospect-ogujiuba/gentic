import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { activeWorkflowTopics, loadWorkflow, migrateLegacyWorkflow, saveWorkflow, workflowPath } from "../extensions/pi-swe/src/store.ts";
import { buildTaskExecutionPrompt } from "../extensions/pi-swe/src/command.ts";
import { registerTodoActivityProbe } from "../src/lifecycle-coordination.ts";
import { createWorkflow, parseWorkflow, readyTasks, reduceWorkflow, reviseWorkflow, summarizeWorkflow } from "../extensions/pi-swe/src/workflow.ts";

const now = "2026-01-01T00:00:00.000Z";

function evidence(command: string, exitCode: number, workflowRevision: number) {
  return { command, args: [], exitCode, at: "2026-01-01T00:00:01.000Z", source: { kind: "bash-tool-result" as const, toolCallId: `bash-${workflowRevision}`, workflowRevision, sessionId: "test-session" } };
}

function sample() {
  return createWorkflow({ topic: "demo", goal: "Ship demo", now, tasks: [
    { id: "T1", title: "Core" },
    { id: "T2", title: "Integration", dependsOn: ["T1"] },
  ] });
}

function fixturePi(overrides: Record<string, unknown>) {
  return {
    on: () => undefined,
    getAllTools: () => ["read", "grep", "find", "ls", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
    ...overrides,
  } as never;
}

function initRepository(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}

test("workflow reducer selects dependencies, requires verification, and completes", () => {
  let workflow = sample();
  assert.deepEqual(readyTasks(workflow).map((task) => task.id), ["T1"]);
  workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  assert.equal(workflow.activeTask, "T1");
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { ...evidence("node", 0, 2), args: ["--test"] } }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "complete-task" }, now).workflow;
  assert.equal(workflow.tasks[0]!.status, "complete");
  assert.equal(workflow.tasks[0]!.completedAt, now);
  assert.equal(workflow.activeTask, "T2");
});

test("workflow parser rejects missing dependencies and cycles", () => {
  assert.throws(() => createWorkflow({ topic: "demo", goal: "x", tasks: [{ id: "A", title: "A", dependsOn: ["missing"] }] }), /missing dependency/);
  assert.throws(() => createWorkflow({ topic: "demo", goal: "x", tasks: [{ id: "A", title: "A", dependsOn: ["B"] }, { id: "B", title: "B", dependsOn: ["A"] }] }), /cycle/);
  assert.throws(() => createWorkflow({ topic: "demo", goal: "x", tasks: [{ id: "A", title: "A", approaches: ["guessing" as never] }] }), /invalid approach/);
  assert.throws(() => parseWorkflow({ ...sample(), version: 3 }), /unsupported/);
  const legacyShape = structuredClone(sample()) as any;
  delete legacyShape.tasks[0].approaches;
  delete legacyShape.tasks[0].approachReasons;
  delete legacyShape.tasks[0].assessmentStatus;
  assert.equal(parseWorkflow(legacyShape).tasks[0].assessmentStatus, "unassessed");
  assert.throws(() => parseWorkflow({ ...sample(), tasks: [{ ...sample().tasks[0], assessmentStatus: "unknown" }] }), /invalid assessmentStatus/);
  assert.throws(() => parseWorkflow({ ...sample(), status: "active" }), /requires an active task/);
  assert.throws(() => parseWorkflow({ ...sample(), status: "complete" }), /does not match task states/);
});

test("workflow normalization enforces schema bounds without rewriting command arguments", () => {
  const workflow = createWorkflow({ topic: "arguments", goal: "Check arguments", tasks: [{ id: "A", title: "A", approaches: [], verification: [{ command: "node", args: ["--eval", "process.exit(0)", "same", "same"] }] }] });
  assert.deepEqual(workflow.tasks[0]!.verification[0]!.args, ["--eval", "process.exit(0)", "same", "same"]);
  assert.throws(() => createWorkflow({ topic: "too-long", goal: "x".repeat(2049), tasks: [{ id: "A", title: "A" }] }), /goal exceeds/);
  assert.throws(() => createWorkflow({ topic: "duplicates", goal: "x", tasks: [{ id: "A", title: "A", verification: [{ command: "npm test", args: [] }, { command: "npm test", args: [] }] }] }), /duplicate verification/);
});

test("tasks retain transparent approach assessments and execution guidance", () => {
  const workflow = createWorkflow({ topic: "approaches", goal: "Replace cache", now, tasks: [{
    id: "T1",
    title: "Replace cache lookup",
    approaches: ["tdd", "dsa", "performance"],
    approachReasons: {
      tdd: "Lookup behavior must remain stable",
      dsa: "The representation controls lookup cost",
      performance: "Latency is the reason for the change",
    },
    acceptance: ["Lookup behavior remains compatible"],
    verification: [{ command: "npm test", args: [] }],
  }] });
  assert.deepEqual(workflow.tasks[0]!.approaches, ["tdd", "dsa", "performance"]);
  assert.equal(workflow.tasks[0]!.approachReasons.performance, "Latency is the reason for the change");
  const prompt = buildTaskExecutionPrompt(workflow, workflow.tasks[0]!, ".model-artifacts/initiatives/approaches/workflow.json");
  assert.match(prompt, /establish a failing or characterization test/i);
  assert.match(prompt, /access patterns and complexity/i);
  assert.match(prompt, /measurable baseline/i);
  assert.match(prompt, /material scope or design change.*revise/i);
  assert.match(prompt, /npm test/);
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
  const revision = join(root, "plans/revisions/r1");
  mkdirSync(revision, { recursive: true });
  const contract1 = ".model-artifacts/initiatives/legacy/plans/revisions/r1/c1.md";
  const contract2 = ".model-artifacts/initiatives/legacy/plans/revisions/r1/c2.md";
  writeFileSync(join(root, "specs/manifest.json"), JSON.stringify({ schemaVersion: 2, updatedAt: now, activePlan: { revision: 1, path: "plan.md", contractRoot: ".model-artifacts/initiatives/legacy/plans/revisions/r1" }, activeContract: { id: "P01-C02", blockedReason: "waiting for operator input" } }));
  writeFileSync(join(cwd, contract1), "# P01-C01: Real completed title\n\n## Acceptance criteria\n\n- preserves legacy acceptance\n\n## TDD/verification\n\nRun `npm run test:swe`.\n");
  writeFileSync(join(cwd, contract2), "# P01-C02: Real active title\n\n## Acceptance criteria\n\n- continues active work\n\n## TDD/verification\n\nRun `npm run typecheck`.\n");
  writeFileSync(join(revision, "contracts.json"), JSON.stringify({ contracts: [
    { id: "P01", kind: "phase", status: "pending" },
    { id: "P01-C01", kind: "subphase", parentId: "P01", status: "complete", path: contract1, contentHash: "sha256:first" },
    { id: "P01-C02", kind: "subphase", parentId: "P01", status: "implementing", dependsOn: ["P01-C01"], path: contract2 },
    { id: "P01-C03", kind: "subphase", parentId: "P01", status: "pending", dependencies: ["P01-C02"], title: "Approved deferral" },
  ], contractFacts: { "P01-C01": { acceptanceDefined: true, verificationDefined: true }, "P01-C02": { acceptanceDefined: true, verificationDefined: true }, "P01-C03": { deferral: { approved: true } } }, completionRecords: {
    "P01-C01": { schemaVersion: 1, requestId: "request-1", planRevision: 1, contractPath: contract1, preCompletionContentHash: "sha256:pre", completedAt: now, verification: { path: ".model-artifacts/initiatives/legacy/reports/verify.md", contentHash: "sha256:verify" }, review: { path: ".model-artifacts/initiatives/legacy/reports/review.md", contentHash: "sha256:review", decision: "approve" }, nextState: { initiativeState: "executing", activeContractId: "P01-C02", readyContractIds: ["P01-C02"] } }
  } }));
  const preview = loadWorkflow(cwd, "legacy")!;
  assert.equal(preview.kind, "legacy");
  assert.deepEqual(preview.workflow.tasks.map((task) => task.id), ["P01-C01", "P01-C02", "P01-C03"]);
  assert.equal(preview.workflow.activeTask, "P01-C02");
  assert.equal(preview.workflow.status, "paused");
  assert.equal(preview.workflow.tasks[1]!.assessmentStatus, "unassessed");
  assert.equal(preview.workflow.tasks[0]!.title, "Real completed title");
  assert.deepEqual(preview.workflow.tasks[0]!.acceptance, ["preserves legacy acceptance"]);
  assert.deepEqual(preview.workflow.tasks[0]!.verification, [{ command: "npm run test:swe", args: [] }]);
  assert.deepEqual(preview.workflow.tasks[0]!.evidenceLinks, [".model-artifacts/initiatives/legacy/reports/verify.md", ".model-artifacts/initiatives/legacy/reports/review.md"]);
  assert.equal(preview.workflow.tasks[0]!.importedFrom?.completion?.requestId, "request-1");
  assert.equal(preview.workflow.tasks[0]!.importedFrom?.completion?.preCompletionContentHash, "sha256:pre");
  assert.equal(preview.workflow.tasks[0]!.importedFrom?.completion?.verificationContentHash, "sha256:verify");
  assert.equal(preview.workflow.tasks[0]!.importedFrom?.completion?.nextActiveContractId, "P01-C02");
  assert.equal(preview.workflow.tasks[0]!.completedAt, now);
  assert.equal(preview.workflow.tasks[1]!.blockedReason, "waiting for operator input");
  assert.equal(preview.workflow.tasks[2]!.status, "deferred");
  assert.deepEqual(preview.workflow.tasks[2]!.dependsOn, ["P01-C02"]);
  migrateLegacyWorkflow(cwd, "legacy");
  assert.equal(loadWorkflow(cwd, "legacy")!.kind, "native");
  assert.equal(existsSync(join(root, "specs/manifest.json")), true);
});

test("legacy migration rejects a contract root outside the initiative revision tree", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-unsafe-"));
  const root = join(cwd, ".model-artifacts/initiatives/legacy/specs");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 2, activePlan: { contractRoot: "unrelated" } }));
  assert.throws(() => loadWorkflow(cwd, "legacy"), /must be a revision beneath/);
});

test("active workflow scan ignores malformed unrelated legacy initiatives", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-active-scan-"));
  saveWorkflow(cwd, sample());
  const legacyRoot = join(cwd, ".model-artifacts/initiatives/legacy/specs");
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, "manifest.json"), JSON.stringify({ schemaVersion: 2, activePlan: { contractRoot: "unrelated" } }));
  assert.deepEqual(activeWorkflowTopics(cwd, "demo"), []);
});

test("revision preserves completed and active state and all evidence", () => {
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("npm test", 0, 2) }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "complete-task" }, now).workflow;
  const revised = reviseWorkflow(workflow, { tasks: [
    { id: "T1", title: "Reworded core" },
    { id: "T2", title: "Reworded integration", dependsOn: ["T1"] },
    { id: "T3", title: "New task", dependsOn: ["T2"] },
  ] }, now).workflow;
  assert.equal(revised.tasks[0]!.status, "complete");
  assert.equal(revised.tasks[0]!.evidence.length, 1);
  assert.equal(revised.tasks[1]!.status, "active");
  assert.throws(() => reviseWorkflow(workflow, { tasks: [{ id: "T2", title: "Only active" }] }), /cannot remove complete task/);
});

test("paused workflows cannot verify or complete until resumed", () => {
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "pause" }, "2026-01-01T00:00:01.000Z").workflow;
  assert.equal(reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("npm test", 0, workflow.revision) }, now).changed, false);
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
});

test("all planned verification commands must pass after activation", () => {
  let workflow = createWorkflow({ topic: "checks", goal: "verify", now, tasks: [{
    id: "T1", title: "Check", approaches: [], verification: [{ command: "npm test", args: [] }, { command: "npm run typecheck", args: [] }],
  }] });
  workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { ...evidence("npm test", 0, 2), at: "2026-01-01T00:00:01.000Z" } }, now).workflow;
  assert.match(reduceWorkflow(workflow, { type: "complete-task" }, now).message, /missing passing checks: npm run typecheck/);
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { ...evidence("npm run typecheck", 0, 3), at: "2026-01-01T00:00:02.000Z" } }, now).workflow;
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, true);
});

test("assessment reasons are required and status shows every task", () => {
  assert.throws(() => createWorkflow({ topic: "reasons", goal: "x", tasks: [{ id: "A", title: "A", approaches: ["tdd"] }] }), /requires a concise applicability reason/);
  const workflow = createWorkflow({ topic: "status", goal: "x", tasks: [
    { id: "A", title: "A", approaches: ["tdd"], approachReasons: { tdd: "regression risk" } },
    { id: "B", title: "B", approaches: [] },
  ] });
  assert.match(summarizeWorkflow(workflow), /A: tdd \(regression risk\)/);
  assert.match(summarizeWorkflow(workflow), /B: none/);
});

test("a no-op contract revision does not stale current verification", () => {
  let workflow = createWorkflow({ topic: "revision-check", goal: "verify", now, tasks: [{ id: "T1", title: "Check", approaches: [], verification: [{ command: "npm test", args: [] }] }] });
  workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  workflow = reviseWorkflow(workflow, { tasks: [{ id: "T1", title: "Check", approaches: [], verification: [{ command: "npm test", args: [] }] }] }, "2026-01-01T00:00:01.000Z").workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: { ...evidence("npm test", 0, workflow.revision), at: "2026-01-01T00:00:02.000Z" } }, now).workflow;
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, true);
});

test("latest verification must pass", () => {
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("node", 0, 2) }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("node", 1, 3) }, now).workflow;
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
});

test("revision preserves evidence but requires fresh verification", () => {
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("npm test", 0, 2) }, now).workflow;
  workflow = reviseWorkflow(workflow, { tasks: [{ id: "T1", title: "Changed acceptance", acceptance: ["new behavior"] }, { id: "T2", title: "Integration", dependsOn: ["T1"] }] }, now).workflow;
  assert.equal(workflow.tasks[0]!.evidence.length, 0);
  assert.equal(reduceWorkflow(workflow, { type: "complete-task" }, now).changed, false);
});

test("revision reopens a completed workflow when planned work is added", () => {
  let workflow = createWorkflow({ topic: "done", goal: "done", now, tasks: [{ id: "T1", title: "Done" }] });
  workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "record-verification", evidence: evidence("npm test", 0, 2) }, now).workflow;
  workflow = reduceWorkflow(workflow, { type: "complete-task" }, now).workflow;
  assert.equal(workflow.status, "complete");
  const revised = reviseWorkflow(workflow, { tasks: [{ id: "T1", title: "Cannot rewrite completed" }, { id: "T2", title: "Added" }] }, now).workflow;
  assert.equal(revised.status, "draft");
  assert.equal(revised.tasks[0]!.title, "Done");
  assert.deepEqual(readyTasks(revised).map((task) => task.id), ["T2"]);
});

test("extension registers one command and one tool", () => {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  piSwe(fixturePi({ registerCommand: (name: string, value: unknown) => commands.set(name, value), registerTool: (value: { name: string }) => tools.set(value.name, value) }));
  assert.deepEqual([...commands], [["swe", commands.get("swe")]]);
  assert.deepEqual([...tools.keys()], ["swe_workflow"]);
});

test("workflow tool creates, starts, objectively verifies, and completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-"));
  initRepository(cwd);
  let tool: any;
  const branch: any[] = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "stale-bash", name: "bash", arguments: { command: "node --version" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "stale-bash", content: [{ type: "text", text: "v22" }], isError: false, timestamp: Date.now() + 300_000 } },
  ];
  piSwe(fixturePi({
    registerCommand: () => undefined,
    registerTool: (value: unknown) => { tool = value; },
    exec: async () => { throw new Error("verification must not invoke pi.exec"); },
  }));
  const ctx = { cwd, sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" } };
  const call = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx);
  await call({ action: "create", topic: "tool-demo", goal: "Exercise workflow", tasks: [{ id: "T1", title: "Implement", approaches: ["tdd"], approachReasons: { tdd: "Behavior needs regression coverage" }, verification: [{ command: "node", args: ["--version"] }] }] });
  const started = await call({ action: "start", topic: "tool-demo" });
  assert.match(started.content[0].text, /Establish a failing or characterization test/);
  await assert.rejects(() => call({ action: "verify", topic: "tool-demo" }), /predates the active task branch checkpoint/);
  branch.push(
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "node --version" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "bash-1", content: [{ type: "text", text: "v22" }], isError: false, timestamp: Date.now() + 60_000 } },
    { type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "file" }], isError: false, timestamp: Date.now() + 61_000 } },
  );
  await assert.rejects(() => call({ action: "verify", topic: "tool-demo" }), /latest session tool result must be from the protected bash tool/);
  branch.pop();
  branch.push(
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "npm test" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "bash-2", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() + 120_000 } },
  );
  await assert.rejects(() => call({ action: "verify", topic: "tool-demo" }), /not a planned verification/);
  branch.splice(-2);
  await call({ action: "verify", topic: "tool-demo" });
  branch.push({ type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: "edit-after-check", content: [{ type: "text", text: "changed" }], isError: false, timestamp: Date.now() + 180_000 } });
  await assert.rejects(() => call({ action: "complete", topic: "tool-demo" }), /potentially mutating tool ran after recorded verification/);
  branch.pop();
  await call({ action: "complete", topic: "tool-demo" });
  const completed = loadWorkflow(cwd, "tool-demo")!.workflow;
  assert.equal(completed.status, "complete");
  assert.equal(completed.tasks[0]!.evidence[0]!.source?.toolCallId, "bash-1");
});

test("unassessed active work is not presented as executable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-unassessed-"));
  initRepository(cwd);
  let workflow = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  workflow = { ...workflow, tasks: workflow.tasks.map((task) => task.id === "T1" ? { ...task, assessmentStatus: "unassessed" as const, verificationCheckpoint: undefined } : task) };
  saveWorkflow(cwd, workflow);
  let tool: any;
  piSwe(fixturePi({ registerCommand: () => undefined, registerTool: (value: unknown) => { tool = value; } }));
  const response = await tool.execute("call", { action: "start", topic: "demo" }, undefined, undefined, { cwd });
  assert.match(response.content[0].text, /unassessed; revise/);
  assert.doesNotMatch(response.content[0].text, /Continue pi-swe workflow/);
});

test("only one repository workflow can be active", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-single-active-"));
  initRepository(cwd);
  const first = reduceWorkflow(sample(), { type: "start" }, now).workflow;
  saveWorkflow(cwd, first);
  saveWorkflow(cwd, createWorkflow({ topic: "other", goal: "Other", now, tasks: [{ id: "A", title: "Other", approaches: [] }] }));
  let tool: any;
  piSwe(fixturePi({ registerCommand: () => undefined, registerTool: (value: unknown) => { tool = value; } }));
  await assert.rejects(() => tool.execute("call", { action: "start", topic: "other" }, undefined, undefined, { cwd, sessionManager: { getBranch: () => [], getSessionId: () => "session" } }), /workflow demo is active/);
  assert.equal(loadWorkflow(cwd, "other")!.workflow.status, "draft");
});

test("workflow activation rejects competing active todo ownership", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-todo-owner-"));
  initRepository(cwd);
  saveWorkflow(cwd, sample());
  registerTodoActivityProbe(async () => ({ id: "todo-1", title: "Existing implementation" }));
  let tool: any;
  let command: any;
  piSwe(fixturePi({ registerCommand: (_name: string, value: unknown) => { command = value; }, registerTool: (value: unknown) => { tool = value; }, sendUserMessage: () => assert.fail("blocked activation must not enqueue execution") }));
  const sessionManager = { getBranch: () => [], getSessionId: () => "session" };
  await assert.rejects(() => tool.execute("call", { action: "start", topic: "demo" }, undefined, undefined, { cwd, sessionManager }), /finish or block that todo first/);
  const notifications: string[] = [];
  await command.handler("work start demo", { cwd, sessionManager, ui: { notify: (message: string) => notifications.push(message) } });
  assert.match(notifications.at(-1)!, /finish or block that todo first/);
  assert.equal(loadWorkflow(cwd, "demo")!.workflow.status, "draft");
  registerTodoActivityProbe(async () => undefined);
});

test("create rejects a legacy initiative instead of shadowing it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-shadow-"));
  initRepository(cwd);
  mkdirSync(join(cwd, ".model-artifacts/initiatives/demo/specs"), { recursive: true });
  writeFileSync(join(cwd, ".model-artifacts/initiatives/demo/specs/manifest.json"), "{}");
  let tool: any;
  piSwe(fixturePi({ registerCommand: () => undefined, registerTool: (value: unknown) => { tool = value; } }));
  await assert.rejects(() => tool.execute("call", { action: "create", topic: "demo", goal: "x", tasks: [{ id: "T1", title: "x", approaches: [] }] }, undefined, undefined, { cwd }), /migrate it instead/);
  assert.equal(existsSync(join(cwd, workflowPath("demo"))), false);
});
