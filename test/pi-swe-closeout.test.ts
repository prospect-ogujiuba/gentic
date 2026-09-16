import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InitiativeCloseoutAuthority, type InitiativeCloseoutInspector } from "../extensions/pi-swe/src/closeout.ts";
import { OrchestrationEngine, type OrchestrationRunner } from "../extensions/pi-swe/src/orchestration.ts";
import type { AgentRunRequest, RunnerResult } from "../extensions/pi-swe/src/runner.ts";
import { saveWorkflow } from "../extensions/pi-swe/src/store.ts";
import { createWorkflow, hashContract, parseWorkflow, reduceWorkflow, reviseWorkflow, type RepositorySnapshot, type StageReport, type VerificationEvidence, type Workflow } from "../extensions/pi-swe/src/workflow.ts";

const ROOT = "/repo";
const AT = "2026-04-01T00:00:00.000Z";
const check = { command: "node", args: ["--test", "test/integration.test.ts"] };
const snapshot = (hash = "sha256:repository", head = "head-1", branch: string | null = "main"): RepositorySnapshot => ({ hash, head, branch, changedPaths: ["src/a.ts", "test/a.test.ts"], capturedAt: AT });
const parent = { ownerId: "parent", sessionId: "session", runtimeId: "runtime", cwd: ROOT, sessionBranchId: "branch-leaf", branchLength: 12, branchToolCallIds: ["bash-1", "bash-2"] };

function terminalWorkflow(): Workflow {
  const base = createWorkflow({
    topic: "closeout-test", goal: "Deliver integrated behavior", plan: "Implement, independently review, integrate, and verify.", now: AT,
    initiativeVerification: [check],
    tasks: [{ id: "T1", title: "implement", acceptance: ["works across boundaries"], approaches: ["tdd"], approachReasons: { tdd: "integration behavior is deterministic" }, assessmentStatus: "assessed", writeScope: ["src/**", "test/**"], nonGoals: ["release"], verification: [check] }],
  });
  const planReview: StageReport = { kind: "plan-review", outcome: "approved", summary: "plan approved", findings: [], provenance: { runId: "plan-1", role: "plan-reviewer", actorId: "plan-reviewer:plan-1", leaseId: "lease-plan", leaseFence: 1, contractHash: base.contract.hash, startedAt: AT, completedAt: "2026-04-01T00:00:00.250Z" } };
  return parseWorkflow({
    ...base, revision: 7, status: "paused", planReview, tasks: base.tasks.map((task) => ({ ...task, status: "complete", phase: "historical", completedAt: "2026-04-01T00:00:00.500Z" })),
    orchestration: { ...base.orchestration, phase: "initiative-acceptance", parent: { ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, cwd: ROOT, claimedAt: AT, valid: true } },
  });
}

function begun(unresolvedRisks: string[] = []): Workflow {
  return reduceWorkflow(terminalWorkflow(), { type: "begin-initiative-closeout", snapshot: snapshot(), cumulativeDeltaHash: hashContract("delta"), unresolvedRisks, branchLength: parent.branchLength }, "2026-04-01T00:00:01.000Z").workflow;
}

function evidence(workflow: Workflow, exitCode = 0, overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    ...check, exitCode, at: "2026-04-01T00:00:02.000Z", contractHash: workflow.contract.hash,
    snapshotHash: snapshot().hash, beforeSnapshotHash: snapshot().hash, afterSnapshotHash: snapshot().hash,
    cwd: ROOT, head: snapshot().head, branch: snapshot().branch,
    source: { kind: "bash-tool-result", toolName: "bash", toolCallId: "bash-1", workflowRevision: workflow.closeout!.checkpoint.revision, ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, sessionBranchId: parent.sessionBranchId, branchLength: parent.branchLength },
    ...overrides,
  };
}

function verified(): Workflow {
  const workflow = begun();
  return reduceWorkflow(workflow, { type: "record-initiative-verification", evidence: evidence(workflow), observedSnapshot: snapshot() }, "2026-04-01T00:00:03.000Z").workflow;
}

function acceptance(workflow: Workflow, outcome: StageReport["outcome"] = "approved", actorId = "final-reviewer:final-1"): StageReport {
  return { kind: "final-acceptance", outcome, summary: "initiative-wide result", ...(outcome === "needs-input" ? { rationale: "user must validate the visual behavior" } : {}), findings: [], provenance: { runId: "final-1", role: "final-reviewer", actorId, leaseId: "lease-final", leaseFence: 3, contractHash: workflow.contract.hash, snapshotHash: workflow.closeout!.snapshot.hash, startedAt: "2026-04-01T00:00:04.000Z", completedAt: "2026-04-01T00:00:05.000Z" } };
}

function approved(): Workflow {
  const workflow = verified();
  return reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: acceptance(workflow) }, "2026-04-01T00:00:06.000Z").workflow;
}

test("terminal tasks enter orchestrator-owned final acceptance and cannot directly complete the workflow", () => {
  const workflow = terminalWorkflow();
  assert.equal(workflow.status, "paused");
  assert.equal(workflow.orchestration.phase, "initiative-acceptance");
  assert.throws(() => reduceWorkflow(workflow, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 }), /checkpoint|verification|acceptance/i);
});

test("initiative integration checks are plan-contract inputs and cannot be replaced by task-local evidence", () => {
  const workflow = terminalWorkflow();
  const revised = reviseWorkflow(workflow, { initiativeVerification: [{ command: "npm", args: ["test"] }], tasks: workflow.tasks.map(({ id, title, kind, dependsOn, acceptance, approaches, approachReasons, writeScope, nonGoals, verification, verificationDecision }) => ({ id, title, kind, dependsOn, acceptance, approaches, approachReasons, writeScope, nonGoals, verification, ...(verificationDecision ? { verificationDecision } : {}) })) }, "2026-04-01T00:00:01.000Z").workflow;
  assert.notEqual(revised.contract.hash, workflow.contract.hash);
  assert.equal(revised.orchestration.phase, "plan-review");
  const closeout = begun();
  assert.throws(() => reduceWorkflow(closeout, { type: "record-initiative-verification", evidence: { ...evidence(closeout), command: "npm", args: ["run", "typecheck"] }, observedSnapshot: snapshot() }), /exact planned integration check/i);
  assert.throws(() => reduceWorkflow(closeout, { type: "record-initiative-verification", evidence: { ...evidence(closeout), source: undefined }, observedSnapshot: snapshot() }), /protected-bash/i);
  const collision = createWorkflow({ topic: "exact-command", goal: "exact", initiativeVerification: [{ command: "node", args: ["a b"] }], tasks: [{ id: "T", title: "t", writeScope: ["src/**"], nonGoals: ["none"], approaches: [], verification: [check] }] });
  const collisionTerminal = parseWorkflow({ ...collision, status: "paused", planReview: { ...terminalWorkflow().planReview, provenance: { ...terminalWorkflow().planReview!.provenance, contractHash: collision.contract.hash } }, tasks: collision.tasks.map((task) => ({ ...task, status: "complete", phase: "historical" })), orchestration: { ...collision.orchestration, phase: "initiative-acceptance", parent: terminalWorkflow().orchestration.parent } });
  const collisionCloseout = reduceWorkflow(collisionTerminal, { type: "begin-initiative-closeout", snapshot: snapshot(), cumulativeDeltaHash: hashContract("delta"), unresolvedRisks: [], branchLength: 12 }).workflow;
  assert.throws(() => reduceWorkflow(collisionCloseout, { type: "record-initiative-verification", evidence: { ...evidence(collisionCloseout), command: "node a", args: ["b"] }, observedSnapshot: snapshot() }), /exact planned/i);
});

test("final verification rejects stale contract, snapshot, branch, ownership, and newer failures", () => {
  const workflow = begun();
  for (const stale of [
    evidence(workflow, 0, { contractHash: hashContract("stale") }),
    evidence(workflow, 0, { afterSnapshotHash: "sha256:changed" }),
    evidence(workflow, 0, { branch: "other" }),
    evidence(workflow, 0, { source: { ...evidence(workflow).source!, ownerId: "other" } }),
  ]) assert.throws(() => reduceWorkflow(workflow, { type: "record-initiative-verification", evidence: stale, observedSnapshot: snapshot() }), /stale|protected-bash/i);
  const passed = reduceWorkflow(workflow, { type: "record-initiative-verification", evidence: evidence(workflow), observedSnapshot: snapshot() }, "2026-04-01T00:00:03.000Z").workflow;
  const failed = reduceWorkflow(passed, { type: "record-initiative-verification", evidence: evidence(passed, 1, { at: "2026-04-01T00:00:04.000Z" }), observedSnapshot: snapshot() }, "2026-04-01T00:00:05.000Z").workflow;
  assert.equal(failed.status, "blocked");
  assert.throws(() => reduceWorkflow(failed, { type: "record-initiative-acceptance", report: acceptance(failed) }), /missing current passing/i);
});

test("final acceptance supports approve, changes-requested, and explicit manual validation without substitution", () => {
  const workflow = verified();
  const accepted = reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: acceptance(workflow) }).workflow;
  assert.equal(accepted.initiativeAcceptance?.outcome, "approved");
  const reviewerAcceptedRisk = acceptance(workflow);
  reviewerAcceptedRisk.findings = [{ id: "risk", severity: "blocking", status: "accepted-risk", summary: "unsafe", evidence: "review", disposition: "reviewer accepts" }];
  assert.throws(() => reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: reviewerAcceptedRisk }), /cannot accept risk/i);
  const inconsistentApproval = acceptance(workflow);
  inconsistentApproval.findings = [{ id: "block", severity: "blocking", status: "open", summary: "missing behavior", evidence: "review" }];
  assert.throws(() => reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: inconsistentApproval }), /cannot approve/i);

  const changed = reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: acceptance(workflow, "changes-requested") }).workflow;
  assert.equal(changed.status, "blocked");
  assert.throws(() => reduceWorkflow(changed, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 }), /acceptance/i);

  const manual = reduceWorkflow(workflow, { type: "record-initiative-acceptance", report: acceptance(workflow, "needs-input") }, "2026-04-01T00:00:06.000Z").workflow;
  assert.equal(manual.closeout?.manualValidation?.status, "required");
  const userApproved = reduceWorkflow(manual, { type: "record-manual-validation", outcome: { status: "approved", rationale: "validated on target hardware", decidedBy: "user", at: "2026-04-01T00:00:07.000Z" } }).workflow;
  assert.equal(userApproved.initiativeAcceptance, undefined);
  assert.throws(() => reduceWorkflow(userApproved, { type: "record-initiative-acceptance", report: acceptance(userApproved) }), /self-review/i);
  assert.throws(() => reduceWorkflow(userApproved, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 }), /independent final acceptance/i);

  const manualRejected = reduceWorkflow(manual, { type: "record-manual-validation", outcome: { status: "rejected", rationale: "target behavior failed", decidedBy: "user", at: "2026-04-01T00:00:07.000Z" } }).workflow;
  const followed = reduceWorkflow(manualRejected, { type: "add-closeout-follow-up", task: { id: "manual-fix", title: "fix manual failure", acceptance: ["manual scenario passes"], writeScope: ["src/**"], nonGoals: ["release"], approaches: [], verification: [check] } }).workflow;
  assert.equal(followed.tasks.at(-1)?.phase, "pending");
});

test("changes create scoped follow-up work that re-enters every task gate", () => {
  const workflow = reduceWorkflow(verified(), { type: "record-initiative-acceptance", report: acceptance(verified(), "changes-requested") }).workflow;
  assert.throws(() => reduceWorkflow(workflow, { type: "add-closeout-follow-up", task: { id: "F1", title: "fix integration", writeScope: [], nonGoals: [], approaches: [], verification: [check] } }), /acceptance|scoped implementation/i);
  const followed = reduceWorkflow(workflow, { type: "add-closeout-follow-up", task: { id: "F1", title: "fix integration", acceptance: ["cross-task behavior passes"], writeScope: ["src/**", "test/**"], nonGoals: ["release"], approaches: ["tdd"], approachReasons: { tdd: "regression first" }, verification: [check] } }).workflow;
  const task = followed.tasks.at(-1)!;
  assert.deepEqual({ status: task.status, phase: task.phase }, { status: "pending", phase: "pending" });
  assert.equal(followed.orchestration.phase, "task-execution");
  assert.equal(followed.closeout, undefined);
});

test("completion requires no risks, exact final approval, checks, and completion-time snapshot/session provenance", () => {
  const workflow = approved();
  assert.throws(() => reduceWorkflow(workflow, { type: "complete-initiative", observedSnapshot: snapshot("sha256:changed"), branchLength: 12 }), /stale/i);
  assert.throws(() => reduceWorkflow(workflow, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 11 }), /provenance/i);
  const complete = reduceWorkflow(workflow, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 }).workflow;
  assert.equal(complete.status, "complete");
  assert.equal(complete.orchestration.phase, "complete");

  const risky = begun(["unresolved rollout risk"]);
  const riskyVerified = reduceWorkflow(risky, { type: "record-initiative-verification", evidence: evidence(risky), observedSnapshot: snapshot() }, "2026-04-01T00:00:03.000Z").workflow;
  const riskyApproved = reduceWorkflow(riskyVerified, { type: "record-initiative-acceptance", report: acceptance(riskyVerified) }).workflow;
  assert.throws(() => reduceWorkflow(riskyApproved, { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 }), /unresolved blockers or risks/i);
});

test("relevant mutations and parent invalidation stale closeout while competing parents are rejected", () => {
  const workflow = begun();
  const invalidated = reduceWorkflow(workflow, { type: "invalidate-initiative-closeout", observedSnapshot: snapshot("sha256:new"), reason: "source changed" }).workflow;
  assert.equal(invalidated.closeout, undefined);
  const lostParent = reduceWorkflow(workflow, { type: "invalidate-parent", ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, reason: "reload" }).workflow;
  assert.equal(lostParent.closeout, undefined);
  assert.throws(() => reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "other", sessionId: "other", runtimeId: "other", cwd: ROOT, claimedAt: AT, valid: true } }), /competing parent/i);
});

test("imported completion labels remain historical and do not create fresh v2 acceptance", () => {
  const legacy = parseWorkflow({ version: 1, topic: "legacy-done", revision: 2, status: "complete", goal: "legacy", tasks: [{ id: "old", title: "old", status: "complete", dependsOn: [], acceptance: [], approaches: [], approachReasons: {}, assessmentStatus: "assessed", verification: [check], evidence: [], evidenceLinks: [] }], updatedAt: AT });
  assert.equal(legacy.tasks[0]!.phase, "historical");
  assert.equal(legacy.status, "paused");
  assert.equal(legacy.orchestration.phase, "plan-review");
  assert.equal(legacy.initiativeAcceptance, undefined);
  const planApproved = reduceWorkflow(legacy, { type: "record-plan-review", report: { ...terminalWorkflow().planReview!, provenance: { ...terminalWorkflow().planReview!.provenance, contractHash: legacy.contract.hash } } }).workflow;
  assert.equal(planApproved.orchestration.phase, "initiative-acceptance");
  const historicalV2 = terminalWorkflow();
  const imported = parseWorkflow({ ...historicalV2, status: "complete", initiativeVerification: undefined, closeout: undefined, initiativeAcceptance: undefined, orchestration: { ...historicalV2.orchestration, phase: "complete" } });
  assert.equal(imported.status, "paused");
  assert.equal(imported.orchestration.phase, "initiative-acceptance");
  assert.deepEqual(imported.initiativeVerification, [check]);
});

test("one-shot closeout authority rejects model-authored, stale, replayed, reload-lost, and TOCTOU evidence", () => {
  let observed = snapshot();
  const inspector: InitiativeCloseoutInspector = { inspect: () => ({ snapshot: observed, cumulativeDelta: "diff", unresolvedRisks: [] }) };
  const workflow = begun();
  const authority = new InitiativeCloseoutAuthority(ROOT, inspector, { now: () => "2026-04-01T00:00:02.000Z", id: () => "auth-1" });
  const authorization = authority.authorize({ workflow, commandLine: "node --test test/integration.test.ts", toolName: "bash", toolCallId: "bash-1", parent });
  const submission = authority.finish({ authorizationId: authorization.id, workflow, toolCallId: "bash-1", exitCode: 0, parent });
  assert.equal(authority.consume(submission, workflow, parent).evidence.source?.toolName, "bash");
  assert.throws(() => authority.consume(submission, workflow, parent), /already consumed|forged|stale/i);

  const reloaded = new InitiativeCloseoutAuthority(ROOT, inspector);
  assert.throws(() => reloaded.finish({ authorizationId: "auth-1", workflow, toolCallId: "bash-1", exitCode: 0, parent }), /reload|forged|stale/i);

  const second = new InitiativeCloseoutAuthority(ROOT, inspector, { id: () => "auth-2" });
  const grant = second.authorize({ workflow, commandLine: "node --test test/integration.test.ts", toolName: "bash", toolCallId: "bash-2", parent });
  observed = snapshot("sha256:mutated");
  const changed = second.finish({ authorizationId: grant.id, workflow, toolCallId: "bash-2", exitCode: 0, parent });
  assert.throws(() => second.consume(changed, workflow, parent), /snapshot changed/i);
});

test("completion authority holds a cooperative repository fence through completion checks", () => {
  let held = false;
  const workflow = approved();
  const inspector: InitiativeCloseoutInspector = {
    inspect: () => ({ snapshot: workflow.closeout!.snapshot, cumulativeDelta: "delta", unresolvedRisks: [] }),
    acquireFence: () => { assert.equal(held, false); held = true; return () => { held = false; }; },
  };
  const authority = new InitiativeCloseoutAuthority(ROOT, inspector);
  const release = authority.acquireCompletionFence(workflow, parent);
  assert.equal(held, true);
  assert.equal(authority.assertCompletion(workflow, parent).hash, snapshot().hash);
  release();
  assert.equal(held, false);
  const unfenced = new InitiativeCloseoutAuthority(ROOT, { inspect: inspector.inspect });
  assert.throws(() => unfenced.acquireCompletionFence(workflow, parent), /repository mutation fence|not an OS sandbox/i);
});

test("engine persists a successful fenced completion and returns complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-complete-"));
  const base = approved();
  const workflow = parseWorkflow({ ...base, orchestration: { ...base.orchestration, parent: { ...base.orchestration.parent, cwd: root } }, closeout: { ...base.closeout, evidence: base.closeout!.evidence.map((item) => ({ ...item, cwd: root })) } });
  saveWorkflow(root, workflow);
  let held = false;
  const inspector: InitiativeCloseoutInspector = { inspect: () => ({ snapshot: workflow.closeout!.snapshot, cumulativeDelta: JSON.stringify("delta"), unresolvedRisks: [] }), acquireFence: () => { held = true; return () => { held = false; }; } };
  const authority = new InitiativeCloseoutAuthority(root, inspector);
  const engine = new OrchestrationEngine(root, { runner: { run: async () => { throw new Error("runner must not execute after approval"); } }, ownerId: parent.ownerId, parent: { ...parent, cwd: root }, provider: "test", model: "test", thinking: "off", closeoutInspector: inspector, closeoutAuthority: authority });
  const result = await engine.advance(workflow.topic, workflow.revision);
  assert.equal(result.kind, "complete", result.message);
  assert.equal(result.workflow.status, "complete");
  assert.equal(held, false);
});

test("fresh final reviewer receives the full initiative packet and is forbidden from side effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-closeout-"));
  const base = verified();
  const delta = "diff --git a/src/a.ts b/src/a.ts";
  const manualValidation = { status: "approved", rationale: "validated on target hardware", decidedBy: "user", at: "2026-04-01T00:00:07.000Z" } as const;
  const workflow = parseWorkflow({ ...base, orchestration: { ...base.orchestration, parent: { ...base.orchestration.parent, cwd: root } }, closeout: { ...base.closeout, manualValidation, cumulativeDeltaHash: `sha256:${createHash("sha256").update(delta).digest("hex")}`, checkpoint: { ...base.closeout!.checkpoint, ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId } } });
  saveWorkflow(root, workflow);
  let request: AgentRunRequest | undefined;
  const runner: OrchestrationRunner = { async run(input): Promise<RunnerResult> { request = input; return { ok: true, report: { kind: "final-acceptance", outcome: "approved", summary: "integrated", findings: [], provenance: { runId: input.runId, role: "final-reviewer", actorId: input.actorId, leaseId: input.lease.id, leaseFence: input.lease.fence, contractHash: input.contractPacket.hash, snapshotHash: input.snapshotPacket!.hash, startedAt: "2026-04-01T00:00:04.000Z", completedAt: "2026-04-01T00:00:05.000Z" } }, effectiveConfig: {} as never, attempts: 1 }; } };
  const inspector: InitiativeCloseoutInspector = { inspect: () => ({ snapshot: workflow.closeout!.snapshot, cumulativeDelta: delta, unresolvedRisks: [] }) };
  const engine = new OrchestrationEngine(root, { runner, ownerId: parent.ownerId, parent: { ...parent, cwd: root }, provider: "test", model: "test", thinking: "off", closeoutInspector: inspector, id: (prefix) => `${prefix}-fresh`, now: (() => { let n = 10; return () => `2026-04-01T00:00:${n++}.000Z`; })() });
  const result = await engine.advance(workflow.topic, workflow.revision);
  assert.equal(result.kind, "advanced", result.message);
  const packet = request!.contractPacket.payload as Record<string, unknown>;
  assert.equal(packet.originalGoal, workflow.goal);
  assert.equal(packet.approvedPlan, workflow.plan);
  assert.equal(packet.cumulativeInitiativeDelta, delta);
  assert.ok(Array.isArray(packet.taskOutcomes));
  assert.deepEqual(packet.unresolvedRisks, []);
  assert.deepEqual(packet.manualValidation, manualValidation);
  assert.deepEqual(packet.finalRepositorySnapshot, workflow.closeout!.snapshot);
  assert.match(request!.projectInstructions.join(" "), /do not implement, patch, commit, push, deploy, or release/i);
});

test("successful closeout is implementation acceptance only and grants no external side effects", () => {
  const decision = reduceWorkflow(approved(), { type: "complete-initiative", observedSnapshot: snapshot(), branchLength: 12 });
  assert.equal(parseWorkflow(decision.workflow).status, "complete");
  assert.throws(() => parseWorkflow({ ...decision.workflow, closeout: { ...decision.workflow.closeout!, evidence: [] } }), /missing current passing/i);
  assert.throws(() => parseWorkflow({ ...decision.workflow, initiativeAcceptance: { ...decision.workflow.initiativeAcceptance!, kind: "plan-review", provenance: { ...decision.workflow.initiativeAcceptance!.provenance, role: "plan-reviewer" } } }), /incorrect runner provenance/i);
  assert.match(decision.message, /implementation accepted/i);
  assert.match(decision.message, /commit, push, deployment, release.*separately authorized/i);
});
