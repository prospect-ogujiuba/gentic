import { randomUUID } from "node:crypto";

import { createHash } from "node:crypto";

import type { AgentRunRequest, AgentRunner, RunnerResult } from "./runner.ts";
import type { InitiativeCloseoutAuthority, InitiativeCloseoutInspector, InitiativeVerificationSubmission } from "./closeout.ts";
import type { ManagedVerificationAuthority, ParentExecutionIdentity, ProtectedVerificationSubmission } from "./integrity.ts";
import { WorkflowMutationService } from "./service.ts";
import { sweRuntimeRegistry, type RunOutcome, type SweRuntimeRegistry } from "./ux.ts";
import {
  reduceWorkflow,
  scopeAllowsPath,
  type RunLease,
  type RunnerRole,
  type StageReport,
  type TaskPhase,
  type VerificationEvidence,
  type VerificationCommand,
  type Workflow,
  type WorkflowTaskRevision,
  type WorkflowApproach,
  type WorkflowDecision,
  type WorkflowTask,
} from "./workflow.ts";
import { GitWorkspaceManager, type GitIntegrationReceipt, type GitWorkspaceReceipt, type PreparedIntegration } from "./workspace.ts";

const CONCERN_APPROACHES = new Set<WorkflowApproach>(["security", "migration", "performance", "accessibility-ux", "operations"]);
const MAX_REVIEW_DELTA_BYTES = 128 * 1024;

export type OrchestrationRunner = Pick<AgentRunner, "run">;
export type OrchestrationWorkspace = Pick<GitWorkspaceManager,
  "createWorkspace" | "createRemediationWorkspace" | "createDriftRemediationWorkspace" |
  "prepareIntegration" | "resumePreparedIntegration" | "integrate" | "cumulativeDiff"
>;

export type OrchestrationHandoff = {
  kind: "advanced" | "blocked" | "needs-input" | "verification-required" | "stale" | "complete";
  stage: "plan-review" | TaskPhase | "initiative-acceptance" | "complete";
  message: string;
  workflow: Workflow;
  taskId?: string;
  role?: RunnerRole;
  verification?: { contractHash: string; snapshotHash: string; commands: VerificationCommand[]; checkpoint: WorkflowTask["verificationCheckpoint"] | NonNullable<Workflow["closeout"]>["checkpoint"] };
};

export type OrchestrationAdvanceInput = {
  verification?: ProtectedVerificationSubmission;
  initiativeVerification?: InitiativeVerificationSubmission;
};

type EngineOptions = {
  service?: WorkflowMutationService;
  runner: OrchestrationRunner;
  workspace?: OrchestrationWorkspace;
  ownerId: string;
  parent: ParentExecutionIdentity;
  verificationAuthority?: Pick<ManagedVerificationAuthority, "consume" | "assertCompletion">;
  closeoutInspector?: InitiativeCloseoutInspector;
  closeoutAuthority?: Pick<InitiativeCloseoutAuthority, "consume" | "assertCompletion" | "acquireCompletionFence">;
  provider: string;
  model: string;
  thinking: AgentRunRequest["thinking"];
  projectInstructions?: string[];
  readScope?: string[];
  approvedSkills?: string[];
  trustedExtensions?: string[];
  budgets?: AgentRunRequest["budgets"];
  now?: () => string;
  id?: (prefix: string) => string;
  authorizeUserDecision?: (decision: { kind: "finding" | "remediation-reset" | "manual-validation"; taskId?: string; decidedBy: string; reason: string }) => boolean;
  runtimeRegistry?: SweRuntimeRegistry;
};

type ChildOutcome =
  | { ok: true; report: StageReport; receipt?: GitWorkspaceReceipt }
  | { ok: false; reason: string };

/**
 * One call performs at most one finite-state stage transition. Long-running child
 * and integration work is fenced by WorkflowMutationService leases; the lock is
 * never held while a child executes. Capabilities and worktrees are not an OS sandbox.
 */
export class OrchestrationEngine {
  readonly cwd: string;
  readonly service: WorkflowMutationService;
  readonly runner: OrchestrationRunner;
  readonly workspace: OrchestrationWorkspace;
  readonly options: EngineOptions;

  constructor(cwd: string, options: EngineOptions) {
    if (!options.ownerId.trim() || !options.provider.trim() || !options.model.trim()) throw new Error("orchestration owner, provider, and model are required");
    if (options.parent.ownerId !== options.ownerId || !options.parent.sessionId.trim() || !options.parent.runtimeId.trim() || !options.parent.cwd.trim()) throw new Error("orchestration parent identity must match the owner and bind session, runtime, and cwd");
    this.cwd = cwd;
    this.options = options;
    this.service = options.service ?? new WorkflowMutationService(cwd);
    this.runner = options.runner;
    this.workspace = options.workspace ?? new GitWorkspaceManager(cwd);
  }

  async advance(topic: string, expectedRevision: number, input: OrchestrationAdvanceInput = {}): Promise<OrchestrationHandoff> {
    const located = this.service.read(topic, true);
    if (!located) throw new Error(`workflow ${topic} was not found`);
    let workflow = located.workflow;
    if (workflow.revision !== expectedRevision) return this.handoff("stale", workflow, "workflow revision changed before advance");
    try {
      if (!workflow.orchestration.parent) {
        const claimed = await this.service.mutate(topic, workflow.revision, (state) => reduceWorkflow(state, { type: "claim-parent", authority: {
          ownerId: this.options.ownerId, sessionId: this.options.parent.sessionId, runtimeId: this.options.parent.runtimeId,
          cwd: this.cwd, ...(this.options.parent.sessionFile ? { sessionFile: this.options.parent.sessionFile } : {}),
          claimedAt: this.now(), valid: true,
        } }, this.now()));
        workflow = claimed.workflow;
      } else this.assertParent(workflow);
    } catch (error) {
      return this.handoff("blocked", workflow, message(error));
    }
    if (workflow.orchestration.mode !== "multi-agent") return this.handoff("blocked", workflow, "multi-agent orchestration requires an explicitly migrated v2 workflow");
    if (workflow.orchestration.activeRun && Date.parse(workflow.orchestration.activeRun.expiresAt) > Date.parse(this.now())) return this.handoff("stale", workflow, `run ${workflow.orchestration.activeRun.runId} is already active`);
    if (workflow.orchestration.phase === "complete" || workflow.status === "complete") return this.handoff("complete", workflow, "workflow is complete");

    if (workflow.orchestration.phase === "plan-review") return this.advancePlanReview(topic, workflow);
    if (workflow.orchestration.phase === "initiative-acceptance") return this.advanceCloseout(topic, workflow, input.initiativeVerification);

    const task = workflow.activeTask ? workflow.tasks.find((candidate) => candidate.id === workflow.activeTask) : undefined;
    if (!task) return this.advanceTaskSelection(topic, workflow);
    if (workflow.status === "paused") return this.mutateStage(topic, workflow, { type: "resume" });
    if (workflow.status !== "active") return this.handoff("blocked", workflow, task.blockedReason ?? "task is not active", task);

    if (task.phase === "implementation") return this.runImplementation(topic, workflow, task);
    if (task.phase === "general-review") return this.runReview(topic, workflow, task, "general-reviewer");
    if (task.phase === "concern-review") return this.runReview(topic, workflow, task, "concern-reviewer");
    if (task.phase === "workspace") return this.mutateStage(topic, workflow, { type: "record-workspace", receipt: task.workspaceReceipt! });
    if (task.phase === "integration") return this.integrate(topic, workflow, task);
    if (task.phase === "verification") return this.verify(topic, workflow, task, input.verification);
    if (task.phase === "ready-to-complete") {
      if (!this.options.verificationAuthority) return this.handoff("blocked", workflow, "task completion requires the managed verification authority", task);
      try { this.options.verificationAuthority.assertCompletion(workflow, task, this.options.parent); }
      catch (error) { return this.handoff("blocked", workflow, message(error), task); }
      try {
        return await this.mutateExpected(topic, workflow.revision, (state) => {
          const current = state.activeTask ? state.tasks.find((candidate) => candidate.id === state.activeTask) : undefined;
          if (!current) throw new Error("active task disappeared before completion");
          this.options.verificationAuthority!.assertCompletion(state, current, this.options.parent);
          return reduceWorkflow(state, { type: "complete-task" }, this.now());
        });
      } catch (error) {
        return this.handoff("blocked", this.service.read(topic, true)?.workflow ?? workflow, message(error), task);
      }
    }
    return this.handoff("blocked", workflow, `no advance is valid from task phase ${task.phase}`, task);
  }

  async decideFinding(topic: string, expectedRevision: number, input: { taskId: string; findingId: string; disposition: string; decidedBy: string }): Promise<OrchestrationHandoff> {
    if (!this.options.authorizeUserDecision?.({ kind: "finding", taskId: input.taskId, decidedBy: input.decidedBy, reason: input.disposition })) throw new Error("finding disposition requires independently authorized user-decision provenance");
    return this.mutateExpected(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "decide-finding", ...input }, this.now()));
  }

  async addCloseoutFollowUp(topic: string, expectedRevision: number, task: WorkflowTaskRevision): Promise<OrchestrationHandoff> {
    return this.mutateExpected(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "add-closeout-follow-up", task }, this.now()));
  }

  async recordManualValidation(topic: string, expectedRevision: number, outcome: { status: "approved" | "rejected"; rationale: string; decidedBy: string }): Promise<OrchestrationHandoff> {
    if (!this.options.authorizeUserDecision?.({ kind: "manual-validation", decidedBy: outcome.decidedBy, reason: outcome.rationale })) throw new Error("manual validation requires independently authorized user-decision provenance");
    return this.mutateExpected(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "record-manual-validation", outcome: { ...outcome, at: this.now() } }, this.now()));
  }

  async resetRemediation(topic: string, expectedRevision: number, input: { taskId: string; max: number; reason: string; decidedBy: string }): Promise<OrchestrationHandoff> {
    if (!this.options.authorizeUserDecision?.({ kind: "remediation-reset", taskId: input.taskId, decidedBy: input.decidedBy, reason: input.reason })) throw new Error("remediation reset requires independently authorized user-decision provenance");
    return this.mutateExpected(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "reset-remediation", ...input }, this.now()));
  }

  private async advanceCloseout(topic: string, workflow: Workflow, submission?: InitiativeVerificationSubmission): Promise<OrchestrationHandoff> {
    const inspector = this.options.closeoutInspector;
    if (!inspector) return this.handoff("blocked", workflow, "initiative closeout requires a final repository inspector");
    if (!workflow.closeout) {
      let inspection;
      try { inspection = inspector.inspect(workflow); }
      catch (error) { return this.handoff("blocked", workflow, `final repository inspection failed: ${message(error)}`); }
      if (Buffer.byteLength(inspection.cumulativeDelta) > MAX_REVIEW_DELTA_BYTES) return this.handoff("blocked", workflow, `cumulative initiative delta exceeds ${MAX_REVIEW_DELTA_BYTES} byte review packet limit`);
      const cumulativeDeltaHash = `sha256:${createHash("sha256").update(inspection.cumulativeDelta).digest("hex")}`;
      const risks = this.closeoutRisks(workflow, inspection.unresolvedRisks);
      return this.mutateStage(topic, workflow, { type: "begin-initiative-closeout", snapshot: inspection.snapshot, cumulativeDeltaHash, unresolvedRisks: risks.all, blockingRisks: risks.blocking, branchLength: this.options.parent.branchLength });
    }
    let currentInspection;
    try { currentInspection = inspector.inspect(workflow); }
    catch (error) { return this.handoff("blocked", workflow, `final repository inspection failed: ${message(error)}`); }
    if (currentInspection.snapshot.hash !== workflow.closeout.snapshot.hash || currentInspection.snapshot.head !== workflow.closeout.snapshot.head || currentInspection.snapshot.branch !== workflow.closeout.snapshot.branch) return this.mutateStage(topic, workflow, { type: "invalidate-initiative-closeout", observedSnapshot: currentInspection.snapshot, reason: "repository source, HEAD, or branch changed during closeout" });
    if (`sha256:${createHash("sha256").update(currentInspection.cumulativeDelta).digest("hex")}` !== workflow.closeout.cumulativeDeltaHash) return this.mutateStage(topic, workflow, { type: "invalidate-initiative-closeout", observedSnapshot: currentInspection.snapshot, reason: "cumulative initiative delta changed during closeout" });
    const currentRisks = this.closeoutRisks(workflow, currentInspection.unresolvedRisks);
    if (!sameStrings(currentRisks.all, workflow.closeout.unresolvedRisks) || !sameStrings(currentRisks.blocking, workflow.closeout.blockingRisks)) return this.mutateStage(topic, workflow, { type: "invalidate-initiative-closeout", observedSnapshot: currentInspection.snapshot, reason: "initiative risks changed during closeout" });
    const missing = workflow.initiativeVerification.filter((planned) => {
      const matches = workflow.closeout!.evidence.filter((evidence) => evidence.command === planned.command && evidence.args.length === planned.args.length && evidence.args.every((arg, index) => arg === planned.args[index]));
      return matches.at(-1)?.exitCode !== 0;
    });
    if (missing.length) {
      if (!submission) return {
        ...this.handoff("verification-required", workflow, "parent protected-bash final integration verification is required"),
        verification: { contractHash: workflow.contract.hash, snapshotHash: workflow.closeout.snapshot.hash, commands: missing, checkpoint: workflow.closeout.checkpoint },
      };
      if (!this.options.closeoutAuthority) return this.handoff("blocked", workflow, "final verification evidence lacks a live protected-bash closeout authority");
      let consumed: InitiativeVerificationSubmission;
      try { consumed = this.options.closeoutAuthority.consume(submission, workflow, this.options.parent); }
      catch (error) { return this.handoff("blocked", workflow, message(error)); }
      return this.mutateStage(topic, workflow, { type: "record-initiative-verification", evidence: consumed.evidence, observedSnapshot: consumed.observedSnapshot });
    }
    const acceptance = workflow.initiativeAcceptance;
    if (acceptance?.outcome === "needs-input") return workflow.closeout.manualValidation?.status === "rejected"
      ? this.handoff("blocked", workflow, "manual validation was rejected; create scoped follow-up work")
      : this.handoff("needs-input", workflow, "final acceptance requires explicit user or manual validation");
    if (acceptance && acceptance.outcome !== "approved") return this.handoff("blocked", workflow, "final acceptance requested scoped follow-up work; the orchestrator must not patch it directly");
    if (!acceptance) {
      let inspection;
      try { inspection = inspector.inspect(workflow); }
      catch (error) { return this.handoff("blocked", workflow, `final repository inspection failed: ${message(error)}`); }
      if (inspection.snapshot.hash !== workflow.closeout.snapshot.hash || inspection.snapshot.head !== workflow.closeout.snapshot.head || inspection.snapshot.branch !== workflow.closeout.snapshot.branch) return this.handoff("stale", workflow, "final repository snapshot changed before independent acceptance");
      const handoff = await this.runChildStage(topic, workflow, undefined, "final-reviewer", "initiative-acceptance", async (lease, signal) => {
        const request = this.finalAcceptanceRequest(workflow, lease, inspection);
        const result = await this.runner.run(request, { signal });
        return this.runnerOutcome(result, lease, workflow.contract.hash, "final-reviewer", workflow.closeout!.snapshot.hash);
      }, (state, outcome) => outcome.ok
        ? reduceWorkflow(state, { type: "record-initiative-acceptance", report: outcome.report }, this.now())
        : reduceWorkflow(state, { type: "record-run-failure", stage: "initiative-acceptance", reason: outcome.reason }, this.now()));
      return { ...handoff, stage: "initiative-acceptance" };
    }
    if (!this.options.closeoutAuthority) return this.handoff("blocked", workflow, "initiative completion requires the live closeout authority");
    let release: (() => void) | undefined;
    try {
      release = this.options.closeoutAuthority.acquireCompletionFence(workflow, this.options.parent);
      const completed = await this.mutateExpected(topic, workflow.revision, (state) => {
        const latest = this.options.closeoutAuthority!.assertCompletion(state, this.options.parent);
        return reduceWorkflow(state, { type: "complete-initiative", observedSnapshot: latest, branchLength: this.options.parent.branchLength }, this.now());
      });
      this.options.closeoutAuthority.assertCompletion(completed.workflow, this.options.parent);
      return completed;
    } catch (error) { return this.handoff("blocked", this.service.read(topic, true)?.workflow ?? workflow, message(error)); }
    finally { release?.(); }
  }

  private finalAcceptanceRequest(workflow: Workflow, lease: RunLease, inspection: { snapshot: NonNullable<Workflow["closeout"]>["snapshot"]; cumulativeDelta: string; unresolvedRisks: string[] }): AgentRunRequest {
    const request = this.request(workflow, undefined, "final-reviewer", lease, this.cwd, { hash: inspection.snapshot.hash, payload: { repositorySnapshot: inspection.snapshot } });
    return {
      ...request,
      projectInstructions: [...request.projectInstructions, "Assess cumulative integrated behavior only. Do not implement, patch, commit, push, deploy, or release. Request scoped follow-up work for missing behavior."],
      contractPacket: { hash: workflow.contract.hash, payload: {
        originalGoal: workflow.goal, approvedPlan: workflow.plan, cumulativeInitiativeDelta: inspection.cumulativeDelta,
        taskOutcomes: workflow.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, completedAt: task.completedAt, findings: task.findings, reports: task.reports.map((report) => ({ kind: report.kind, outcome: report.outcome, summary: report.summary })), verification: task.evidence.map((evidence) => ({ command: evidence.command, args: evidence.args, exitCode: evidence.exitCode })) })),
        unresolvedRisks: workflow.closeout!.unresolvedRisks, manualValidation: workflow.closeout!.manualValidation, finalRepositorySnapshot: inspection.snapshot,
        finalIntegrationChecks: workflow.initiativeVerification, finalVerificationEvidence: workflow.closeout!.evidence,
      } },
    };
  }

  private async advancePlanReview(topic: string, workflow: Workflow): Promise<OrchestrationHandoff> {
    const prior = workflow.planReview;
    if (prior?.provenance.contractHash === workflow.contract.hash) {
      const unanswered = prior.questions?.filter((question) => !question.answer) ?? [];
      if (prior.outcome === "needs-input" && unanswered.length) return this.handoff("needs-input", workflow, "plan review needs clarification");
      if (prior.outcome === "changes-requested" || prior.outcome === "failed") return this.handoff("blocked", workflow, "revise the current plan contract before requesting another independent review");
    }
    const handoff = await this.runChildStage(topic, workflow, undefined, "plan-reviewer", "plan-review", async (lease, signal) => {
      const result = await this.runner.run(this.request(workflow, undefined, "plan-reviewer", lease, this.cwd), { signal });
      return this.runnerOutcome(result, lease, workflow.contract.hash, "plan-reviewer");
    }, (state, outcome) => outcome.ok
      ? reduceWorkflow(state, { type: "record-plan-review", report: outcome.report }, this.now())
      : reduceWorkflow(state, { type: "record-run-failure", stage: "plan-review", reason: outcome.reason }, this.now()));
    return { ...handoff, stage: "plan-review" };
  }

  private async advanceTaskSelection(topic: string, workflow: Workflow): Promise<OrchestrationHandoff> {
    const blocked = workflow.tasks.find((task) => task.status === "blocked");
    if (blocked) {
      const unanswered = blocked.clarifications.filter((question) => !question.answer);
      if (unanswered.length) return this.handoff("needs-input", workflow, `${blocked.id} needs clarification`, blocked);
      if (blocked.phase === "remediation" && blocked.remediation.used >= blocked.remediation.max) return this.handoff("blocked", workflow, `remediation budget exhausted (${blocked.remediation.max}); explicit recorded reset or scope decision required`, blocked);
      return this.mutateStage(topic, workflow, { type: "resume" });
    }
    return this.mutateStage(topic, workflow, { type: "start" });
  }

  private async runImplementation(topic: string, workflow: Workflow, task: WorkflowTask): Promise<OrchestrationHandoff> {
    return this.runChildStage(topic, workflow, task, "implementer", "implementation", async (lease, signal) => {
      let receipt: GitWorkspaceReceipt;
      try {
        receipt = this.implementationWorkspace(workflow, task);
      } catch (error) {
        return { ok: false, reason: `workspace setup failed: ${message(error)}` };
      }
      const priorDelta = receipt.preparedResultCommit ? this.boundedDelta(receipt) : undefined;
      const request = this.request(workflow, task, "implementer", lease, receipt.path, {
        hash: receipt.snapshotHash,
        payload: {
          sourceSnapshot: receipt.snapshotHash,
          ...(priorDelta ? { cumulativeDelta: priorDelta } : {}),
          openFindings: task.findings.filter((finding) => finding.status === "open"),
        },
      });
      const result = await this.runner.run(request, { signal });
      const outcome = this.runnerOutcome(result, lease, task.contract.hash, "implementer");
      if (!outcome.ok) return outcome;
      try {
        const prepared = this.workspace.prepareIntegration(receipt);
        const preparedReport: StageReport = {
          ...outcome.report,
          changedPaths: prepared.changedPaths,
          provenance: { ...outcome.report.provenance, snapshotHash: prepared.receipt.snapshotHash },
        };
        return { ok: true, report: preparedReport, receipt: prepared.receipt };
      } catch (error) {
        return { ok: false, reason: `workspace preparation or scope validation failed: ${message(error)}` };
      }
    }, (state, outcome) => outcome.ok
      ? reduceWorkflow(state, { type: "record-implementation", report: outcome.report, receipt: outcome.receipt }, this.now())
      : reduceWorkflow(state, { type: "record-run-failure", stage: "implementation", taskId: task.id, reason: outcome.reason }, this.now()));
  }

  private async runReview(topic: string, workflow: Workflow, task: WorkflowTask, role: "general-reviewer" | "concern-reviewer"): Promise<OrchestrationHandoff> {
    const receipt = task.workspaceReceipt;
    if (!receipt?.preparedResultCommit) return this.handoff("blocked", workflow, "review requires a prepared cumulative workspace result", task);
    return this.runChildStage(topic, workflow, task, role, task.phase, async (lease, signal) => {
      let delta: string;
      try { delta = this.boundedDelta(receipt as GitWorkspaceReceipt); }
      catch (error) { return { ok: false, reason: `cumulative review delta unavailable: ${message(error)}` }; }
      const selectedConcerns = task.approaches.filter((approach) => CONCERN_APPROACHES.has(approach));
      const request = this.request(workflow, task, role, lease, receipt.path!, {
        hash: receipt.snapshotHash,
        payload: {
          taskId: task.id,
          cumulativeDelta: delta,
          relevantFiles: receipt.changedPaths,
          openFindings: task.remediation.used ? task.findings.filter((finding) => finding.status === "open") : [],
          objectiveEvidence: task.evidence.map((item) => ({ command: item.command, args: item.args, exitCode: item.exitCode, advisory: true })),
        },
      }, selectedConcerns);
      const result = await this.runner.run(request, { signal });
      const outcome = this.runnerOutcome(result, lease, task.contract.hash, role, receipt.snapshotHash);
      if (!outcome.ok) return outcome;
      const implementation = [...task.reports].reverse().find((report) => report.kind === "implementation");
      if (implementation && (implementation.provenance.actorId === outcome.report.provenance.actorId || implementation.provenance.runId === outcome.report.provenance.runId)) return { ok: false, reason: "self-review is not permitted" };
      const general = [...task.reports].reverse().find((report) => report.kind === "general-review");
      if (role === "concern-reviewer" && general && (general.provenance.actorId === outcome.report.provenance.actorId || general.provenance.runId === outcome.report.provenance.runId)) return { ok: false, reason: "specialist review requires a distinct fresh actor" };
      return outcome;
    }, (state, outcome) => outcome.ok
      ? reduceWorkflow(state, { type: "record-review", report: outcome.report }, this.now())
      : reduceWorkflow(state, { type: "record-run-failure", stage: task.phase, taskId: task.id, reason: outcome.reason }, this.now()));
  }

  private async integrate(topic: string, workflow: Workflow, task: WorkflowTask): Promise<OrchestrationHandoff> {
    return this.runChildStage(topic, workflow, task, undefined, "integration", async () => {
      try {
        const prepared = this.workspace.resumePreparedIntegration(task.workspaceReceipt as GitWorkspaceReceipt);
        return { ok: true, receipt: this.workspace.integrate(prepared, this.now()) } as const;
      } catch (error) {
        return { ok: false, reason: `integration failed: ${message(error)}` } as const;
      }
    }, (state, outcome) => outcome.ok
      ? reduceWorkflow(state, { type: "record-integration", receipt: outcome.receipt }, this.now())
      : reduceWorkflow(state, { type: "record-run-failure", stage: "integration", taskId: task.id, reason: outcome.reason }, this.now()));
  }

  private async verify(topic: string, workflow: Workflow, task: WorkflowTask, verification?: OrchestrationAdvanceInput["verification"]): Promise<OrchestrationHandoff> {
    if (!verification) return {
      ...this.handoff("verification-required", workflow, "parent protected-bash verification is required", task),
      verification: { contractHash: task.contract.hash, snapshotHash: task.integrationReceipt?.postSnapshotHash ?? task.workspaceReceipt!.snapshotHash, commands: task.verification, checkpoint: task.verificationCheckpoint },
    };
    if (!this.options.verificationAuthority) return this.handoff("blocked", workflow, "verification evidence lacks a live protected-bash authority", task);
    let protectedResult: ProtectedVerificationSubmission;
    try { protectedResult = this.options.verificationAuthority.consume(verification, workflow, task, this.options.parent); }
    catch (error) { return this.handoff("blocked", workflow, message(error), task); }
    const expectedSnapshot = task.integrationReceipt?.postSnapshotHash ?? task.workspaceReceipt?.snapshotHash;
    const sourceChanged = protectedResult.sourceChanged || protectedResult.afterSnapshotHash !== expectedSnapshot;
    const observedChangedPaths = protectedResult.observedChangedPaths;
    if (sourceChanged && !observedChangedPaths.length) return this.handoff("needs-input", workflow, "source-changing verification requires explicit changed paths before cumulative remediation", task);
    const event = protectedResult.evidence.exitCode !== 0 || sourceChanged
      ? { type: "record-verification-failure" as const, evidence: protectedResult.evidence, observedSnapshotHash: protectedResult.afterSnapshotHash, observedChangedPaths, reason: sourceChanged ? `expected ${expectedSnapshot}, observed ${protectedResult.afterSnapshotHash}` : `command exited ${protectedResult.evidence.exitCode}` }
      : { type: "record-verification" as const, evidence: protectedResult.evidence };
    return this.mutateStage(topic, workflow, event);
  }

  private implementationWorkspace(workflow: Workflow, task: WorkflowTask): GitWorkspaceReceipt {
    if (task.remediation.used > 0 && task.integrationReceipt && task.workspaceReceipt) {
      const sourceChanged = task.findings.some((finding) => finding.status === "open" && finding.summary === "verification changed the protected source snapshot");
      return sourceChanged
        ? this.workspace.createDriftRemediationWorkspace(task.workspaceReceipt as GitWorkspaceReceipt, task.integrationReceipt as GitIntegrationReceipt, this.id("workspace"), task.verificationDriftPaths)
        : this.workspace.createRemediationWorkspace(task.workspaceReceipt as GitWorkspaceReceipt, task.integrationReceipt as GitIntegrationReceipt, this.id("workspace"));
    }
    if (task.workspaceReceipt) return task.workspaceReceipt as GitWorkspaceReceipt;
    return this.workspace.createWorkspace({ topic: workflow.topic, taskId: task.id, writeScope: task.writeScope, workspaceId: this.id("workspace") });
  }

  private async runChildStage<T extends ChildOutcome | { ok: true; receipt: GitIntegrationReceipt }>(
    topic: string,
    workflow: Workflow,
    task: WorkflowTask | undefined,
    role: RunnerRole | undefined,
    stage: RunLease["stage"],
    child: (lease: RunLease, signal: AbortSignal) => Promise<T>,
    settle: (workflow: Workflow, result: T) => WorkflowDecision,
  ): Promise<OrchestrationHandoff> {
    const runId = this.id(role ?? String(stage));
    const priorProvenance = [workflow.planReview, workflow.initiativeAcceptance, ...workflow.tasks.flatMap((candidate) => candidate.reports)].filter((report): report is StageReport => !!report).map((report) => report.provenance).concat(workflow.orchestration.history.flatMap((entry) => entry.provenance ? [entry.provenance] : []));
    const actorId = role ? `${role}:${runId}` : undefined;
    if (priorProvenance.some((item) => item.runId === runId || (actorId && item.actorId === actorId))) return this.handoff("blocked", workflow, "fresh child run and actor identities must not be reused", task, role);
    let claimed: { workflow: Workflow; lease: RunLease };
    try {
      claimed = await this.service.claimRun(topic, workflow.revision, { ownerId: this.options.ownerId, runId, stage, ...(task ? { taskId: task.id } : {}), ttlMs: 60 * 60 * 1_000, now: this.now() });
    } catch (error) {
      return this.staleOrThrow(topic, error);
    }
    const controller = new AbortController();
    const registry = this.options.runtimeRegistry ?? sweRuntimeRegistry;
    registry.begin({ topic, runId, ...(role ? { role } : {}), stage, ...(task ? { taskId: task.id } : {}), provider: this.options.provider, model: this.options.model, startedAt: this.now(), outcome: "running", controller });
    let outcome: T;
    try { outcome = await child(claimed.lease, controller.signal); }
    catch (error) { outcome = { ok: false, reason: `orchestration infrastructure failure: ${message(error)}` } as T; }
    registry.settle(topic, runId, {
      outcome: outcome.ok && "report" in outcome ? classifyReportOutcome(outcome.report) : outcome.ok ? "completed" : classifyRuntimeOutcome(outcome.reason), completedAt: this.now(),
      reportTail: outcome.ok && "report" in outcome ? outcome.report.summary : outcome.ok ? "integration receipt recorded" : outcome.reason,
      outputTail: outcome.ok && "report" in outcome ? outcome.report.rationale : undefined,
    });
    try {
      const decision = await this.service.settleRun(topic, claimed.workflow.revision, claimed.lease, (state) => settle(state, outcome));
      const resolvedTask = task ? decision.workflow.tasks.find((candidate) => candidate.id === task.id) : undefined;
      const report = outcome.ok && "report" in outcome ? outcome.report : undefined;
      const kind: OrchestrationHandoff["kind"] = report?.outcome === "needs-input" ? "needs-input"
        : !outcome.ok || decision.workflow.status === "blocked" ? "blocked" : "advanced";
      return this.handoff(kind, decision.workflow, decision.message, resolvedTask, role);
    } catch (error) {
      const text = message(error);
      if (/workflow changed|stale run lease|already active|run lease .* active/i.test(text)) return this.staleOrThrow(topic, error);
      try {
        const failed = await this.service.settleRun(topic, claimed.workflow.revision, claimed.lease, (state) => reduceWorkflow(state, {
          type: "record-run-failure", stage, ...(task ? { taskId: task.id } : {}), reason: `rejected child result: ${text}`,
        }, this.now()));
        const resolvedTask = task ? failed.workflow.tasks.find((candidate) => candidate.id === task.id) : undefined;
        return this.handoff("blocked", failed.workflow, failed.message, resolvedTask, role);
      } catch (settleError) {
        return this.staleOrThrow(topic, settleError);
      }
    }
  }

  private runnerOutcome(result: RunnerResult, lease: RunLease, contractHash: string, role: RunnerRole, snapshotHash?: string): ChildOutcome {
    if (!result.ok) return { ok: false, reason: `${result.failure.code}: ${result.failure.message}` };
    const provenance = result.report.provenance;
    if (provenance.runId !== lease.runId || provenance.leaseId !== lease.id || provenance.leaseFence !== lease.fence || provenance.role !== role || provenance.contractHash !== contractHash) return { ok: false, reason: "child report has stale or mismatched fenced provenance" };
    if (provenance.actorId !== `${role}:${lease.runId}`) return { ok: false, reason: "child report actor identity does not match the fresh assigned actor" };
    if (snapshotHash !== undefined && provenance.snapshotHash !== snapshotHash) return { ok: false, reason: "child report does not match the assigned cumulative source snapshot" };
    return { ok: true, report: result.report };
  }

  private request(workflow: Workflow, task: WorkflowTask | undefined, role: RunnerRole, lease: RunLease, cwd: string, snapshotPacket?: AgentRunRequest["snapshotPacket"], selectedConcerns: WorkflowApproach[] = []): AgentRunRequest {
    const contract = task?.contract ?? workflow.contract;
    const clarificationAnswers = (task?.clarifications ?? workflow.planReview?.questions ?? []).filter((question) => question.answer).map((question) => ({ id: question.id, question: question.question, answer: question.answer!, answeredBy: question.answeredBy, answeredAt: question.answeredAt }));
    return {
      role, runId: lease.runId, actorId: `${role}:${lease.runId}`, lease, cwd,
      provider: this.options.provider, model: this.options.model, thinking: this.options.thinking,
      projectInstructions: [
        "Follow the immutable contract and report blockers instead of expanding scope.",
        ...(role === "general-reviewer" ? ["Review requirements, test adequacy, TDD, diagnosis, and DSA; do not limit review to style."] : []),
        ...(this.options.projectInstructions ?? []),
      ],
      ...(this.options.approvedSkills ? { approvedSkills: this.options.approvedSkills } : {}),
      ...(this.options.trustedExtensions ? { trustedExtensions: this.options.trustedExtensions } : {}),
      contractPacket: {
        hash: contract.hash,
        payload: task ? {
          planContractHash: workflow.contract.hash, task: { id: task.id, title: task.title, kind: task.kind, dependsOn: task.dependsOn, acceptance: task.acceptance, approaches: task.approaches, approachReasons: task.approachReasons, writeScope: task.writeScope, nonGoals: task.nonGoals, verification: task.verification },
          ...(selectedConcerns.length ? { selectedConcerns } : {}),
        } : { goal: workflow.goal, plan: workflow.plan, initiativeVerification: workflow.initiativeVerification, tasks: workflow.tasks.map((item) => ({ id: item.id, title: item.title, dependsOn: item.dependsOn, acceptance: item.acceptance, approaches: item.approaches, writeScope: item.writeScope, nonGoals: item.nonGoals, verification: item.verification })) },
      },
      ...(snapshotPacket ? { snapshotPacket } : {}), clarificationAnswers,
      readScope: this.options.readScope ?? ["**"], ...(role === "implementer" ? { writeScope: task!.writeScope } : {}),
      budgets: this.options.budgets ?? { timeoutMs: 30 * 60 * 1_000, maxTurns: 32, maxOutputBytes: 2 * 1024 * 1024, maxRetries: 1, killGraceMs: 2_000 },
    };
  }

  private closeoutRisks(workflow: Workflow, inspectorRisks: string[]): { all: string[]; blocking: string[] } {
    const open = workflow.tasks.flatMap((task) => task.findings.filter((finding) => finding.status === "open").map((finding) => ({ text: `${task.id}/${finding.id} [${finding.severity}]: ${finding.summary}`, blocking: finding.severity === "blocking" })));
    return { all: [...new Set([...inspectorRisks, ...open.map((item) => item.text)])], blocking: [...new Set([...inspectorRisks, ...open.filter((item) => item.blocking).map((item) => item.text)])] };
  }

  private boundedDelta(receipt: GitWorkspaceReceipt): string {
    const delta = this.workspace.cumulativeDiff(receipt);
    if (delta.byteLength > MAX_REVIEW_DELTA_BYTES) throw new Error(`cumulative delta exceeds ${MAX_REVIEW_DELTA_BYTES} byte review packet limit`);
    return delta.toString("utf8");
  }

  private async mutateStage(topic: string, workflow: Workflow, event: Parameters<typeof reduceWorkflow>[1]): Promise<OrchestrationHandoff> {
    return this.mutateExpected(topic, workflow.revision, (state) => reduceWorkflow(state, event, this.now()));
  }

  private async mutateExpected(topic: string, expectedRevision: number, reducer: (workflow: Workflow) => WorkflowDecision): Promise<OrchestrationHandoff> {
    try {
      const decision = await this.service.mutate(topic, expectedRevision, reducer);
      const task = decision.workflow.activeTask ? decision.workflow.tasks.find((candidate) => candidate.id === decision.workflow.activeTask) : decision.workflow.tasks.find((candidate) => candidate.status === "blocked");
      return this.handoff(decision.workflow.status === "blocked" ? "blocked" : decision.workflow.status === "complete" ? "complete" : "advanced", decision.workflow, decision.message, task);
    } catch (error) {
      return this.staleOrThrow(topic, error);
    }
  }

  private staleOrThrow(topic: string, error: unknown): OrchestrationHandoff {
    const text = message(error);
    if (/workflow changed|stale run lease|already active|run lease .* active/i.test(text)) {
      const workflow = this.service.read(topic, true)?.workflow;
      if (!workflow) throw error;
      return this.handoff("stale", workflow, text);
    }
    throw error;
  }

  private handoff(kind: OrchestrationHandoff["kind"], workflow: Workflow, messageText: string, task?: WorkflowTask, role?: RunnerRole): OrchestrationHandoff {
    const stage = workflow.orchestration.phase === "complete" ? "complete"
      : workflow.orchestration.phase === "initiative-acceptance" ? "initiative-acceptance"
      : task?.phase ?? (workflow.orchestration.phase === "plan-review" ? "plan-review" : "pending");
    return { kind, stage, message: messageText, workflow, ...(task ? { taskId: task.id } : {}), ...(role ? { role } : {}) };
  }

  private assertParent(workflow: Workflow): void {
    const parent = workflow.orchestration.parent;
    if (!parent?.valid || parent.ownerId !== this.options.ownerId || parent.sessionId !== this.options.parent.sessionId || parent.runtimeId !== this.options.parent.runtimeId || parent.cwd !== this.cwd) throw new Error("managed workflow belongs to a competing or stale parent session/runtime");
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private id(prefix: string): string { return this.options.id?.(prefix) ?? `${prefix}-${randomUUID()}`; }
}

function classifyReportOutcome(report: StageReport): RunOutcome {
  if (report.outcome === "changes-requested") return "changes-requested";
  if (report.outcome === "needs-input" || report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) return "blocked";
  if (report.outcome === "failed") return "crashed";
  return "completed";
}
function classifyRuntimeOutcome(reason: string): RunOutcome {
  if (/cancel/i.test(reason)) return "cancelled";
  if (/deadline|timed?[- ]?out|timeout/i.test(reason)) return "timed-out";
  if (/changes.requested/i.test(reason)) return "changes-requested";
  if (/interrupt|orphan|expired|stale/i.test(reason)) return "interrupted";
  if (/spawn|crash|premature|nonzero|model-error|missing-report|malformed|infrastructure/i.test(reason)) return "crashed";
  return "blocked";
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameStrings(left: string[], right: string[]): boolean { const sorted = [...right].sort(); return left.length === right.length && [...left].sort().every((item, index) => item === sorted[index]); }
