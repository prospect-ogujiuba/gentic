import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  evaluateCutoverReadiness,
  formatCutoverReadiness,
  inspectCutoverReadiness,
  type CutoverReadinessObservation,
} from "../extensions/pi-swe/src/cutover.ts";
import { createWorkflow } from "../extensions/pi-swe/src/workflow.ts";

const passingObservation = (): CutoverReadinessObservation => ({
  migrationContractComplete: true,
  activationContractComplete: true,
  migrationAuditClean: true,
  nodeSupported: true,
  piSupported: true,
  activeWorkflowTopics: ["swe-production-rollout"],
  controllingTopic: "swe-production-rollout",
  activeTodoCount: 0,
  recoveryClean: true,
  releaseChecks: [
    { name: "npm run typecheck", passed: true },
    { name: "npm test", passed: true },
  ],
});

function writeJson(cwd: string, path: string, value: unknown): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function tree(cwd: string): string[] {
  const output: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      output.push(`${entry.isDirectory() ? "d" : "f"}:${path}`);
      if (entry.isDirectory()) visit(join(directory, entry.name), path);
    }
  };
  visit(cwd);
  return output;
}

test("cutover readiness reports four independent categories without granting activation", () => {
  const first = evaluateCutoverReadiness(passingObservation());
  const second = evaluateCutoverReadiness(passingObservation());

  assert.deepEqual(first, second);
  assert.equal(first.ready, true);
  assert.equal(first.activatesRuntime, false);
  assert.deepEqual(first.categories.map(({ id, status }) => [id, status]), [
    ["code", "ready"],
    ["repository-migration", "ready"],
    ["runtime-activation", "ready"],
    ["external-release-authorization", "pending"],
  ]);
  assert.match(first.nextAction, /separate operator cutover decision/i);
  assert.match(formatCutoverReadiness(first), /evidence only; runtime activation remains unchanged/i);
});

test("every required technical gate fails closed with bounded output and exactly one next action", () => {
  const cases: Array<[string, (value: CutoverReadinessObservation) => void]> = [
    ["supported Node", (value) => { value.nodeSupported = false; }],
    ["supported Pi", (value) => { value.piSupported = false; }],
    ["release checks", (value) => { value.releaseChecks[0] = { name: "npm run typecheck", passed: false }; }],
    ["migration contract", (value) => { value.migrationContractComplete = false; }],
    ["migration audit", (value) => { value.migrationAuditClean = false; }],
    ["active workflow", (value) => { value.activeWorkflowTopics.push("other-work"); }],
    ["activation contract", (value) => { value.activationContractComplete = false; }],
    ["active todo", (value) => { value.activeTodoCount = 1; }],
    ["recovery", (value) => { value.recoveryClean = false; }],
  ];

  for (const [name, mutate] of cases) {
    const observation = passingObservation();
    mutate(observation);
    const report = evaluateCutoverReadiness(observation);
    const output = formatCutoverReadiness(report);
    assert.equal(report.ready, false, name);
    assert.equal(report.activatesRuntime, false, name);
    assert.equal(report.nextAction.length > 0, true, name);
    assert.equal((output.match(/^Next action:/gm) ?? []).length, 1, name);
    assert.equal(Buffer.byteLength(output) <= 4096, true, name);
  }
});

test("repository inspection is deterministic, read-only, and detects contracts, audits, ownership, and recovery", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-cutover-"));
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const workflow = createWorkflow({
      topic: "swe-production-rollout",
      goal: "qualify cutover",
      now,
      tasks: [
        { id: "migration-qualification", title: "migration", writeScope: ["src/**"], nonGoals: [], verificationDecision: { kind: "manual", rationale: "fixture", decidedBy: "fixture", at: now } },
        { id: "activation-qualification", title: "activation", dependsOn: ["migration-qualification"], writeScope: ["src/**"], nonGoals: [], verificationDecision: { kind: "manual", rationale: "fixture", decidedBy: "fixture", at: now } },
        { id: "cutover-readiness", title: "cutover", dependsOn: ["activation-qualification"], writeScope: ["src/**"], nonGoals: [], verificationDecision: { kind: "manual", rationale: "fixture", decidedBy: "fixture", at: now } },
      ],
    });
    workflow.tasks[0]!.status = "complete";
    workflow.tasks[0]!.phase = "historical";
    workflow.tasks[1]!.status = "complete";
    workflow.tasks[1]!.phase = "historical";
    writeJson(cwd, ".model-artifacts/initiatives/swe-production-rollout/workflow.json", workflow);
    const before = tree(cwd);
    const input = {
      activeTodoCount: 0,
      nodeVersion: "v22.19.0",
      nodeSupport: ">=22.19.0",
      piVersions: ["0.84.2", "0.84.2", "0.84.2"],
      expectedPiVersion: "0.84.2",
      releaseChecks: [{ name: "npm test", passed: true }],
    };

    const first = inspectCutoverReadiness(cwd, input);
    const second = inspectCutoverReadiness(cwd, input);
    assert.deepEqual(first, second);
    assert.equal(first.ready, true);
    assert.deepEqual(tree(cwd), before);

    writeJson(cwd, ".model-artifacts/system/logs/pi-swe-migration/topic/journal.json", { state: "prepared" });
    const blocked = inspectCutoverReadiness(cwd, input);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.categories.find((item) => item.id === "runtime-activation")!.status, "blocked");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing or malformed repository authority fails closed without exposing parser details", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-cutover-invalid-"));
  try {
    writeJson(cwd, ".model-artifacts/initiatives/swe-production-rollout/workflow.json", { token: "do-not-report" });
    const report = inspectCutoverReadiness(cwd, {
      activeTodoCount: 0,
      nodeVersion: process.version,
      nodeSupport: ">=22.19.0",
      piVersions: ["0.84.2"],
      expectedPiVersion: "0.84.2",
      releaseChecks: [{ name: "npm test", passed: true }],
    });
    const output = formatCutoverReadiness(report);
    assert.equal(report.ready, false);
    assert.doesNotMatch(output, /do-not-report|invalid workflow state|stack/i);
    assert.equal(Buffer.byteLength(output) <= 4096, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
