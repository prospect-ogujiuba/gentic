import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BOOTSTRAP_ANCHOR_COMMIT, WorkflowMutationService, type BootstrapAdoptionRequest } from "../extensions/pi-swe/src/service.ts";
import { loadWorkflow, saveWorkflow, workflowPath } from "../extensions/pi-swe/src/store.ts";
import {
  assertPostCutoverRecoveryEligibility,
  createWorkflow,
  hashContract,
  POST_CUTOVER_CANONICAL_TASK_CONTRACTS,
  POST_CUTOVER_CANONICAL_WORKFLOW_CONTRACT,
  POST_CUTOVER_HISTORICAL_HEAD,
  POST_CUTOVER_HISTORICAL_PATHS,
  POST_CUTOVER_RETAINED_REPORT_COMMIT,
  postCutoverEvidenceHash,
  parseWorkflow,
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

function preparedReceipt(taskId = "T1", changedPaths: string[] = []) {
  return {
    version: 1 as const, workspaceId: "ws-1", root: "/repo", path: "/work/ws-1", taskId, topic: "schema-v2",
    baselineHash: "sha256:baseline", snapshotHash: "sha256:snapshot", changedPaths, createdAt: at,
    baselineCommit: "base", baselineRef: "refs/pi-swe/baselines/ws-1", worktreeGitDir: "/git/ws-1", ownershipToken: "owner",
    intentPath: "/intent/ws-1", workspaceHeadCommit: "base", preparedResultCommit: "result", preparedResultRef: "refs/pi-swe/results/ws-1",
    preparedPatchHash: "sha256:patch", realHead: "head", realIndexHash: "index", realIndexTree: "tree", stagedPatchHash: "staged",
    unstagedPatchHash: "unstaged", realSourceSnapshotHash: "sha256:baseline", includedUntracked: [], managedPaths: [],
    writeScope: ["extensions/pi-swe/**", "test/pi-swe*.test.ts"],
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
  current = reduceWorkflow(current, { type: "record-implementation", report: report("implementation", "implementer", "same-run", taskHash, "completed"), receipt: preparedReceipt() }, "2026-02-01T00:00:03.000Z").workflow;
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
  const noChangeReceipt = { ...preparedReceipt(), topic: "no-change", writeScope: ["src/**"] };
  current = reduceWorkflow(current, { type: "record-implementation", report: implementation, receipt: noChangeReceipt }, "2026-02-01T00:00:03.000Z").workflow;
  current = reduceWorkflow(current, { type: "record-review", report: report("general-review", "general-reviewer", "review", current.tasks[0]!.contract.hash) }, "2026-02-01T00:00:04.000Z").workflow;
  assert.equal(current.tasks[0]!.phase, "verification");
  current = reduceWorkflow(current, { type: "record-verification", evidence: {
    command: "npm", args: ["test"], exitCode: 0, at: "2026-02-01T00:00:04.500Z",
    contractHash: current.tasks[0]!.contract.hash, snapshotHash: noChangeReceipt.snapshotHash,
    source: { kind: "bash-tool-result", toolCallId: "no-change-check", workflowRevision: current.revision },
  } }, "2026-02-01T00:00:04.500Z").workflow;
  current = reduceWorkflow(current, { type: "complete-task" }, "2026-02-01T00:00:05.000Z").workflow;
  assert.equal(current.status, "paused");
  assert.equal(current.orchestration.phase, "initiative-acceptance");
  assert.throws(() => reduceWorkflow(current, { type: "complete-initiative", observedSnapshot: { hash: "sha256:missing", head: "missing", branch: "main", changedPaths: [], capturedAt: "2026-02-01T00:00:06.000Z" }, branchLength: 0 }), /closeout checkpoint|final acceptance/i);
  assert.equal(current.status, "paused");
});

test("authorized bootstrap adoption records ordered pre-start provenance without substituting final acceptance", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-bootstrap-"));
  const initial = createWorkflow({
    topic: "bootstrap-adoption", goal: "Adopt reviewed bootstrap", now: at,
    tasks: [
      { id: "foundation", title: "Foundation", writeScope: ["src/**"], nonGoals: ["No release"], approaches: ["security"], approachReasons: { security: "Authority boundary" }, verification: [{ command: "npm", args: ["test"] }] },
      { id: "qualification", title: "Qualification", dependsOn: ["foundation"], writeScope: ["test/**"], nonGoals: ["No release"], approaches: ["operations"], approachReasons: { operations: "Protected checks" }, verification: [{ command: "npm", args: ["run", "typecheck"] }] },
      { id: "cutover-readiness", title: "Native takeover", dependsOn: ["qualification"], writeScope: ["docs/**"], nonGoals: ["No activation"], approaches: [], verification: [{ command: "npm", args: ["run", "check"] }] },
    ],
  });
  saveWorkflow(cwd, initial);
  const snapshot = { hash: "sha256:bootstrap-snapshot", head: BOOTSTRAP_ANCHOR_COMMIT, branch: "master", changedPaths: ["src/a.ts", "test/a.test.ts"], capturedAt: "2026-02-01T00:00:01.000Z" };
  const reviewed = (kind: StageReport["kind"], role: RunnerProvenance["role"], runId: string): StageReport => ({
    kind, outcome: "approved", summary: `${kind} approved`, findings: [], changedPaths: snapshot.changedPaths,
    provenance: { ...provenance(role, runId, initial.contract.hash, snapshot.hash), actorId: `${role}:${runId}`, startedAt: "2026-02-01T00:00:02.000Z", completedAt: "2026-02-01T00:00:03.000Z" },
  });
  const source = { kind: "bash-tool-result" as const, toolName: "bash" as const, workflowRevision: initial.revision, ownerId: "owner", sessionId: "session", runtimeId: "runtime" };
  const evidence = (taskId: "foundation" | "qualification", command: string, args: string[]) => ({
    taskId, evidence: { command, args, exitCode: 0, at: "2026-02-01T00:00:04.000Z", contractHash: initial.tasks.find((task) => task.id === taskId)!.contract.hash, snapshotHash: snapshot.hash, beforeSnapshotHash: snapshot.hash, afterSnapshotHash: snapshot.hash, head: snapshot.head, branch: snapshot.branch, source: { ...source, toolCallId: `check-${taskId}` } },
  });
  const request: BootstrapAdoptionRequest = {
    planReview: reviewed("plan-review", "plan-reviewer", "plan"),
    generalReview: reviewed("general-review", "general-reviewer", "general"),
    concernReview: { concerns: ["operations", "security"], report: reviewed("concern-review", "concern-reviewer", "concern") },
    checks: [evidence("foundation", "npm", ["test"]), evidence("qualification", "npm", ["run", "typecheck"])], decisions: [],
    authorization: { id: "bootstrap-auth", authorizedBy: "operator", ownerId: "owner", sessionId: "session", runtimeId: "runtime", authorizedAt: "2026-02-01T00:00:05.000Z" },
  };
  const service = new WorkflowMutationService(cwd, { inspect: () => ({ anchorCommit: BOOTSTRAP_ANCHOR_COMMIT, descendantHead: snapshot.head, snapshot }) });
  const decision = await service.adoptBootstrap(initial.topic, initial.revision, request, "2026-02-01T00:00:06.000Z");
  assert.deepEqual(decision.workflow.tasks.map((task) => task.status), ["complete", "complete", "pending"]);
  assert.deepEqual(decision.workflow.bootstrapAdoption?.taskIds, ["foundation", "qualification"]);
  assert.equal(decision.workflow.tasks[0]!.reports.length, 0, "bootstrap must not fabricate ordinary child reports");
  assert.equal(decision.workflow.orchestration.phase, "task-execution");
  assert.equal(decision.workflow.initiativeAcceptance, undefined);
  assert.equal(loadWorkflow(cwd, initial.topic, false)?.workflow.bootstrapAdoption?.authorization.id, "bootstrap-auth");
  assert.match(decision.message, /native start/i);
  assert.throws(() => reduceWorkflow(decision.workflow, { type: "adopt-bootstrap", adoption: { ...request, anchorCommit: BOOTSTRAP_ANCHOR_COMMIT, descendantHead: snapshot.head, snapshot, taskIds: ["foundation", "qualification"] } }, "2026-02-01T00:00:07.000Z"), /before.*started/i);

  const fresh = createWorkflow({ topic: "bad-order", goal: "x", now: at, tasks: [
    { id: "foundation", title: "Foundation", writeScope: ["src/**"], nonGoals: ["No release"], approaches: ["security"], approachReasons: { security: "Authority boundary" }, verification: [{ command: "npm", args: ["test"] }] },
    { id: "qualification", title: "Qualification", dependsOn: ["foundation"], writeScope: ["test/**"], nonGoals: ["No release"], approaches: ["operations"], approachReasons: { operations: "Protected checks" }, verification: [{ command: "npm", args: ["run", "typecheck"] }] },
    { id: "cutover-readiness", title: "Native takeover", dependsOn: ["qualification"], writeScope: ["docs/**"], nonGoals: ["No activation"], approaches: [], verification: [{ command: "npm", args: ["run", "check"] }] },
  ] });
  assert.throws(() => reduceWorkflow(fresh, { type: "adopt-bootstrap", adoption: { ...request, planReview: { ...request.planReview, provenance: { ...request.planReview.provenance, contractHash: fresh.contract.hash } }, generalReview: { ...request.generalReview, provenance: { ...request.generalReview.provenance, contractHash: fresh.contract.hash } }, concernReview: { concerns: ["operations", "security"], report: { ...request.concernReview!.report, provenance: { ...request.concernReview!.report.provenance, contractHash: fresh.contract.hash } } }, anchorCommit: BOOTSTRAP_ANCHOR_COMMIT, descendantHead: snapshot.head, snapshot, taskIds: ["qualification", "foundation"] } }, "2026-02-01T00:00:06.000Z"), /ordered workflow prefix/i);
});

test("post-cutover adoption atomically retains failed review history and completes only the exact prior prefix", () => {
  const ids = [
    "migration-inventory", "migration-policy", "migration-apply", "migration-surfaces", "migration-qualification",
    "runtime-composition", "runtime-registration", "orchestration-driver", "contextual-operator-ux", "activation-recovery",
    "activation-qualification", "cutover-readiness", "cutover-rehearsal", "repository-migration", "default-v2-runtime",
    "retire-v1-execution", "cutover-release-qualification",
  ];
  let value = createWorkflow({
    topic: "swe-production-rollout", goal: "repair authority", now: at,
    tasks: ids.map((id, index) => ({ id, title: id, dependsOn: index ? [ids[index - 1]!] : [], writeScope: ["src/**"], nonGoals: ["no release"], approaches: [], verification: [{ command: "node", args: ["--version"] }] })),
  });
  value = { ...value, revision: 42, contract: { ...POST_CUTOVER_CANONICAL_WORKFLOW_CONTRACT }, status: "paused", tasks: value.tasks.map((task, index) => ({ ...task, contract: { revision: POST_CUTOVER_CANONICAL_TASK_CONTRACTS[index]![1], hash: POST_CUTOVER_CANONICAL_TASK_CONTRACTS[index]![2] } })), orchestration: { ...value.orchestration, mode: "multi-agent", phase: "plan-review", parent: { ownerId: "owner", sessionId: "session", runtimeId: "11111111-1111-4111-8111-111111111111", cwd: "/repo", claimedAt: "2026-02-01T00:00:01.000Z", valid: true }, history: [{ id: "run-19-failed", type: "run-failed", at: "2026-02-01T00:00:02.000Z", summary: "output-limit: agent run exceeded its output budget", auditCritical: true }, { id: "runtime-parent-42-rotated", type: "runtime-parent-rotated", at: "2026-02-01T00:00:02.500Z", summary: "v2 generation 9; parent 11111111-1111-4111-8111-111111111111", auditCritical: true }] } };
  const failed = value.orchestration.history[0]!;
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility({ ...value, revision: 41, status: "blocked", orchestration: { ...value.orchestration, history: [failed] } }));
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(value));
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...value, orchestration: { ...value.orchestration, parent: { ...value.orchestration.parent!, valid: false } } }), /valid current parent authority/i);
  const runtime10 = "22222222-2222-4222-8222-222222222222";
  const rev43 = { ...value, revision: 43, orchestration: { ...value.orchestration, parent: { ...value.orchestration.parent!, runtimeId: runtime10 }, history: [...value.orchestration.history, { id: "runtime-parent-43-rotated", type: "runtime-parent-rotated" as const, at: "2026-02-01T00:00:02.750Z", summary: `v2 generation 10; parent ${runtime10}`, auditCritical: true }] } };
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(rev43));
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...rev43, orchestration: { ...rev43.orchestration, history: [...rev43.orchestration.history.slice(0, -1), { ...rev43.orchestration.history.at(-1)!, type: "operator-note" }] } }), /post-cutover recovery/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...rev43, orchestration: { ...rev43.orchestration, history: rev43.orchestration.history.map((entry, index) => index === 2 ? { ...entry, summary: "v2 generation 10; parent mismatch" } : entry) } }), /post-cutover recovery/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...value, tasks: value.tasks.map((task, index) => index ? task : { ...task, blockedReason: "residue" }) }), /non-pristine task state/i);
  const rotations = (length: number) => Array.from({ length }, (_, index) => ({ id: `runtime-parent-${42 + index}-rotated`, type: "runtime-parent-rotated" as const, at: `2026-02-01T00:00:${String(3 + index).padStart(2, "0")}.000Z`, summary: `v2 generation ${9 + index}; parent ${runtime10}`, auditCritical: true }));
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility({ ...value, revision: 53, orchestration: { ...value.orchestration, parent: { ...value.orchestration.parent!, runtimeId: runtime10 }, history: [failed, ...rotations(12)] } }));
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...value, revision: 54, orchestration: { ...value.orchestration, parent: { ...value.orchestration.parent!, runtimeId: runtime10 }, history: [failed, ...rotations(13)] } }), /post-cutover recovery/i, "a thirteenth audited rotation must remain ineligible");

  const fenced = reduceWorkflow(value, { type: "fence-parent", ownerId: "owner", sessionId: "session", runtimeId: "11111111-1111-4111-8111-111111111111", reason: "session quit" }, "2026-02-01T00:00:02.750Z").workflow;
  assert.equal(fenced.orchestration.history.at(-1)!.id, "runtime-parent-43-invalidated");
  assert.equal(fenced.orchestration.history.at(-1)!.type, "runtime-parent-invalidated");
  assert.equal(fenced.orchestration.history.at(-1)!.auditCritical, true);

  const runtime11 = "33333333-3333-4333-8333-333333333333"; const runtime12 = "44444444-4444-4444-8444-444444444444"; const runtime13 = "55555555-5555-4555-8555-555555555555";
  const identity = { ownerId: "owner", sessionId: "session", cwd: "/repo", sessionFile: "/sessions/session.jsonl" };
  const parent11 = { ...identity, runtimeId: runtime11, claimedAt: "2026-02-01T00:00:03.000Z", valid: false as const, invalidatedAt: "2026-02-01T00:00:04.000Z", invalidatedReason: "session quit" };
  const parent12 = { ...identity, runtimeId: runtime12, claimedAt: "2026-02-01T00:00:05.000Z", valid: false as const, invalidatedAt: "2026-02-01T00:00:06.000Z", invalidatedReason: "session quit" };
  const legacy = { ...value, revision: 47, orchestration: { ...value.orchestration, parent: parent12, history: [...rev43.orchestration.history, { id: "runtime-parent-44-rotated", type: "runtime-parent-rotated", at: "2026-02-01T00:00:03.000Z", summary: `v2 generation 11; parent ${runtime11}`, auditCritical: true }, { id: "runtime-parent-46-rotated", type: "runtime-parent-rotated", at: "2026-02-01T00:00:05.000Z", summary: `v2 generation 12; parent ${runtime12}`, auditCritical: true }], runtimeHandoff: { id: "handoff-12", decisionId: "decision-12", from: "v2" as const, to: "v2" as const, phase: "reclaimed" as const, selectorGeneration: 12, preparedAt: "2026-02-01T00:00:05.000Z", reclaimedAt: "2026-02-01T00:00:05.000Z", previousParent: parent11 } } };
  const rotationEvent = { type: "rotate-runtime-parent" as const, handoffId: "handoff-13", decisionId: "decision-12", from: "v2" as const, to: "v2" as const, selectorGeneration: 13, authority: { ...identity, runtimeId: runtime13, claimedAt: "2026-02-01T00:00:07.000Z", valid: true as const } };
  const reconciled = reduceWorkflow(legacy, rotationEvent, "2026-02-01T00:00:07.000Z").workflow;
  assert.equal(reconciled.revision, 48);
  assert.deepEqual(reconciled.orchestration.history.slice(-3).map((entry) => entry.id), ["runtime-parent-45-invalidation-reconciled", "runtime-parent-47-invalidation-reconciled", "runtime-parent-48-rotated"]);
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(reconciled));
  assert.deepEqual(reconciled.orchestration.runtimeHandoff?.invalidationProofs?.map((proof) => [proof.revision, proof.before.revision, proof.after.revision]), [[45, 44, 46], [47, 46, 48]]);
  const proofs = reconciled.orchestration.runtimeHandoff!.invalidationProofs!;
  const rotatedAgain = reduceWorkflow(reconciled, { ...rotationEvent, handoffId: "handoff-14", selectorGeneration: 14, authority: { ...rotationEvent.authority, runtimeId: "66666666-6666-4666-8666-666666666666", claimedAt: "2026-02-01T00:00:08.000Z" } }, "2026-02-01T00:00:08.000Z").workflow;
  assert.deepEqual(rotatedAgain.orchestration.runtimeHandoff?.invalidationProofs, proofs, "bounded reconciliation proofs survive later handoff overwrite");
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(rotatedAgain));
  let extended = rotatedAgain;
  for (let revision = 50; revision <= 54; revision++) {
    const generation = extended.orchestration.runtimeHandoff!.selectorGeneration + 1;
    const runtimeId = `77777777-7777-4777-8777-${String(revision).padStart(12, "0")}`;
    const timestamp = `2026-02-01T00:00:${String(revision - 41).padStart(2, "0")}.000Z`;
    extended = reduceWorkflow(extended, { ...rotationEvent, handoffId: `handoff-${generation}`, selectorGeneration: generation, authority: { ...rotationEvent.authority, runtimeId, claimedAt: timestamp } }, timestamp).workflow;
    if (revision >= 51) assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(extended), `audited revision ${revision} rotation must remain eligible within the twelve-rotation bound`);
  }
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...rotatedAgain, orchestration: { ...rotatedAgain.orchestration, runtimeHandoff: { ...rotatedAgain.orchestration.runtimeHandoff!, previousParent: { ...rotatedAgain.orchestration.runtimeHandoff!.previousParent!, runtimeId: runtime12 } } } }), /post-cutover recovery/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...reconciled, orchestration: { ...reconciled.orchestration, runtimeHandoff: { ...reconciled.orchestration.runtimeHandoff!, invalidationProofs: [] } } }), /post-cutover recovery/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...reconciled, orchestration: { ...reconciled.orchestration, runtimeHandoff: { ...reconciled.orchestration.runtimeHandoff!, invalidationProofs: [{ ...proofs[0]!, proofHash: "sha256:" + "0".repeat(64) }, proofs[1]!] } } }), /post-cutover recovery/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...reconciled, orchestration: { ...reconciled.orchestration, runtimeHandoff: { ...reconciled.orchestration.runtimeHandoff!, invalidationProofs: [proofs[0]!, proofs[0]!] } } }), /post-cutover recovery/i);
  const forgedParent = { ...proofs[0]!.parent, ownerId: "other-owner" }; const forgedBody = { revision: proofs[0]!.revision, parent: forgedParent, before: proofs[0]!.before, after: proofs[0]!.after }; const forgedProof = { ...forgedBody, proofHash: hashContract(forgedBody) };
  const forgedHistory = reconciled.orchestration.history.map((entry) => entry.id === "runtime-parent-45-invalidation-reconciled" ? { ...entry, summary: `parent ${forgedParent.runtimeId}; invalidated ${forgedParent.invalidatedAt}; reason ${forgedParent.invalidatedReason}; proof ${hashContract(forgedParent)}` } : entry);
  assert.throws(() => assertPostCutoverRecoveryEligibility({ ...reconciled, orchestration: { ...reconciled.orchestration, history: forgedHistory, runtimeHandoff: { ...reconciled.orchestration.runtimeHandoff!, invalidationProofs: [forgedProof, proofs[1]!] } } }), /post-cutover recovery/i);
  const unknownProofField = JSON.parse(JSON.stringify(reconciled)); unknownProofField.orchestration.runtimeHandoff.invalidationProofs[0].unexpected = true;
  assert.throws(() => parseWorkflow(unknownProofField), /retained proof/i);
  assert.equal(legacy.orchestration.history.some((entry) => entry.type.includes("reconciled")), false, "reconciliation must not partially mutate its input");
  const reconciled47 = reconciled.orchestration.history.find((entry) => entry.id === "runtime-parent-47-invalidation-reconciled")!;
  const forged47 = (patch: Record<string, unknown>) => ({ ...legacy, orchestration: { ...legacy.orchestration, history: [...legacy.orchestration.history, { ...reconciled47, id: "runtime-parent-47-invalidated", type: "runtime-parent-invalidated", at: parent12.invalidatedAt, ...patch }] } });
  const nativelyAudited = reduceWorkflow(forged47({}) as never, rotationEvent, "2026-02-01T00:00:07.000Z").workflow;
  assert.equal(nativelyAudited.orchestration.history.some((entry) => entry.id === "runtime-parent-47-invalidation-reconciled"), false);
  assert.doesNotThrow(() => assertPostCutoverRecoveryEligibility(nativelyAudited));
  for (const invalid of [
    { ...legacy, orchestration: { ...legacy.orchestration, parent: { ...parent12, invalidatedReason: "arbitrary" } } },
    { ...legacy, orchestration: { ...legacy.orchestration, parent: { ...parent12, invalidatedAt: "2026-02-01T00:00:08.000Z" } } },
    { ...legacy, orchestration: { ...legacy.orchestration, runtimeHandoff: { ...legacy.orchestration.runtimeHandoff!, previousParent: { ...parent11, runtimeId: runtime12 } } } },
    { ...legacy, orchestration: { ...legacy.orchestration, runtimeHandoff: { ...legacy.orchestration.runtimeHandoff!, previousParent: { ...parent11, sessionFile: "/sessions/other.jsonl" } } } },
    { ...legacy, orchestration: { ...legacy.orchestration, runtimeHandoff: { ...legacy.orchestration.runtimeHandoff!, previousParent: { ...parent11, claimedAt: "2026-02-01T00:00:02.500Z" } } } },
    { ...legacy, orchestration: { ...legacy.orchestration, runtimeHandoff: { ...legacy.orchestration.runtimeHandoff!, previousParent: { ...parent11, invalidatedAt: "2026-02-01T00:00:05.500Z" } } } },
    { ...legacy, orchestration: { ...legacy.orchestration, parent: { ...parent12, claimedAt: "2026-02-01T00:00:04.500Z" } } },
    { ...legacy, orchestration: { ...legacy.orchestration, history: [...legacy.orchestration.history, { id: "runtime-parent-45-invalidation-reconciled", type: "runtime-parent-invalidation-reconciled", at: "2026-02-01T00:00:06.500Z", summary: "duplicate", auditCritical: true }] } },
    forged47({ auditCritical: undefined }),
    forged47({ type: "operator-note" }),
    forged47({ at: "2026-02-01T00:00:06.500Z" }),
    forged47({ summary: reconciled47.summary.replace(/.$/, "0") }),
  ]) assert.throws(() => reduceWorkflow(invalid as never, rotationEvent, "2026-02-01T00:00:07.000Z"), /invalidation|adjacent rotations|audit|proof/i);
  assert.throws(() => reduceWorkflow(legacy, { ...rotationEvent, authority: { ...rotationEvent.authority, sessionFile: "/sessions/other.jsonl" } }, "2026-02-01T00:00:07.000Z"), /session file/i);
  assert.throws(() => assertPostCutoverRecoveryEligibility(legacy), /post-cutover recovery/i, "an unexplained revision gap must remain ineligible before reconciliation");
  const snapshot = { hash: `sha256:${"f".repeat(64)}`, head: "a".repeat(40), branch: "master", changedPaths: [...POST_CUTOVER_HISTORICAL_PATHS], capturedAt: "2026-02-01T00:00:03.000Z" };
  const reviewed = (kind: StageReport["kind"], role: RunnerProvenance["role"], runId: string): StageReport => ({ kind, outcome: "approved", summary: `${kind} approved`, findings: [], changedPaths: snapshot.changedPaths, provenance: { ...provenance(role, runId, value.contract.hash, snapshot.hash), actorId: `${role}:${runId}`, startedAt: "2026-02-01T00:00:04.000Z", completedAt: "2026-02-01T00:00:05.000Z" } });
  const adoption = {
    anchorCommit: "e882cd62deb541aa437c16c72781a1ccd243055e", historicalHead: POST_CUTOVER_HISTORICAL_HEAD, historicalTree: "1".repeat(40), historicalChangedPaths: snapshot.changedPaths, repairBase: POST_CUTOVER_HISTORICAL_HEAD, repairChangedPaths: [], descendantHead: snapshot.head, candidateTree: "b".repeat(40), snapshot,
    authorityRevision: value.revision, authorityHistoryHash: hashContract(value.orchestration.history), authorityCwd: "/repo",
    taskIds: ids.slice(0, 16), taskContracts: value.tasks.slice(0, 16).map((task) => ({ taskId: task.id, ...task.contract })),
    planReview: reviewed("plan-review", "plan-reviewer", "plan"), generalReview: reviewed("general-review", "general-reviewer", "general"),
    concernReview: undefined, checks: value.tasks.slice(0, 16).map((task, index) => ({ taskId: task.id, command: "node", args: ["--version"], exitCode: 0, contractHash: task.contract.hash, snapshotHash: snapshot.hash, beforeTree: "b".repeat(40), afterTree: "b".repeat(40), outputHash: `sha256:${String(index).padStart(64, "0")}`, startedAt: "2026-02-01T00:00:06.000Z", completedAt: "2026-02-01T00:00:07.000Z", authorizationId: `check-${index}`, executor: "post-cutover-protected-executor" as const, ownerId: "owner", sessionId: "session", runtimeId: "11111111-1111-4111-8111-111111111111" })),
    retainedEvidence: [{ path: ".model-artifacts/initiatives/swe-production-rollout/reports/post.md", sha256: `sha256:${"c".repeat(64)}`, commit: POST_CUTOVER_RETAINED_REPORT_COMMIT }], decisions: [],
    authorization: { id: "post-cutover-auth", authorizedBy: "project-owner", ownerId: "owner", sessionId: "session", runtimeId: "11111111-1111-4111-8111-111111111111", authorizedAt: "2026-02-01T00:00:08.000Z", evidenceHash: `sha256:${"e".repeat(64)}`, rationale: "Adopt independently reviewed completed rollout work without fabricating ordinary task reports." },
  };
  adoption.authorization.evidenceHash = postCutoverEvidenceHash(adoption as never);
  assert.equal(postCutoverEvidenceHash({ ...adoption, authorization: { ...adoption.authorization, authorizedAt: "2286-11-20T07:17:52.000Z" } } as never), adoption.authorization.evidenceHash, "evidence hash must be stable and non-circular across authorization entry");
  assert.notEqual(postCutoverEvidenceHash({ ...adoption, decisions: [{ findingId: "new", disposition: "explicit", decidedBy: "operator", at: "2026-02-01T00:00:07.500Z" }] } as never), adoption.authorization.evidenceHash, "evidence hash must bind finding dispositions");
  assert.throws(() => reduceWorkflow(rev43, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:09.000Z"), /authority revision, history, or cwd changed/i);
  const decision = reduceWorkflow(value, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:09.000Z");
  assert.deepEqual(decision.workflow.tasks.map((task) => task.status), [...Array(16).fill("complete"), "pending"]);
  assert.equal(decision.workflow.tasks[16]!.id, "cutover-release-qualification");
  assert.equal(decision.workflow.tasks.slice(0, 16).every((task) => task.reports.length === 0), true);
  assert.equal(decision.workflow.orchestration.history[0]!.id, "run-19-failed");
  assert.equal(decision.workflow.orchestration.history[1]!.type, "runtime-parent-rotated");
  assert.equal(decision.workflow.orchestration.history.at(-1)!.type, "post-cutover-adoption");
  assert.equal(decision.workflow.status, "draft");

  assert.equal(value.tasks.every((task) => task.status === "pending"), true, "failed or successful adoption must not partially mutate its input");
  assert.throws(() => reduceWorkflow(decision.workflow, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:10.000Z"), /pristine blocked or same-session-reclaimed plan-review recovery state|already/i);
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: { ...adoption, taskIds: [...adoption.taskIds].reverse() } } as never, "2026-02-01T00:00:09.000Z"), /exact ordered tasks 1-16 prefix/i);
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: { ...adoption, generalReview: { ...adoption.generalReview, provenance: { ...adoption.generalReview.provenance, runId: adoption.planReview.provenance.runId, actorId: adoption.planReview.provenance.actorId } } } } as never, "2026-02-01T00:00:09.000Z"), /distinct fresh run and actor provenance/i);
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: { ...adoption, checks: adoption.checks.slice(1) } } as never, "2026-02-01T00:00:09.000Z"), /one fresh receipt for every exact verification command/i);
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: { ...adoption, authorization: { ...adoption.authorization, evidenceHash: `sha256:${"0".repeat(64)}` } } } as never, "2026-02-01T00:00:09.000Z"), /evidence hash does not match the exact reviewed bundle/i);
  assert.throws(() => reduceWorkflow({ ...value, contract: { ...value.contract, hash: `sha256:${"0".repeat(64)}` } }, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:09.000Z"), /canonical rev41 contract/i);
  assert.throws(() => reduceWorkflow({ ...value, tasks: value.tasks.map((task, index) => index ? task : { ...task, remediation: { ...task.remediation, used: 1 }, verificationDriftPaths: ["src/drift.ts"] }) }, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:09.000Z"), /execution residue/i);
  assert.throws(() => reduceWorkflow({ ...value, orchestration: { ...value.orchestration, history: [{ ...value.orchestration.history[0]!, summary: "model: generic child failure" }] } }, { type: "adopt-post-cutover", adoption } as never, "2026-02-01T00:00:09.000Z"), /exact preserved rev41 output-limit/i);
  const acceptedRisk = { ...adoption, generalReview: { ...adoption.generalReview, findings: [{ id: "risk-1", severity: "blocking" as const, status: "accepted-risk" as const, summary: "risk", evidence: "review" }] } };
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: acceptedRisk } as never, "2026-02-01T00:00:09.000Z"), /cannot accept risk/i);
  const replayedChecks = adoption.checks.map((check, index) => index === 1 ? { ...check, authorizationId: adoption.checks[0]!.authorizationId } : check);
  assert.throws(() => reduceWorkflow(value, { type: "adopt-post-cutover", adoption: { ...adoption, checks: replayedChecks } } as never, "2026-02-01T00:00:09.000Z"), /unprotected, replayed/i);
});

test("post-cutover service rechecks candidate identity under the mutation lock without partial persistence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-cas-"));
  const value = createWorkflow({ topic: "post-cutover-cas", goal: "verify atomic candidate recheck", now: at, tasks: [{ id: "T1", title: "noop", writeScope: ["src/**"], nonGoals: ["no mutation"], verification: [{ command: "node", args: ["--version"] }] }] });
  saveWorkflow(cwd, value);
  const before = readFileSync(join(cwd, workflowPath(value.topic)), "utf8");
  const prepared = { anchorCommit: "a".repeat(40), descendantHead: "b".repeat(40), candidateTree: "c".repeat(40), snapshot: { hash: `sha256:${"d".repeat(64)}`, head: "b".repeat(40), branch: "master", changedPaths: [], capturedAt: at } };
  let inspections = 0;
  const inspector = { inspect: () => (++inspections === 1 ? prepared : { ...prepared, candidateTree: "e".repeat(40), snapshot: { ...prepared.snapshot, capturedAt: "2026-02-01T00:00:02.000Z" } }) };
  const service = new WorkflowMutationService(cwd, { inspect: () => { throw new Error("unused"); } }, inspector);
  const inspected = service.inspectPostCutoverCandidate();
  await assert.rejects(service.adoptPostCutover(value.topic, value.revision, inspected as never, "2026-02-01T00:00:09.000Z"), /candidate source changed after evidence preparation/i);
  assert.equal(readFileSync(join(cwd, workflowPath(value.topic)), "utf8"), before);
});

test("bootstrap service refuses descendant paths outside the adopted task scope", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-bootstrap-drift-"));
  const value = createWorkflow({ topic: "bootstrap-drift", goal: "x", now: at, tasks: [
    { id: "foundation", title: "Foundation", writeScope: ["src/**"], nonGoals: ["No release"], approaches: [], verification: [{ command: "npm", args: ["test"] }] },
    { id: "cutover-readiness", title: "Take over", dependsOn: ["foundation"], writeScope: ["docs/**"], nonGoals: ["No activation"], approaches: [], verification: [{ command: "npm", args: ["run", "check"] }] },
  ] });
  saveWorkflow(cwd, value);
  const snapshot = { hash: "sha256:drift", head: BOOTSTRAP_ANCHOR_COMMIT, branch: "master", changedPaths: ["unrelated/file.ts"], capturedAt: "2026-02-01T00:00:01.000Z" };
  const service = new WorkflowMutationService(cwd, { inspect: () => ({ anchorCommit: BOOTSTRAP_ANCHOR_COMMIT, descendantHead: snapshot.head, snapshot }) });
  await assert.rejects(service.adoptBootstrap(value.topic, value.revision, {} as BootstrapAdoptionRequest, "2026-02-01T00:00:06.000Z"), /outside adopted task scope/i);
});

test("v1 reads are non-mutating and implicit service mutation fails closed pending explicit migration", async () => {
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
  await assert.rejects(
    () => service.mutate("legacy-native", loaded.workflow.revision, (state) => reduceWorkflow(state, { type: "pause" }, "2026-02-01T00:00:02.000Z")),
    /requires explicit migration/,
  );
  assert.equal(readFileSync(path, "utf8"), before);
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
