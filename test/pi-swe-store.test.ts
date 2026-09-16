import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowMutationService } from "../extensions/pi-swe/src/service.ts";
import { loadWorkflow, saveWorkflow, workflowPath } from "../extensions/pi-swe/src/store.ts";
import {
  createWorkflow,
  reduceWorkflow,
  reviseWorkflow,
  type RunnerProvenance,
  type StageReport,
} from "../extensions/pi-swe/src/workflow.ts";

const at = "2026-02-01T00:00:00.000Z";

function provenance(role: RunnerProvenance["role"], runId: string, contractHash: string, snapshotHash = "sha256:snapshot"): RunnerProvenance {
  return {
    runId,
    role,
    actorId: `${role}-actor`,
    leaseId: "lease-1",
    leaseFence: 1,
    contractHash,
    snapshotHash,
    startedAt: at,
    completedAt: "2026-02-01T00:00:01.000Z",
  };
}

function report(kind: StageReport["kind"], role: RunnerProvenance["role"], runId: string, contractHash: string, outcome: StageReport["outcome"] = "approved"): StageReport {
  return {
    kind,
    outcome,
    summary: `${kind} report`,
    findings: [],
    provenance: provenance(role, runId, contractHash),
  };
}

function workflow() {
  return createWorkflow({
    topic: "schema-v2",
    goal: "Ship v2",
    plan: "plans/schema.md",
    linkedPlanContent: "# Plan\n\nImplement the contract.",
    now: at,
    tasks: [{
      id: "T1",
      title: "Implement contract",
      writeScope: ["extensions/pi-swe/**", "test/pi-swe*.test.ts"],
      nonGoals: ["Do not deploy"],
      approaches: ["security"],
      approachReasons: { security: "Transitions are an authority boundary" },
      acceptance: ["Stale evidence is rejected"],
      verification: [{ command: "npm", args: ["run", "typecheck"] }],
    }],
  });
}

function saveFixture(cwd: string): void {
  mkdirSync(join(cwd, "plans"), { recursive: true });
  writeFileSync(join(cwd, "plans/schema.md"), "# Plan\n\nImplement the contract.");
  saveWorkflow(cwd, workflow());
}

test("contract identities are independent from mutation revision and include linked plan content", () => {
  const initial = workflow();
  const planHash = initial.contract.hash;
  const taskHash = initial.tasks[0]!.contract.hash;
  const mutated = reduceWorkflow(initial, { type: "pause" }, "2026-02-01T00:00:02.000Z").workflow;
  assert.equal(mutated.revision, initial.revision + 1);
  assert.equal(mutated.contract.hash, planHash);
  assert.equal(mutated.tasks[0]!.contract.hash, taskHash);

  const revised = reviseWorkflow(initial, {
    linkedPlanContent: "# Plan\n\nChanged requirements.",
    tasks: [{
      id: "T1", title: "Implement contract", writeScope: ["extensions/pi-swe/**"], nonGoals: ["Do not deploy"],
      approaches: ["security"], approachReasons: { security: "Transitions are an authority boundary" },
      acceptance: ["Stale evidence is rejected"], verification: [{ command: "npm", args: ["run", "typecheck"] }],
    }],
  }, "2026-02-01T00:00:03.000Z").workflow;
  assert.notEqual(revised.contract.hash, planHash);
  assert.notEqual(revised.tasks[0]!.contract.hash, taskHash);
  assert.equal(revised.initiativeAcceptance, undefined);
});

test("completed workflows report completion before plan-review requirements", () => {
  const initial = workflow();
  const completed = {
    ...initial,
    status: "complete" as const,
    tasks: initial.tasks.map((task) => ({ ...task, status: "complete" as const, completedAt: at })),
  };

  for (const type of ["start", "resume"] as const) {
    const decision = reduceWorkflow(completed, { type }, "2026-02-01T00:00:02.000Z");
    assert.equal(decision.changed, false);
    assert.equal(decision.message, "workflow is already complete");
  }
});

test("implementation execution blocks without objective checks or an explicit manual decision", () => {
  const missing = createWorkflow({ topic: "missing-check", goal: "x", now: at, tasks: [{ id: "T1", title: "Implement", writeScope: ["src/**"], nonGoals: [] }] });
  const planApproved = reduceWorkflow(missing, {
    type: "record-plan-review",
    report: report("plan-review", "plan-reviewer", "plan-1", missing.contract.hash),
  }, "2026-02-01T00:00:01.000Z").workflow;
  const decision = reduceWorkflow(planApproved, { type: "start" }, "2026-02-01T00:00:02.000Z");
  assert.equal(decision.changed, true);
  assert.equal(decision.workflow.status, "blocked");
  assert.match(decision.workflow.tasks[0]!.blockedReason!, /objective verification.*explicit.*decision/i);
});

test("stage reducer rejects skipped stages, self-review, stale reports, and unresolved blocking findings", () => {
  let current = workflow();
  assert.throws(() => reduceWorkflow(current, { type: "record-implementation", report: report("implementation", "implementer", "impl-1", current.tasks[0]!.contract.hash, "completed") }), /stage|plan review/i);
  current = reduceWorkflow(current, { type: "record-plan-review", report: report("plan-review", "plan-reviewer", "plan-1", current.contract.hash) }, "2026-02-01T00:00:01.000Z").workflow;
  current = reduceWorkflow(current, { type: "start" }, "2026-02-01T00:00:02.000Z").workflow;
  const taskHash = current.tasks[0]!.contract.hash;
  assert.throws(() => reduceWorkflow(current, { type: "record-implementation", report: report("implementation", "implementer", "impl-stale", `sha256:${"0".repeat(64)}`, "completed") }), /stale contract/i);
  current = reduceWorkflow(current, { type: "record-implementation", report: report("implementation", "implementer", "same-run", taskHash, "completed") }, "2026-02-01T00:00:03.000Z").workflow;
  assert.throws(() => reduceWorkflow(current, { type: "record-review", report: report("general-review", "general-reviewer", "same-run", taskHash) }), /self-review/i);
  const blocked = report("general-review", "general-reviewer", "review-1", taskHash);
  blocked.findings = [{ id: "F1", severity: "blocking", status: "open", summary: "Broken authorization", evidence: "test fixture" }];
  current = reduceWorkflow(current, { type: "record-review", report: blocked }, "2026-02-01T00:00:04.000Z").workflow;
  assert.throws(() => reduceWorkflow(current, { type: "complete-task" }), /blocking finding|stage/i);
});

test("an independently reviewed no-change task still requires final initiative acceptance", () => {
  let current = createWorkflow({
    topic: "no-change", goal: "Confirm behavior", now: at,
    tasks: [{ id: "T1", title: "Inspect", writeScope: ["src/**"], nonGoals: ["Do not edit"], approaches: [], verification: [{ command: "npm", args: ["test"] }] }],
  });
  current = reduceWorkflow(current, { type: "record-plan-review", report: report("plan-review", "plan-reviewer", "plan", current.contract.hash) }, "2026-02-01T00:00:01.000Z").workflow;
  current = reduceWorkflow(current, { type: "start" }, "2026-02-01T00:00:02.000Z").workflow;
  const implementation = report("implementation", "implementer", "impl", current.tasks[0]!.contract.hash, "no-change");
  implementation.rationale = "The requested behavior is already present and covered.";
  implementation.changedPaths = [];
  current = reduceWorkflow(current, { type: "record-implementation", report: implementation }, "2026-02-01T00:00:03.000Z").workflow;
  current = reduceWorkflow(current, { type: "record-review", report: report("general-review", "general-reviewer", "review", current.tasks[0]!.contract.hash) }, "2026-02-01T00:00:04.000Z").workflow;
  current = reduceWorkflow(current, { type: "complete-task" }, "2026-02-01T00:00:05.000Z").workflow;
  assert.equal(current.status, "paused");
  assert.equal(current.orchestration.phase, "initiative-acceptance");
  assert.throws(() => reduceWorkflow(current, { type: "complete-initiative" }), /final acceptance/i);
  current = reduceWorkflow(current, { type: "record-initiative-acceptance", report: report("final-acceptance", "final-reviewer", "final", current.contract.hash) }, "2026-02-01T00:00:06.000Z").workflow;
  current = reduceWorkflow(current, { type: "complete-initiative" }, "2026-02-01T00:00:07.000Z").workflow;
  assert.equal(current.status, "complete");
});

test("v1 reads are non-mutating and the first service mutation upgrades atomically", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-v1-upgrade-"));
  const path = join(cwd, workflowPath("legacy-native"));
  mkdirSync(join(path, ".."), { recursive: true });
  const v1 = {
    version: 1, topic: "legacy-native", revision: 7, status: "active", goal: "legacy", activeTask: "A", updatedAt: at,
    tasks: [{ id: "A", title: "unfinished", status: "active", dependsOn: [], acceptance: [], approaches: [], approachReasons: {}, assessmentStatus: "assessed", verification: [{ command: "npm", args: ["test"] }], verificationCheckpoint: { revision: 7, at }, evidence: [{ command: "npm", args: ["test"], exitCode: 0, at, source: { kind: "bash-tool-result", toolCallId: "old", workflowRevision: 7 } }], evidenceLinks: [] }, { id: "B", title: "done", status: "complete", dependsOn: [], acceptance: [], approaches: [], approachReasons: {}, assessmentStatus: "assessed", verification: [], evidence: [], evidenceLinks: [], completedAt: at }],
  };
  writeFileSync(path, `${JSON.stringify(v1)}\n`);
  const before = readFileSync(path, "utf8");
  const loaded = loadWorkflow(cwd, "legacy-native")!;
  assert.equal(loaded.storedVersion, 1);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(loaded.workflow.tasks[0]!.evidence.length, 0);
  assert.equal(loaded.workflow.tasks[1]!.phase, "historical");

  const service = new WorkflowMutationService(cwd);
  await service.mutate("legacy-native", loaded.workflow.revision, (state) => reduceWorkflow(state, { type: "pause" }, "2026-02-01T00:00:02.000Z"));
  const upgraded = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.migration.sourceVersion, 1);
  assert.equal(existsSync(join(cwd, ".model-artifacts/system/logs/pi-swe-mutation.lock")), false);
});

test("canonical and legacy artifact layouts cannot silently shadow each other", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-layout-conflict-"));
  saveWorkflow(cwd, workflow());
  const legacy = join(cwd, ".model-artifacts/initiatives/schema-v2/specs");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "manifest.json"), "{}\n");
  assert.throws(() => loadWorkflow(cwd, "schema-v2"), /conflicting artifact layouts/);
});

test("linked plan drift blocks mutation until an explicit revision", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-plan-drift-"));
  saveFixture(cwd);
  writeFileSync(join(cwd, "plans/schema.md"), "# Plan\n\nChanged outside the contract.");
  const service = new WorkflowMutationService(cwd);
  await assert.rejects(() => service.mutate("schema-v2", 1, (state) => reduceWorkflow(state, { type: "pause" })), /linked plan content changed/);
});

test("concurrent services serialize mutations and reject the losing CAS", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-race-"));
  saveFixture(cwd);
  const first = new WorkflowMutationService(cwd);
  const second = new WorkflowMutationService(cwd);
  const results = await Promise.allSettled([
    first.mutate("schema-v2", 1, (state) => reduceWorkflow(state, { type: "pause" }, "2026-02-01T00:00:01.000Z")),
    second.mutate("schema-v2", 1, (state) => reduceWorkflow(state, { type: "pause" }, "2026-02-01T00:00:02.000Z")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /workflow changed/);
});

test("service uses CAS and fenced leases so stale child completion cannot advance state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-service-"));
  saveFixture(cwd);
  const service = new WorkflowMutationService(cwd);
  const first = await service.claimRun("schema-v2", 1, { ownerId: "parent-a", runId: "run-a", stage: "plan-review", ttlMs: 60_000, now: at });
  await assert.rejects(() => service.claimRun("schema-v2", 1, { ownerId: "parent-b", runId: "run-b", stage: "plan-review", ttlMs: 60_000, now: at }), /revision|lease/i);
  await service.cancelRun("schema-v2", first.workflow.revision, first.lease, "operator pause", "2026-02-01T00:00:01.000Z");
  const second = await service.claimRun("schema-v2", first.workflow.revision + 1, { ownerId: "parent-b", runId: "run-b", stage: "plan-review", ttlMs: 60_000, now: "2026-02-01T00:00:02.000Z" });
  await assert.rejects(() => service.settleRun("schema-v2", second.workflow.revision, first.lease, (state) => ({ workflow: state, changed: false, message: "stale" })), /stale.*lease|fence/i);
});
