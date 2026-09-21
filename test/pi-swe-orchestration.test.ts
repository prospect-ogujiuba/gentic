import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationEngine,
  postCutoverReviewRequest,
  type OrchestrationHandoff,
  type OrchestrationRunner,
  type OrchestrationWorkspace,
} from "../extensions/pi-swe/src/orchestration.ts";
import type { AgentRunRequest, RunnerResult } from "../extensions/pi-swe/src/runner.ts";
import { ManagedVerificationAuthority, renderVerificationCommand, type RelevantSourceInspector, type RelevantSourceSnapshot } from "../extensions/pi-swe/src/integrity.ts";
import { WorkflowMutationService } from "../extensions/pi-swe/src/service.ts";
import {
  createWorkflow,
  reduceWorkflow,
  type Finding,
  type RunLease,
  type StageReport,
  type Workflow,
  type WorkflowApproach,
} from "../extensions/pi-swe/src/workflow.ts";
import type { GitIntegrationReceipt, GitWorkspaceReceipt, PreparedIntegration } from "../extensions/pi-swe/src/workspace.ts";

const NOW = "2026-03-01T00:00:00.000Z";
let clock = 0;
const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();

function workflow(approaches: WorkflowApproach[] = ["tdd", "diagnosis", "dsa"]): Workflow {
  return createWorkflow({
    topic: "engine-test",
    goal: "Implement one bounded change",
    plan: "Use isolated implementation and independent review.",
    now: now(),
    tasks: [{
      id: "T1",
      title: "change source",
      acceptance: ["behavior is tested"],
      approaches,
      approachReasons: Object.fromEntries(approaches.map((item) => [item, `${item} applies`])),
      assessmentStatus: "assessed",
      writeScope: ["src/**", "test/**"],
      nonGoals: ["deployment"],
      verification: [{ command: "node", args: ["--test"] }],
    }],
  });
}

function report(request: AgentRunRequest, outcome?: StageReport["outcome"], findings: Finding[] = []): StageReport {
  const kind = request.role === "plan-reviewer" ? "plan-review" : request.role === "implementer" ? "implementation" : request.role === "general-reviewer" ? "general-review" : request.role === "concern-reviewer" ? "concern-review" : "final-acceptance";
  return {
    kind,
    outcome: outcome ?? (request.role === "implementer" ? "completed" : "approved"),
    summary: `${request.role} result`,
    ...(request.role === "implementer" ? { changedPaths: ["src/a.ts"] } : {}),
    findings,
    provenance: {
      runId: request.runId,
      role: request.role,
      actorId: request.actorId,
      leaseId: request.lease.id,
      leaseFence: request.lease.fence,
      contractHash: request.contractPacket.hash,
      ...(request.snapshotPacket ? { snapshotHash: request.snapshotPacket.hash } : {}),
      startedAt: now(),
      completedAt: now(),
    },
  };
}

type RunnerHandler = (request: AgentRunRequest) => StageReport | RunnerResult | Promise<StageReport | RunnerResult>;
class FakeRunner implements OrchestrationRunner {
  readonly requests: AgentRunRequest[] = [];
  readonly handler: RunnerHandler;
  constructor(handler: RunnerHandler = (request) => report(request)) { this.handler = handler; }
  async run(request: AgentRunRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const value = await this.handler(request);
    if ("ok" in value) return value;
    return { ok: true, report: value, effectiveConfig: {} as never, attempts: 1 };
  }
}

class FakeWorkspace implements OrchestrationWorkspace {
  creates = 0;
  remediations = 0;
  integrations = 0;
  preparation = 0;
  sourceChanged = false;
  driftPaths: string[] = [];
  createWorkspace(input: { topic: string; taskId: string; writeScope: string[] }): GitWorkspaceReceipt {
    this.creates++;
    return this.receipt(`ws-${this.creates}`, input, "baseline");
  }
  createRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt): GitWorkspaceReceipt {
    this.remediations++;
    if (this.sourceChanged) throw new Error("cannot reconstruct remediation after source drift");
    return this.receipt(`repair-${this.remediations}`, receipt, integrated.postSnapshotHash);
  }
  createDriftRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt, _workspaceId?: string, observedChangedPaths: string[] = []): GitWorkspaceReceipt {
    this.remediations++;
    this.driftPaths = [...observedChangedPaths];
    return this.receipt(`drift-repair-${this.remediations}`, receipt, `changed-${integrated.postSnapshotHash}`);
  }
  prepareIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    this.preparation++;
    const snapshotHash = `snapshot-${this.preparation}`;
    const changedPaths = ["src/a.ts"];
    const preparedReceipt = {
      ...receipt,
      snapshotHash,
      changedPaths,
      preparedResultCommit: `result-${this.preparation}`,
      preparedResultRef: `refs/pi-swe/results/${receipt.workspaceId}`,
      preparedPatchHash: `patch-${this.preparation}`,
    };
    return { receipt: preparedReceipt, patch: Buffer.from(`delta-${this.preparation}`), patchHash: preparedReceipt.preparedPatchHash, resultCommit: preparedReceipt.preparedResultCommit, resultRef: preparedReceipt.preparedResultRef, changedPaths, patchPaths: changedPaths, preflight: {} as never };
  }
  resumePreparedIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    return { receipt, patch: Buffer.from(`delta-${receipt.preparedResultCommit}`), patchHash: receipt.preparedPatchHash!, resultCommit: receipt.preparedResultCommit!, resultRef: receipt.preparedResultRef!, changedPaths: receipt.changedPaths, patchPaths: receipt.changedPaths, preflight: {} as never };
  }
  integrate(prepared: PreparedIntegration): GitIntegrationReceipt {
    this.integrations++;
    return { version: 1, integrationId: `integration-${this.integrations}`, workspaceId: prepared.receipt.workspaceId, preSnapshotHash: prepared.receipt.baselineHash, postSnapshotHash: prepared.receipt.snapshotHash, patchHash: prepared.patchHash, resultCommit: prepared.resultCommit, resultRef: prepared.resultRef, observedHead: prepared.receipt.realHead, observedIndexHash: prepared.receipt.realIndexHash, changedPaths: prepared.changedPaths, integratedAt: now() };
  }
  cumulativeDiff(receipt: GitWorkspaceReceipt): Buffer { return Buffer.from(`cumulative-${receipt.preparedResultCommit ?? receipt.workspaceId}`); }
  private receipt(id: string, input: { topic?: string; taskId?: string; writeScope?: string[]; baselineCommit?: string; includedUntracked?: string[]; managedPaths?: string[]; realHead?: string; realIndexHash?: string }, baselineHash: string): GitWorkspaceReceipt {
    return {
      version: 1, workspaceId: id, root: "/repo", path: `/work/${id}`, taskId: input.taskId ?? "T1", topic: input.topic ?? "engine-test",
      baselineHash, snapshotHash: baselineHash, changedPaths: [], createdAt: now(), baselineCommit: input.baselineCommit ?? "base-commit",
      baselineRef: `refs/pi-swe/baselines/${id}`, worktreeGitDir: `/git/${id}`, ownershipToken: `owner-${id}`,
      intentPath: `/intent/${id}`, workspaceHeadCommit: "base-commit", realHead: input.realHead ?? "head", realIndexHash: input.realIndexHash ?? "index",
      realIndexTree: "tree", stagedPatchHash: "staged", unstagedPatchHash: "unstaged", realSourceSnapshotHash: baselineHash,
      includedUntracked: input.includedUntracked ?? [], managedPaths: input.managedPaths ?? [], writeScope: input.writeScope ?? ["src/**", "test/**"],
    };
  }
}

class EngineSnapshotInspector implements RelevantSourceInspector {
  override?: RelevantSourceSnapshot;
  sequence: RelevantSourceSnapshot[] = [];
  inspect(workflow: Workflow): RelevantSourceSnapshot {
    if (this.sequence.length) return structuredClone(this.sequence.shift()!);
    if (this.override) return structuredClone(this.override);
    const receipt = workflow.tasks[0]!.integrationReceipt;
    return { hash: receipt?.postSnapshotHash ?? "not-integrated", head: receipt?.observedHead ?? "head", branch: "main", changedPaths: [] };
  }
}

async function setup(approaches?: WorkflowApproach[], runner?: FakeRunner, workspace?: FakeWorkspace) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-engine-"));
  const service = new WorkflowMutationService(cwd);
  await service.create(workflow(approaches));
  const actualRunner = runner ?? new FakeRunner();
  const actualWorkspace = workspace ?? new FakeWorkspace();
  const inspector = new EngineSnapshotInspector();
  const parent = { ownerId: "parent", sessionId: "parent-session", runtimeId: "runtime-1", cwd, sessionBranchId: "leaf-1", branchLength: 10 };
  const verificationAuthority = new ManagedVerificationAuthority(cwd, inspector, { now, id: (() => { let id = 0; return () => `auth-${++id}`; })() });
  const engine = new OrchestrationEngine(cwd, {
    service, runner: actualRunner, workspace: actualWorkspace,
    ownerId: "parent", parent, verificationAuthority, provider: "fixture", model: "fixture", thinking: "high", now,
    id: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
    authorizeUserDecision: (decision) => decision.decidedBy === "user",
  });
  return { cwd, service, runner: actualRunner, workspace: actualWorkspace, engine, parent, verificationAuthority, inspector };
}

function current(service: WorkflowMutationService): Workflow { return service.read("engine-test", false)!.workflow; }
async function advance(setupValue: Awaited<ReturnType<typeof setup>>): Promise<OrchestrationHandoff> {
  return setupValue.engine.advance("engine-test", current(setupValue.service).revision);
}
async function planAndStart(value: Awaited<ReturnType<typeof setup>>): Promise<void> { await advance(value); await advance(value); }
async function reachReview(value: Awaited<ReturnType<typeof setup>>): Promise<void> { await planAndStart(value); await advance(value); }
async function reachIntegration(value: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await reachReview(value); await advance(value);
  if (current(value.service).tasks[0]!.phase === "concern-review") await advance(value);
  await advance(value);
}
async function reachVerification(value: Awaited<ReturnType<typeof setup>>): Promise<void> { await reachIntegration(value); await advance(value); }
function protectedSubmission(value: Awaited<ReturnType<typeof setup>>, exitCode = 0, after?: RelevantSourceSnapshot) {
  const state = current(value.service);
  const task = state.tasks[0]!;
  const toolCallId = `tool-${clock}`;
  const authorization = value.verificationAuthority.authorize({ workflow: state, taskId: task.id, toolName: "bash", toolCallId, commandLine: renderVerificationCommand(task.verification[0]!), parent: value.parent });
  if (after) value.inspector.override = after;
  return value.verificationAuthority.finish({ authorizationId: authorization.id, workflow: state, taskId: task.id, toolCallId, exitCode, parent: value.parent });
}

test("explicit FSM advances one stage at a time and does not skip required gates", async () => {
  const value = await setup();
  assert.equal((await advance(value)).stage, "plan-review");
  assert.equal(current(value.service).orchestration.phase, "task-execution");
  assert.equal(current(value.service).activeTask, undefined);
  assert.equal((await advance(value)).stage, "implementation");
  assert.equal(current(value.service).tasks[0]!.phase, "implementation");
  assert.equal(value.runner.requests.length, 1);
  assert.equal((await advance(value)).stage, "general-review");
  assert.equal(current(value.service).tasks[0]!.phase, "general-review");
  assert.equal(value.runner.requests.length, 2);
  assert.throws(() => reduceWorkflow(current(value.service), { type: "record-integration", receipt: {} as never }, now()), /integration report is not valid|integration/);
});

test("post-cutover review profile disables thinking only for direct independent recovery reviews", async () => {
  const value = await setup();
  await advance(value);
  const ordinary = value.runner.requests[0]!;
  assert.equal(ordinary.role, "plan-reviewer");
  assert.equal(ordinary.thinking, "high", "ordinary orchestration must retain configured thinking");
  assert.equal(ordinary.reviewInput, undefined);
  const reviewInput = { path: "node_modules/review.patch", content: "full immutable delta", hash: `sha256:${"a".repeat(64)}`, bytes: 20, changedPaths: ["src/a.ts"] };
  for (const role of ["plan-reviewer", "general-reviewer", "concern-reviewer"] as const) {
    const profiled = postCutoverReviewRequest({ ...ordinary, role }, reviewInput);
    assert.equal(profiled.thinking, "off");
    assert.equal(profiled.provider, ordinary.provider); assert.equal(profiled.model, ordinary.model);
    assert.deepEqual(profiled.budgets, ordinary.budgets);
    assert.equal(profiled.reviewInput, reviewInput, "the exact full delta attachment must be preserved");
    assert.match(profiled.projectInstructions.at(-1)!, /exactly one concise runner_report/i);
    assert.match(profiled.projectInstructions.at(-1)!, /without narrated analysis/i);
  }
  assert.equal(ordinary.thinking, "high", "profiling must not mutate the ordinary request");
  for (const role of ["implementer", "final-reviewer"] as const) assert.throws(() => postCutoverReviewRequest({ ...ordinary, role }, reviewInput), /restricted to direct independent review roles/i);
});

test("plan rejection and clarification block without falling through to implementation", async () => {
  for (const outcome of ["changes-requested", "needs-input"] as const) {
    const runner = new FakeRunner((request) => {
      const result = report(request, outcome);
      if (outcome === "needs-input") result.questions = [{ id: "q-plan", question: "Which contract?", askedByRunId: request.runId, askedAt: now() }];
      return result;
    });
    const value = await setup(undefined, runner);
    const handoff = await advance(value);
    assert.equal(handoff.kind, outcome === "needs-input" ? "needs-input" : "blocked");
    assert.equal(current(value.service).status, "blocked");
    assert.equal(runner.requests.filter((item) => item.role === "implementer").length, 0);
  }
});

test("concurrent duplicate advances are fenced and spawn one fresh child", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const runner = new FakeRunner(async (request) => { await wait; return report(request); });
  const value = await setup(undefined, runner);
  const revision = current(value.service).revision;
  const first = value.engine.advance("engine-test", revision);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = value.engine.advance("engine-test", revision);
  release();
  const outcomes = await Promise.all([first, second]);
  assert.equal(runner.requests.length, 1);
  assert.equal(outcomes.filter((item) => item.kind === "stale").length, 1);
});

test("competing parent sessions cannot transfer workflow authority", async () => {
  const value = await setup();
  await advance(value); // claims parent and completes plan review
  const state = current(value.service);
  const competingRunner = new FakeRunner();
  const competingParent = { ownerId: "parent-b", sessionId: "session-b", runtimeId: "runtime-b", cwd: value.cwd, sessionBranchId: "leaf-b", branchLength: 1 };
  const competing = new OrchestrationEngine(value.cwd, {
    service: value.service, runner: competingRunner, workspace: value.workspace,
    ownerId: "parent-b", parent: competingParent, verificationAuthority: value.verificationAuthority,
    provider: "fixture", model: "fixture", thinking: "high", now,
  });
  const result = await competing.advance("engine-test", state.revision);
  assert.equal(result.kind, "blocked");
  assert.match(result.message, /competing|stale parent/i);
  assert.equal(competingRunner.requests.length, 0);
  assert.equal(current(value.service).orchestration.parent?.ownerId, "parent");
});

test("cancelled lease fences stale child completion", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const runner = new FakeRunner(async (request) => { await wait; return report(request); });
  const value = await setup(undefined, runner);
  const pending = advance(value);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const claimed = current(value.service);
  const lease = claimed.orchestration.activeRun!;
  await value.service.cancelRun("engine-test", claimed.revision, lease, "user cancelled", now());
  release();
  const handoff = await pending;
  assert.equal(handoff.kind, "stale");
  assert.equal(current(value.service).planReview, undefined);
});

test("fresh distinct general review is blind and covers the cumulative snapshot", async () => {
  const value = await setup();
  await reachReview(value);
  await advance(value);
  const [plan, implementer, general] = value.runner.requests;
  assert.notEqual(implementer!.actorId, general!.actorId);
  assert.notEqual(implementer!.runId, general!.runId);
  assert.equal(general!.snapshotPacket!.hash, current(value.service).tasks[0]!.workspaceReceipt!.snapshotHash);
  const payload = general!.snapshotPacket!.payload as Record<string, unknown>;
  assert.match(String(payload.cumulativeDelta), /cumulative/);
  assert.deepEqual(payload.relevantFiles, ["src/a.ts"]);
  assert.deepEqual(payload.objectiveEvidence, []);
  assert.equal("reports" in payload, false);
  assert.equal("verdicts" in payload, false);
  assert.equal(plan!.role, "plan-reviewer");
});

test("self-review and stale snapshot reports are blocked rather than accepted", async () => {
  let implementerActor = "";
  const runner = new FakeRunner((request) => {
    const result = report(request);
    if (request.role === "implementer") implementerActor = request.actorId;
    if (request.role === "general-reviewer") result.provenance.actorId = implementerActor;
    return result;
  });
  const value = await setup(undefined, runner);
  await reachReview(value);
  const handoff = await advance(value);
  assert.equal(handoff.kind, "blocked");
  assert.equal(current(value.service).tasks[0]!.phase, "general-review");

  const staleRunner = new FakeRunner((request) => {
    const result = report(request);
    if (request.role === "general-reviewer") result.provenance.snapshotHash = "obsolete-snapshot";
    return result;
  });
  const stale = await setup(undefined, staleRunner);
  await reachReview(stale);
  assert.equal((await advance(stale)).kind, "blocked");
  assert.equal(current(stale.service).orchestration.activeRun, undefined);
});

test("malformed finding disposition is rejected and the child lease is released", async () => {
  const runner = new FakeRunner((request) => request.role === "general-reviewer"
    ? report(request, "approved", [{ id: "never-opened", severity: "blocking", status: "resolved", summary: "invented", evidence: "none", disposition: "claimed fixed" }])
    : report(request));
  const value = await setup(undefined, runner);
  await reachReview(value);
  const handoff = await advance(value);
  assert.equal(handoff.kind, "blocked");
  assert.equal(current(value.service).orchestration.activeRun, undefined);
  assert.match(current(value.service).tasks[0]!.blockedReason!, /rejected child result/);
});

test("one composed concern reviewer is routed only for selected specialist concerns", async () => {
  const specialist = await setup(["tdd", "dsa", "security", "performance", "operations"]);
  await reachReview(specialist); await advance(specialist); await advance(specialist);
  const concern = specialist.runner.requests.filter((request) => request.role === "concern-reviewer");
  assert.equal(concern.length, 1);
  assert.deepEqual((concern[0]!.contractPacket.payload as any).selectedConcerns, ["security", "performance", "operations"]);
  assert.equal("reports" in (concern[0]!.snapshotPacket!.payload as any), false);

  const generalOnly = await setup(["tdd", "diagnosis", "dsa"]);
  await reachReview(generalOnly); await advance(generalOnly);
  assert.equal(current(generalOnly.service).tasks[0]!.phase, "workspace");
  assert.equal(generalOnly.runner.requests.some((request) => request.role === "concern-reviewer"), false);
});

test("clarification returns control and resumes the same stage without spending repair budget", async () => {
  let implementationRuns = 0;
  const runner = new FakeRunner((request) => {
    const result = report(request);
    if (request.role === "implementer" && implementationRuns++ === 0) {
      result.outcome = "needs-input";
      result.changedPaths = [];
      result.questions = [{ id: "q-impl", question: "Use format A?", askedByRunId: request.runId, askedAt: now() }];
    }
    return result;
  });
  const value = await setup(undefined, runner);
  await planAndStart(value);
  assert.equal((await advance(value)).kind, "needs-input");
  let state = current(value.service);
  assert.equal(state.tasks[0]!.remediation.used, 0);
  await value.service.mutate("engine-test", state.revision, (item) => reduceWorkflow(item, { type: "respond-clarification", taskId: "T1", questionId: "q-impl", answer: "Use A", answeredBy: "user" }, now()));
  assert.equal((await advance(value)).stage, "implementation");
  assert.equal(current(value.service).tasks[0]!.remediation.used, 0);
  await advance(value);
  assert.equal(current(value.service).tasks[0]!.phase, "general-review");
});

test("changes requested launches fresh cumulative remediation and complete re-review", async () => {
  let generalRuns = 0;
  const runner = new FakeRunner((request) => {
    const result = report(request);
    if (request.role === "general-reviewer" && generalRuns++ === 0) result.outcome = "changes-requested";
    return result;
  });
  const value = await setup(undefined, runner);
  await reachReview(value);
  assert.equal((await advance(value)).kind, "blocked");
  assert.equal(current(value.service).tasks[0]!.phase, "remediation");
  await advance(value); // resume => implementation
  await advance(value); // fresh implementer
  await advance(value); // complete general re-review
  assert.equal(value.runner.requests.filter((request) => request.role === "implementer").length, 2);
  assert.equal(value.runner.requests.filter((request) => request.role === "general-reviewer").length, 2);
  assert.match(String((value.runner.requests.at(-1)!.snapshotPacket!.payload as any).cumulativeDelta), /cumulative/);
});

test("blocking findings keep stable IDs until independent confirmation or user decision", async () => {
  let generalRuns = 0;
  const runner = new FakeRunner((request) => {
    if (request.role !== "general-reviewer") return report(request);
    if (generalRuns++ === 0) return report(request, "changes-requested", [{ id: "F-stable", severity: "blocking", status: "open", summary: "bug", evidence: "src/a.ts:1" }]);
    return report(request, "approved", [{ id: "F-stable", severity: "blocking", status: "resolved", summary: "bug", evidence: "src/a.ts:1", disposition: "confirmed fixed by fresh review" }]);
  });
  const value = await setup(undefined, runner);
  await reachReview(value); await advance(value); await advance(value); await advance(value); await advance(value);
  const finding = current(value.service).tasks[0]!.findings.find((item) => item.id === "F-stable")!;
  assert.equal(finding.status, "resolved");
  assert.match(finding.disposition!, /fresh review/);
});

test("at most two remediation attempts survive pause/resume and exhaustion blocks", async () => {
  const runner = new FakeRunner((request) => request.role === "general-reviewer" ? report(request, "changes-requested") : report(request));
  const value = await setup(undefined, runner);
  await reachReview(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    await advance(value); // reject
    if (attempt === 2) break;
    let state = current(value.service);
    await value.service.mutate("engine-test", state.revision, (item) => reduceWorkflow(item, { type: "pause" }, now()));
    await advance(value); // resume repair
    await advance(value); // implement
  }
  const before = value.runner.requests.length;
  const handoff = await advance(value);
  assert.equal(handoff.kind, "blocked");
  assert.match(handoff.message, /budget exhausted/);
  assert.equal(current(value.service).tasks[0]!.remediation.used, 2);
  assert.equal(value.runner.requests.length, before);
});

test("remediation budget reset requires an explicit audited decision", async () => {
  const runner = new FakeRunner((request) => request.role === "general-reviewer" ? report(request, "changes-requested") : report(request));
  const value = await setup(undefined, runner);
  await reachReview(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    await advance(value);
    if (attempt < 2) { await advance(value); await advance(value); }
  }
  let state = current(value.service);
  await assert.rejects(() => value.engine.resetRemediation("engine-test", state.revision, { taskId: "T1", max: 3, reason: "parent self-reset", decidedBy: "parent" }), /authorized user-decision provenance/);
  const reset = await value.engine.resetRemediation("engine-test", state.revision, { taskId: "T1", max: 3, reason: "user authorizes one bounded retry", decidedBy: "user" });
  assert.equal(reset.kind, "blocked");
  state = current(value.service);
  assert.equal(state.tasks[0]!.remediation.max, 3);
  assert.equal(state.orchestration.history.at(-1)!.type, "remediation-reset");
  assert.equal((await advance(value)).stage, "implementation");
});

test("integration is approval-gated, fenced, and cannot apply twice", async () => {
  const workspace = new FakeWorkspace();
  const value = await setup(undefined, undefined, workspace);
  await reachIntegration(value);
  const revision = current(value.service).revision;
  const [first, duplicate] = await Promise.all([value.engine.advance("engine-test", revision), value.engine.advance("engine-test", revision)]);
  assert.equal(workspace.integrations, 1);
  assert.equal([first, duplicate].filter((item) => item.kind === "stale").length, 1);
  assert.equal(current(value.service).tasks[0]!.phase, "verification");
});

test("verification failure and source-changing verification use the same fresh repair path", async () => {
  for (const sourceChanged of [false, true]) {
    const workspace = new FakeWorkspace();
    workspace.sourceChanged = sourceChanged;
    const value = await setup(undefined, undefined, workspace);
    await reachVerification(value);
    const state = current(value.service);
    const submission = protectedSubmission(value, sourceChanged ? 0 : 1, sourceChanged ? { hash: "mutated-source", head: state.tasks[0]!.integrationReceipt!.observedHead!, branch: "main", changedPaths: ["src/a.ts"] } : undefined);
    const handoff = await value.engine.advance("engine-test", state.revision, { verification: submission });
    assert.equal(handoff.kind, "blocked");
    assert.equal(current(value.service).tasks[0]!.phase, "remediation");
    await advance(value); // resume
    await advance(value); // remediation child
    assert.equal(workspace.remediations, 1);
    if (sourceChanged) assert.deepEqual(workspace.driftPaths, ["src/a.ts"]);
    assert.equal(current(value.service).tasks[0]!.phase, "general-review");
  }
});

test("source drift outside task scope still invalidates approvals and enters remediation", async () => {
  const value = await setup();
  await reachVerification(value);
  const state = current(value.service);
  const submission = protectedSubmission(value, 0, { hash: "mutated-config", head: state.tasks[0]!.integrationReceipt!.observedHead!, branch: "main", changedPaths: ["package-lock.json"] });
  const result = await value.engine.advance("engine-test", state.revision, { verification: submission });
  assert.equal(result.kind, "blocked");
  assert.equal(current(value.service).tasks[0]!.phase, "remediation");
  assert.deepEqual(current(value.service).tasks[0]!.verificationDriftPaths, ["package-lock.json"]);
});

test("forged and stale verification submissions cannot advance the engine", async () => {
  const value = await setup();
  await reachVerification(value);
  const state = current(value.service);
  const forged = {
    authorizationId: "model-authored", topic: state.topic, taskId: "T1", workflowRevision: state.revision,
    evidence: { command: "node", args: ["--test"], exitCode: 0, at: now(), contractHash: state.tasks[0]!.contract.hash, snapshotHash: state.tasks[0]!.integrationReceipt!.postSnapshotHash },
    beforeSnapshotHash: state.tasks[0]!.integrationReceipt!.postSnapshotHash, afterSnapshotHash: state.tasks[0]!.integrationReceipt!.postSnapshotHash,
    sourceChanged: false, observedChangedPaths: [],
  };
  const result = await value.engine.advance("engine-test", state.revision, { verification: forged });
  assert.equal(result.kind, "blocked");
  assert.match(result.message, /forged|stale|protected/i);
  assert.equal(current(value.service).revision, state.revision);
});

test("successful verification is snapshot-bound and initializes only after integration", async () => {
  const value = await setup();
  await reachIntegration(value);
  assert.equal(current(value.service).tasks[0]!.verificationCheckpoint, undefined);
  await advance(value);
  let state = current(value.service);
  assert.ok(state.tasks[0]!.verificationCheckpoint);
  const waiting = await advance(value);
  assert.equal(waiting.kind, "verification-required");
  state = current(value.service);
  const submission = protectedSubmission(value);
  await value.engine.advance("engine-test", state.revision, { verification: submission });
  assert.equal(current(value.service).tasks[0]!.phase, "ready-to-complete");
});

test("completion checks the source again inside the final CAS to catch TOCTOU drift", async () => {
  const value = await setup();
  await reachVerification(value);
  let state = current(value.service);
  await value.engine.advance("engine-test", state.revision, { verification: protectedSubmission(value) });
  state = current(value.service);
  assert.equal(state.tasks[0]!.phase, "ready-to-complete");
  const stable = { hash: state.tasks[0]!.integrationReceipt!.postSnapshotHash, head: state.tasks[0]!.integrationReceipt!.observedHead!, branch: "main", changedPaths: [] };
  value.inspector.sequence = [stable, { ...stable, hash: "toctou-change", changedPaths: ["test/a.test.ts"] }];
  const result = await value.engine.advance("engine-test", state.revision);
  assert.equal(result.kind, "blocked");
  assert.match(result.message, /source snapshot changed/i);
  assert.equal(current(value.service).revision, state.revision);
  assert.equal(current(value.service).tasks[0]!.phase, "ready-to-complete");
});

test("infrastructure, scope drift, and human-only validation are explicit blockers", async () => {
  const failureRunner = new FakeRunner(async () => ({ ok: false, failure: { code: "credentials-unavailable", message: "no credentials", retryable: false }, attempts: 1 }));
  const failed = await setup(undefined, failureRunner);
  assert.equal((await advance(failed)).kind, "blocked");
  assert.match(current(failed.service).status, /blocked/);

  const needsInput = new FakeRunner((request) => {
    const result = report(request, "needs-input");
    result.questions = [{ id: "q-browser", question: "Browser validation required", askedByRunId: request.runId, askedAt: now() }];
    return result;
  });
  const manual = await setup(undefined, needsInput);
  assert.equal((await advance(manual)).kind, "needs-input");
});
