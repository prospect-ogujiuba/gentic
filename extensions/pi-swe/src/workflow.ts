import { createHash } from "node:crypto";

export const WORKFLOW_VERSION = 2 as const;
export const LEGACY_WORKFLOW_VERSION = 1 as const;

export type WorkflowStatus = "draft" | "active" | "paused" | "blocked" | "complete";
export type TaskStatus = "pending" | "active" | "blocked" | "deferred" | "complete";
export const WORKFLOW_APPROACHES = ["tdd", "diagnosis", "dsa", "security", "performance", "migration", "accessibility-ux", "operations"] as const;
export type WorkflowApproach = typeof WORKFLOW_APPROACHES[number];
export type ApproachReasons = Partial<Record<WorkflowApproach, string>>;
export type AssessmentStatus = "assessed" | "unassessed";
export type VerificationCheckpoint = { revision: number; at: string; sessionId?: string; branchLength?: number };
export type ContractIdentity = { revision: number; hash: string; linkedPlanHash?: string };
export type TaskKind = "implementation" | "coordination";
export type TaskPhase = "pending" | "implementation" | "general-review" | "concern-review" | "remediation" | "workspace" | "integration" | "verification" | "ready-to-complete" | "historical";
export type WorkflowPhase = "plan-review" | "task-execution" | "initiative-acceptance" | "complete";
export type RunnerRole = "plan-reviewer" | "implementer" | "general-reviewer" | "concern-reviewer" | "final-reviewer";

export type RunnerProvenance = {
  runId: string;
  role: RunnerRole;
  actorId: string;
  leaseId: string;
  leaseFence: number;
  contractHash: string;
  snapshotHash?: string;
  startedAt: string;
  completedAt: string;
};
export type Finding = {
  id: string;
  severity: "blocking" | "warning";
  status: "open" | "resolved" | "accepted-risk";
  summary: string;
  evidence: string;
  disposition?: string;
};
export type Clarification = {
  id: string;
  question: string;
  askedByRunId: string;
  askedAt: string;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
};
export type StageReport = {
  kind: "plan-review" | "implementation" | "general-review" | "concern-review" | "final-acceptance";
  outcome: "approved" | "changes-requested" | "needs-input" | "completed" | "no-change" | "failed";
  summary: string;
  rationale?: string;
  changedPaths?: string[];
  findings: Finding[];
  questions?: Clarification[];
  provenance: RunnerProvenance;
};
export type WorkspaceReceipt = { workspaceId: string; baselineHash: string; snapshotHash: string; changedPaths: string[]; createdAt: string };
export type IntegrationReceipt = { integrationId: string; preSnapshotHash: string; postSnapshotHash: string; patchHash: string; integratedAt: string };
export type RunLease = {
  id: string;
  runId: string;
  ownerId: string;
  stage: WorkflowPhase | TaskPhase;
  taskId?: string;
  fence: number;
  acquiredAt: string;
  expiresAt: string;
};
export type HistoryEntry = { id: string; type: string; at: string; summary: string; taskId?: string; provenance?: RunnerProvenance; auditCritical?: boolean };

export type VerificationCommand = { command: string; args: string[] };
export type VerificationEvidence = VerificationCommand & {
  exitCode: number;
  at: string;
  contractHash?: string;
  snapshotHash?: string;
  source?: { kind: "bash-tool-result"; toolCallId: string; workflowRevision: number; sessionId?: string };
};
export type ImportedTaskProvenance = {
  kind: "pi-swe-v2-contract";
  contractPath: string;
  contentHash?: string;
  completion?: {
    schemaVersion?: number; requestId?: string; completedAt?: string; planRevision?: number; contractPath?: string;
    preCompletionContentHash?: string; verificationPath?: string; verificationContentHash?: string;
    reviewPath?: string; reviewContentHash?: string; reviewDecision?: string; nextInitiativeState?: string;
    nextActiveContractId?: string | null; nextReadyContractIds?: string[];
  };
};

export type WorkflowTask = {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  phase: TaskPhase;
  dependsOn: string[];
  acceptance: string[];
  approaches: WorkflowApproach[];
  approachReasons: ApproachReasons;
  assessmentStatus: AssessmentStatus;
  writeScope: string[];
  nonGoals: string[];
  contract: ContractIdentity;
  verification: VerificationCommand[];
  verificationDecision?: { kind: "manual"; rationale: string; decidedBy: string; at: string };
  verificationCheckpoint?: VerificationCheckpoint;
  evidence: VerificationEvidence[];
  evidenceLinks: string[];
  reports: StageReport[];
  clarifications: Clarification[];
  findings: Finding[];
  remediation: { used: number; max: number };
  workspaceReceipt?: WorkspaceReceipt;
  integrationReceipt?: IntegrationReceipt;
  blockedReason?: string;
  completedAt?: string;
  importedFrom?: ImportedTaskProvenance;
};

export type Workflow = {
  version: typeof WORKFLOW_VERSION;
  topic: string;
  revision: number;
  status: WorkflowStatus;
  goal: string;
  plan?: string;
  contract: ContractIdentity;
  orchestration: { mode: "legacy" | "multi-agent"; phase: WorkflowPhase; nextFence: number; activeRun?: RunLease; history: HistoryEntry[] };
  planReview?: StageReport;
  initiativeAcceptance?: StageReport;
  activeTask?: string;
  tasks: WorkflowTask[];
  updatedAt: string;
  migration?: { sourceVersion: 1; readAt: string; historicalTaskIds: string[] };
  importedFrom?: { kind: "pi-swe-v2"; manifestPath: string; planRevision?: number };
};

export type WorkflowEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "block"; reason: string }
  | { type: "record-plan-review"; report: StageReport }
  | { type: "record-implementation"; report: StageReport }
  | { type: "record-review"; report: StageReport }
  | { type: "record-workspace"; receipt: WorkspaceReceipt }
  | { type: "record-integration"; receipt: IntegrationReceipt }
  | { type: "record-verification"; evidence: VerificationEvidence }
  | { type: "complete-task"; allowGap?: boolean }
  | { type: "record-initiative-acceptance"; report: StageReport }
  | { type: "complete-initiative" }
  | { type: "claim-run"; lease: RunLease }
  | { type: "cancel-run"; lease: RunLease; reason: string };

export type WorkflowDecision = { workflow: Workflow; changed: boolean; message: string };
export type WorkflowTaskRevision = Pick<WorkflowTask, "id" | "title"> & Partial<Pick<WorkflowTask, "kind" | "dependsOn" | "acceptance" | "approaches" | "approachReasons" | "writeScope" | "nonGoals" | "verification" | "verificationDecision">>;

const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SCOPE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;
const MAX_TASKS = 100;
const MAX_TEXT = 2048;
const MAX_REPORTS = 16;
const MAX_FINDINGS = 64;
const MAX_HISTORY = 128;
const MAX_WORKFLOW_BYTES = 512 * 1024;
const CONCERN_APPROACHES = new Set<WorkflowApproach>(["security", "migration", "performance", "accessibility-ux", "operations"]);

export function isValidTopic(value: string): boolean { return value.length <= 256 && TOPIC.test(value); }

export function createWorkflow(input: {
  topic: string;
  goal: string;
  plan?: string;
  linkedPlanContent?: string;
  tasks: Array<Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">>;
  now?: string;
}): Workflow {
  validateWorkflowInput(input.topic, input.goal, input.plan, input.tasks.length);
  const now = validTimestamp(input.now ?? new Date().toISOString(), "workflow timestamp");
  const mode = input.tasks.some((task) => task.writeScope !== undefined || task.nonGoals !== undefined) ? "multi-agent" : "legacy";
  const contract = planIdentity(input.goal.trim(), input.plan?.trim(), input.linkedPlanContent, 1);
  const tasks = input.tasks.map((task) => normalizeTask(task, { contract, compatibility: false }));
  validateTaskGraph(tasks);
  return {
    version: WORKFLOW_VERSION, topic: input.topic, revision: 1, status: "draft", goal: input.goal.trim(),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}), contract,
    orchestration: { mode, phase: mode === "multi-agent" ? "plan-review" : "task-execution", nextFence: 1, history: [] },
    tasks, updatedAt: now,
  };
}

/** Parse v2 or create a non-persisted v2 compatibility view of v1. */
export function parseWorkflow(value: unknown, readAt = new Date().toISOString()): Workflow {
  if (!record(value)) throw new Error("unsupported workflow version");
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error("workflow state is not serializable"); }
  if (Buffer.byteLength(serialized) > MAX_WORKFLOW_BYTES) throw new Error(`workflow exceeds ${MAX_WORKFLOW_BYTES} byte store limit`);
  if (value.version === LEGACY_WORKFLOW_VERSION) return upgradeV1View(value, readAt);
  if (value.version !== WORKFLOW_VERSION) throw new Error("unsupported workflow version");
  return parseV2(value);
}

export function reviseWorkflow(workflow: Workflow, input: { goal?: string; plan?: string; linkedPlanContent?: string; tasks: WorkflowTaskRevision[] }, now = new Date().toISOString()): WorkflowDecision {
  if (!input.tasks.length || input.tasks.length > MAX_TASKS) throw new Error("revised workflow requires 1 to 100 tasks");
  const proposedIds = new Set(input.tasks.map((task) => task.id));
  for (const task of workflow.tasks) if (["complete", "active", "blocked"].includes(task.status) && !proposedIds.has(task.id)) throw new Error(`cannot remove ${task.status} task ${task.id}`);
  const goal = input.goal === undefined ? workflow.goal : input.goal.trim();
  if (!goal || goal.length > MAX_TEXT) throw new Error(goal ? "goal exceeds 2048 characters" : "goal is required");
  const plan = input.plan === undefined ? workflow.plan : input.plan.trim() || undefined;
  if (plan && plan.length > MAX_TEXT) throw new Error("plan exceeds 2048 characters");
  const linkedPlanContent = input.linkedPlanContent !== undefined
    ? input.linkedPlanContent
    : input.plan !== undefined
      ? undefined
      : workflow.contract.linkedPlanHash;
  const nextPlan = planIdentity(goal, plan, linkedPlanContent, workflow.contract.revision);
  const contract = nextPlan.hash === workflow.contract.hash ? workflow.contract : { ...nextPlan, revision: workflow.contract.revision + 1 };
  const existing = new Map(workflow.tasks.map((task) => [task.id, task]));
  const tasks = input.tasks.map((revision) => {
    const previous = existing.get(revision.id);
    const normalized = normalizeTask(revision, { contract, compatibility: false, previousContract: previous?.contract });
    if (!previous) return normalized;
    if (previous.status === "complete") return { ...previous, phase: "historical" as const };
    const contractChanged = normalized.contract.hash !== previous.contract.hash;
    return {
      ...normalized,
      status: previous.status,
      phase: contractChanged ? "pending" as const : previous.phase,
      evidence: contractChanged ? [] : previous.evidence,
      reports: contractChanged ? [] : previous.reports,
      clarifications: contractChanged ? [] : previous.clarifications,
      findings: contractChanged ? [] : previous.findings,
      remediation: contractChanged ? { used: 0, max: previous.remediation.max } : previous.remediation,
      ...(!contractChanged && previous.verificationCheckpoint ? { verificationCheckpoint: previous.verificationCheckpoint } : {}),
      ...(!contractChanged && previous.workspaceReceipt ? { workspaceReceipt: previous.workspaceReceipt } : {}),
      ...(!contractChanged && previous.integrationReceipt ? { integrationReceipt: previous.integrationReceipt } : {}),
      ...(previous.blockedReason ? { blockedReason: previous.blockedReason } : {}),
      ...(previous.importedFrom ? { importedFrom: previous.importedFrom } : {}),
    };
  });
  validateTaskGraph(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const activeTask = workflow.activeTask ? byId.get(workflow.activeTask) : undefined;
  if (activeTask?.dependsOn.some((id) => !["complete", "deferred"].includes(byId.get(id)!.status))) throw new Error(`active task ${activeTask.id} cannot depend on unfinished work`);
  const anyContractChange = contract.hash !== workflow.contract.hash || tasks.some((task) => task.contract.hash !== existing.get(task.id)?.contract.hash);
  const allDone = tasks.every((task) => ["complete", "deferred"].includes(task.status));
  const status: WorkflowStatus = allDone && !anyContractChange ? workflow.status : activeTask ? (anyContractChange || workflow.status === "paused" ? "paused" : "active") : workflow.status === "blocked" ? "blocked" : "draft";
  return changed(workflow, {
    goal, ...(plan ? { plan } : { plan: undefined }), contract, tasks, status,
    ...(anyContractChange ? { planReview: undefined, initiativeAcceptance: undefined, orchestration: { ...workflow.orchestration, phase: "plan-review", activeRun: undefined } } : {}),
  }, now, "workflow plan revised");
}

export function bindVerificationCheckpoint(workflow: Workflow, sessionId: string, branchLength: number): Workflow {
  if (workflow.status !== "active" || !workflow.activeTask) return workflow;
  return { ...workflow, tasks: workflow.tasks.map((task) => task.id === workflow.activeTask && task.assessmentStatus === "assessed" && task.verificationCheckpoint ? { ...task, verificationCheckpoint: { ...task.verificationCheckpoint, sessionId, branchLength } } : task) };
}

export function readyTasks(workflow: Workflow): WorkflowTask[] {
  const complete = new Set(workflow.tasks.filter((task) => ["complete", "deferred"].includes(task.status)).map((task) => task.id));
  return workflow.tasks.filter((task) => task.status === "pending" && task.dependsOn.every((id) => complete.has(id)));
}

export function reduceWorkflow(workflow: Workflow, event: WorkflowEvent, now = new Date().toISOString()): WorkflowDecision {
  const decision = reduceWorkflowStep(workflow, event, now);
  if (!decision.changed) return decision;
  const revision = workflow.revision + 1;
  return {
    ...decision,
    workflow: {
      ...decision.workflow,
      revision,
      updatedAt: now,
      tasks: decision.workflow.tasks.map((task) => task.verificationCheckpoint && task.verificationCheckpoint.revision > revision
        ? { ...task, verificationCheckpoint: { ...task.verificationCheckpoint, revision } }
        : task),
    },
  };
}

function reduceWorkflowStep(workflow: Workflow, event: WorkflowEvent, now: string): WorkflowDecision {
  validTimestamp(now, "workflow timestamp");
  if (event.type === "claim-run") return claimRun(workflow, event.lease, now);
  if (event.type === "cancel-run") return cancelRun(workflow, event.lease, event.reason, now);
  if (event.type === "pause") {
    if (workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
    return update(workflow, { status: "paused" }, now, "workflow paused");
  }
  if (event.type === "record-plan-review") return recordPlanReview(workflow, event.report, now);
  if (workflow.orchestration.mode === "legacy") return reduceLegacyWorkflow(workflow, event, now);
  return reduceOrchestratedWorkflow(workflow, event, now);
}

function reduceOrchestratedWorkflow(workflow: Workflow, event: Exclude<WorkflowEvent, { type: "claim-run" | "cancel-run" | "pause" | "record-plan-review" }>, now: string): WorkflowDecision {
  const current = activeTask(workflow);
  if ((event.type === "start" || event.type === "resume") && workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
  if (event.type !== "block" && !approvedReport(workflow.planReview, workflow.contract.hash)) throw new Error("current plan contract requires independent plan review approval before task execution");
  if (["record-implementation", "record-review", "record-workspace", "record-integration", "record-verification", "complete-task"].includes(event.type) && workflow.status !== "active") throw new Error("task stage mutation requires an active workflow");
  if (event.type === "start" || event.type === "resume") {
    const next = current ?? (event.type === "resume" ? workflow.tasks.find((task) => task.status === "blocked") : undefined) ?? readyTasks(workflow)[0];
    if (!next) return unchanged(workflow, "no dependency-ready task is available");
    if (next.assessmentStatus === "unassessed") return unchanged(workflow, `${next.id} is unassessed; revise the workflow before execution`);
    if (next.kind === "implementation" && !next.writeScope.length) return blockForDecision(workflow, next, "implementation task has no write scope; revise it before execution", now);
    if (next.kind === "implementation" && !next.verification.length && !next.verificationDecision) return blockForDecision(workflow, next, "implementation task has no objective verification; an explicit manual-validation decision is required", now);
    const remediation = next.phase === "remediation" ? { used: next.remediation.used + 1, max: next.remediation.max } : next.remediation;
    if (remediation.used > remediation.max) return blockForDecision(workflow, next, `remediation budget exhausted (${next.remediation.max}); explicit reset or scope decision required`, now);
    const phase = current && workflow.status === "paused" && current.status === "active" ? current.phase : "implementation";
    return replaceTask(workflow, next.id, { status: "active", phase, remediation, blockedReason: undefined, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active", activeTask: next.id, orchestration: { ...workflow.orchestration, phase: "task-execution" } }, now, `${event.type === "resume" ? "resumed" : "started"} ${next.id}`);
  }
  if (event.type === "block") {
    if (!current) return unchanged(workflow, "no active task to block");
    return replaceTask(workflow, current.id, { status: "blocked", blockedReason: boundedText(event.reason, "blocked reason") || "blocked" }, { status: "blocked", activeTask: undefined }, now, `${current.id} blocked`);
  }
  if (event.type === "record-implementation") {
    requireTaskPhase(current, "implementation");
    const report = normalizeReport(event.report);
    requireReport(report, "implementation", "implementer", current!.contract.hash, workflow.orchestration.activeRun);
    if (workflow.planReview && (workflow.planReview.provenance.runId === report.provenance.runId || workflow.planReview.provenance.actorId === report.provenance.actorId)) throw new Error("plan self-review by the implementer is not permitted");
    if (report.changedPaths?.some((path) => !scopeAllows(current!.writeScope, path))) throw new Error("implementation report contains an out-of-scope path");
    if (report.outcome === "no-change" && (!report.rationale || report.rationale.length < 8 || report.changedPaths?.length)) throw new Error("no-change implementation requires explicit rationale and no changed paths");
    if (!['completed', 'no-change', 'needs-input', 'failed'].includes(report.outcome)) throw new Error("invalid implementation outcome");
    const patch: Partial<WorkflowTask> = appendTaskReport(current!, report);
    if (report.outcome === "needs-input") return replaceTask(workflow, current!.id, { ...patch, status: "blocked", phase: "remediation", blockedReason: "implementation needs clarification" }, { status: "blocked", activeTask: undefined }, now, `${current!.id} needs input`);
    if (report.outcome === "failed") return replaceTask(workflow, current!.id, { ...patch, status: "blocked", phase: "remediation", blockedReason: "implementation failed" }, { status: "blocked", activeTask: undefined }, now, `${current!.id} implementation failed`);
    return replaceTask(workflow, current!.id, { ...patch, phase: "general-review" }, {}, now, `recorded implementation report for ${current!.id}`);
  }
  if (event.type === "record-review") {
    if (!current || !["general-review", "concern-review"].includes(current.phase)) throw new Error("review report is not valid in the current task stage");
    const expectedKind = current.phase === "general-review" ? "general-review" : "concern-review";
    const expectedRole = current.phase === "general-review" ? "general-reviewer" : "concern-reviewer";
    const report = normalizeReport(event.report);
    requireReport(report, expectedKind, expectedRole, current.contract.hash, workflow.orchestration.activeRun);
    const implementation = current.reports.find((item) => item.kind === "implementation");
    if (!implementation) throw new Error("review requires an implementation report");
    if (implementation.provenance.runId === report.provenance.runId || implementation.provenance.actorId === report.provenance.actorId) throw new Error("self-review is not permitted");
    if (!implementation.provenance.snapshotHash || report.provenance.snapshotHash !== implementation.provenance.snapshotHash) throw new Error("review report has a stale source snapshot");
    const patch = appendTaskReport(current, report);
    const unresolved = report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open");
    if (report.outcome === "changes-requested" || unresolved) return replaceTask(workflow, current.id, { ...patch, status: "blocked", phase: "remediation", blockedReason: "review has unresolved blocking findings" }, { status: "blocked", activeTask: undefined }, now, `${current.id} requires remediation`);
    if (report.outcome !== "approved") throw new Error("review must approve, request changes, or report blocking findings");
    const nextPhase: TaskPhase = current.phase === "general-review" && requiresConcernReview(current) ? "concern-review" : implementation.outcome === "no-change" ? "ready-to-complete" : "workspace";
    return replaceTask(workflow, current.id, { ...patch, phase: nextPhase }, {}, now, `recorded ${expectedKind} for ${current.id}`);
  }
  if (event.type === "record-workspace") {
    requireTaskPhase(current, "workspace");
    const receipt = normalizeWorkspaceReceipt(event.receipt);
    if (receipt.changedPaths.some((path) => !scopeAllows(current!.writeScope, path))) throw new Error("workspace receipt contains an out-of-scope path");
    return replaceTask(workflow, current!.id, { workspaceReceipt: receipt, phase: "integration" }, {}, now, `recorded workspace receipt for ${current!.id}`);
  }
  if (event.type === "record-integration") {
    requireTaskPhase(current, "integration");
    const receipt = normalizeIntegrationReceipt(event.receipt);
    if (receipt.preSnapshotHash !== current!.workspaceReceipt?.baselineHash) throw new Error("integration receipt does not match the workspace baseline");
    const phase: TaskPhase = current!.verification.length ? "verification" : current!.verificationDecision ? "ready-to-complete" : "verification";
    return replaceTask(workflow, current!.id, { integrationReceipt: receipt, phase, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, {}, now, `recorded integration receipt for ${current!.id}`);
  }
  if (event.type === "record-verification") {
    requireTaskPhase(current, "verification");
    const evidence = normalizeEvidence(event.evidence);
    if (evidence.contractHash !== current!.contract.hash) throw new Error("verification evidence has a stale contract");
    if (evidence.snapshotHash !== current!.integrationReceipt?.postSnapshotHash) throw new Error("verification evidence has a stale snapshot");
    const nextEvidence = boundedAppend(current!.evidence, evidence, 32, "verification evidence");
    const phase = verificationSatisfied(current!, nextEvidence) ? "ready-to-complete" : "verification";
    return replaceTask(workflow, current!.id, { evidence: nextEvidence, phase }, {}, now, `recorded verification for ${current!.id}`);
  }
  if (event.type === "complete-task") return completeOrchestratedTask(workflow, current, now);
  if (event.type === "record-initiative-acceptance") {
    if (workflow.orchestration.phase !== "initiative-acceptance" || workflow.tasks.some((task) => !["complete", "deferred"].includes(task.status))) throw new Error("initiative acceptance cannot be recorded before all task gates complete");
    const report = normalizeReport(event.report);
    requireReport(report, "final-acceptance", "final-reviewer", workflow.contract.hash, workflow.orchestration.activeRun);
    if (workflow.tasks.some((task) => task.reports.some((prior) => prior.provenance.runId === report.provenance.runId || prior.provenance.actorId === report.provenance.actorId))) throw new Error("final self-review is not permitted");
    if (report.outcome !== "approved" || report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) throw new Error("initiative acceptance has unresolved blocking findings");
    return update(workflow, { initiativeAcceptance: report }, now, "recorded initiative acceptance");
  }
  if (event.type === "complete-initiative") {
    if (workflow.orchestration.phase !== "initiative-acceptance" || !approvedReport(workflow.initiativeAcceptance, workflow.contract.hash)) throw new Error("initiative completion requires fresh independent final acceptance");
    return update(workflow, { status: "complete", orchestration: { ...workflow.orchestration, phase: "complete" } }, now, "workflow complete");
  }
  throw new Error("event is not valid in the current orchestration stage");
}

function reduceLegacyWorkflow(workflow: Workflow, event: Exclude<WorkflowEvent, { type: "claim-run" | "cancel-run" | "pause" | "record-plan-review" }>, now: string): WorkflowDecision {
  const current = activeTask(workflow);
  if (event.type === "start" || event.type === "resume") {
    if (workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
    if (current) {
      if (current.assessmentStatus === "unassessed") return unchanged(workflow, `${current.id} is unassessed; revise the workflow before execution`);
      return replaceTask(workflow, current.id, { verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active" }, now, `resumed ${current.id}`);
    }
    const blocked = event.type === "resume" ? workflow.tasks.find((task) => task.status === "blocked") : undefined;
    const next = blocked ?? readyTasks(workflow)[0];
    if (!next) return unchanged(workflow, "no dependency-ready task is available");
    if (next.assessmentStatus === "unassessed") return unchanged(workflow, `${next.id} is unassessed; revise the workflow before execution`);
    return replaceTask(workflow, next.id, { status: "active", phase: "implementation", blockedReason: undefined, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active", activeTask: next.id }, now, `${event.type === "resume" ? "resumed" : "started"} ${next.id}`);
  }
  if (event.type === "block") {
    if (!current) return unchanged(workflow, "no active task to block");
    return replaceTask(workflow, current.id, { status: "blocked", blockedReason: boundedText(event.reason, "blocked reason") || "blocked" }, { status: "blocked", activeTask: undefined }, now, `${current.id} blocked`);
  }
  if (event.type === "record-verification") {
    if (workflow.status !== "active" || !current) return unchanged(workflow, "no actively executing task to verify");
    return replaceTask(workflow, current.id, { evidence: boundedAppend(current.evidence, normalizeEvidence(event.evidence), 32, "verification evidence") }, {}, now, `recorded verification for ${current.id}`);
  }
  if (event.type !== "complete-task") throw new Error(`event ${event.type} is unavailable in compatibility mode`);
  if (workflow.status !== "active" || !current) return unchanged(workflow, "no actively executing task to complete");
  const latestEvidence = current.evidence.at(-1);
  const checkpoint = current.verificationCheckpoint;
  const currentEvidence = checkpoint ? current.evidence.filter((item) => evidenceMatchesCheckpoint(item, checkpoint)) : [];
  const missingChecks = current.verification.filter((planned) => !currentEvidence.some((item) => item.exitCode === 0 && commandKey(item) === commandKey(planned)));
  if (!event.allowGap && (latestEvidence?.exitCode !== 0 || !checkpoint || !latestEvidence || !evidenceMatchesCheckpoint(latestEvidence, checkpoint) || missingChecks.length)) return unchanged(workflow, `${current.id} requires passing protected bash results recorded after its activation/revision checkpoint${missingChecks.length ? `; missing passing checks: ${missingChecks.map(commandKey).join(", ")}` : ""}`);
  const completed = replaceTask(workflow, current.id, { status: "complete", phase: "historical", blockedReason: undefined, completedAt: now }, { activeTask: undefined }, now, `completed ${current.id}`).workflow;
  const next = readyTasks(completed)[0];
  if (next) return replaceTask(completed, next.id, { status: "active", phase: "implementation", verificationCheckpoint: { revision: completed.revision + 1, at: now } }, { status: "active", activeTask: next.id }, now, `completed ${current.id}; started ${next.id}`);
  const unfinished = completed.tasks.some((task) => ["pending", "active", "blocked"].includes(task.status));
  return update(completed, { status: unfinished ? "blocked" : "complete", orchestration: { ...completed.orchestration, phase: unfinished ? "task-execution" : "complete" } }, now, unfinished ? `completed ${current.id}; remaining work is blocked` : `completed ${current.id}; workflow complete`);
}

function recordPlanReview(workflow: Workflow, raw: StageReport, now: string): WorkflowDecision {
  if (workflow.orchestration.mode === "multi-agent" && workflow.orchestration.phase !== "plan-review") throw new Error("plan review report is not valid after task execution begins");
  const report = normalizeReport(raw);
  requireReport(report, "plan-review", "plan-reviewer", workflow.contract.hash, workflow.orchestration.activeRun);
  if (report.outcome !== "approved") return update(workflow, { planReview: report, status: "blocked" }, now, "plan review requires revision or input");
  if (report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) throw new Error("plan review cannot approve with unresolved blocking findings");
  return update(workflow, { planReview: report, status: workflow.status === "blocked" ? "draft" : workflow.status, orchestration: { ...workflow.orchestration, phase: "task-execution" } }, now, "plan review approved");
}

function completeOrchestratedTask(workflow: Workflow, current: WorkflowTask | undefined, now: string): WorkflowDecision {
  requireTaskPhase(current, "ready-to-complete");
  const implementation = current!.reports.find((report) => report.kind === "implementation");
  const general = [...current!.reports].reverse().find((report) => report.kind === "general-review");
  const concern = [...current!.reports].reverse().find((report) => report.kind === "concern-review");
  if (!implementation || !general) throw new Error("task completion requires implementation and independent general-review reports");
  if (implementation.provenance.runId === general.provenance.runId || implementation.provenance.actorId === general.provenance.actorId) throw new Error("self-review is not permitted");
  if (!approvedReport(general, current!.contract.hash) || (requiresConcernReview(current!) && !approvedReport(concern, current!.contract.hash))) throw new Error("task completion requires all independent approvals on the current contract");
  if (current!.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) throw new Error("task completion has an unresolved blocking finding");
  if (implementation.outcome === "no-change") {
    if (!implementation.rationale) throw new Error("no-change completion requires explicit rationale");
  } else {
    if (!current!.workspaceReceipt || !current!.integrationReceipt) throw new Error("task completion requires workspace and integration receipts");
    if (!verificationSatisfied(current!, current!.evidence)) throw new Error("task completion requires fresh objective verification on the integrated snapshot");
  }
  const completed = replaceTask(workflow, current!.id, { status: "complete", phase: "historical", completedAt: now, blockedReason: undefined }, { activeTask: undefined }, now, `completed ${current!.id}`).workflow;
  const next = readyTasks(completed)[0];
  if (next) return update(completed, { status: "draft" }, now, `completed ${current!.id}; ${next.id} is ready`);
  const unfinished = completed.tasks.some((task) => !["complete", "deferred"].includes(task.status));
  if (unfinished) return update(completed, { status: "blocked" }, now, `completed ${current!.id}; remaining work is blocked`);
  return update(completed, { status: "paused", orchestration: { ...completed.orchestration, phase: "initiative-acceptance" } }, now, `completed ${current!.id}; initiative acceptance required`);
}

export function summarizeWorkflow(workflow: Workflow): string {
  const counts = Object.fromEntries(["pending", "active", "blocked", "deferred", "complete"].map((status) => [status, workflow.tasks.filter((task) => task.status === status).length]));
  const current = activeTask(workflow);
  return [
    `pi-swe ${workflow.topic} — ${workflow.status} (revision ${workflow.revision}, contract ${workflow.contract.revision})`,
    `goal: ${workflow.goal}`,
    `orchestration: ${workflow.orchestration.phase}${workflow.orchestration.activeRun ? `; run ${workflow.orchestration.activeRun.runId} fence ${workflow.orchestration.activeRun.fence}` : ""}`,
    `tasks: ${counts.complete} complete, ${counts.active} active, ${counts.pending} pending, ${counts.blocked} blocked, ${counts.deferred} deferred`,
    `active: ${current ? `${current.id} — ${current.title} (${current.phase})` : "none"}`,
    `assessments:`,
    ...workflow.tasks.map((task) => task.assessmentStatus === "unassessed" ? `  ${task.id}: unassessed (${["complete", "deferred"].includes(task.status) ? "legacy terminal record" : "revise before execution"})` : `  ${task.id}: ${task.approaches.length ? conciseAssessment(task) : "none"}`),
    `ready: ${readyTasks(workflow).map((task) => task.id).join(", ") || "none"}`,
    ...(workflow.migration ? [`migration: v1 compatibility view; explicit mutation upgrades atomically`] : []),
    ...(workflow.importedFrom ? [`source: migrated ${workflow.importedFrom.kind} (${workflow.importedFrom.manifestPath})`] : []),
  ].join("\n");
}

function parseV2(value: Record<string, unknown>): Workflow {
  validateWorkflowInput(String(value.topic ?? ""), String(value.goal ?? ""), typeof value.plan === "string" ? value.plan : undefined, Array.isArray(value.tasks) ? value.tasks.length : 0);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !isStatus(value.status)) throw new Error("invalid workflow state");
  const updatedAt = validTimestamp(value.updatedAt, "workflow updatedAt");
  const contract = normalizeContract(value.contract);
  if (!record(value.orchestration)) throw new Error("invalid orchestration state");
  const mode = value.orchestration.mode;
  const phase = value.orchestration.phase;
  if (!['legacy', 'multi-agent'].includes(mode as string) || !['plan-review', 'task-execution', 'initiative-acceptance', 'complete'].includes(phase as string)) throw new Error("invalid orchestration state");
  const history = normalizeHistory(value.orchestration.history);
  const activeRun = value.orchestration.activeRun === undefined ? undefined : normalizeLease(value.orchestration.activeRun);
  const nextFence = value.orchestration.nextFence;
  if (!Number.isSafeInteger(nextFence) || (nextFence as number) < 1) throw new Error("invalid orchestration fence");
  const tasks = (value.tasks as unknown[]).map((task) => normalizeTask(task as Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">, { contract, compatibility: true }));
  validateTaskGraph(tasks);
  const active = tasks.filter((task) => task.status === "active");
  if (active.length > 1 || (value.activeTask !== undefined && active[0]?.id !== value.activeTask) || (active.length && value.activeTask !== active[0]!.id)) throw new Error("activeTask does not match task state");
  if (value.status === "active" && !active.length) throw new Error("active workflow requires an active task");
  if (active.length && value.status !== "active" && value.status !== "paused") throw new Error("active task requires active or paused workflow status");
  const allDone = tasks.every((task) => ["complete", "deferred"].includes(task.status));
  if (value.status === "complete" && (!allDone || phase !== "complete")) throw new Error("complete workflow status does not match task states or orchestration gates");
  return {
    version: WORKFLOW_VERSION, topic: value.topic as string, revision: value.revision as number, status: value.status as WorkflowStatus,
    goal: (value.goal as string).trim(), ...(typeof value.plan === "string" ? { plan: value.plan.trim() } : {}), contract,
    orchestration: { mode: mode as "legacy" | "multi-agent", phase: phase as WorkflowPhase, nextFence: nextFence as number, ...(activeRun ? { activeRun } : {}), history },
    ...(value.planReview ? { planReview: normalizeReport(value.planReview) } : {}),
    ...(value.initiativeAcceptance ? { initiativeAcceptance: normalizeReport(value.initiativeAcceptance) } : {}),
    ...(typeof value.activeTask === "string" ? { activeTask: value.activeTask } : {}), tasks, updatedAt,
    ...(normalizeMigration(value.migration) ? { migration: normalizeMigration(value.migration)! } : {}),
    ...(normalizeWorkflowImport(value.importedFrom) ? { importedFrom: normalizeWorkflowImport(value.importedFrom)! } : {}),
  };
}

function upgradeV1View(value: Record<string, unknown>, readAt: string): Workflow {
  if (!isValidTopic(value.topic as string) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !isStatus(value.status) || typeof value.goal !== "string" || !value.goal.trim() || !Array.isArray(value.tasks)) throw new Error("invalid v1 workflow state");
  const updatedAt = validTimestamp(value.updatedAt, "workflow updatedAt");
  const contract = planIdentity(value.goal.trim(), typeof value.plan === "string" ? value.plan.trim() : undefined, undefined, 1);
  const rawTasks = value.tasks as Array<Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">>;
  const tasks = rawTasks.map((raw) => {
    const terminal = raw.status === "complete" || raw.status === "deferred";
    const normalized = normalizeTask({ ...raw, writeScope: [], nonGoals: [] }, { contract, compatibility: true });
    return terminal ? { ...normalized, phase: "historical" as const } : { ...normalized, status: raw.status === "blocked" ? "blocked" as const : "pending" as const, phase: "pending" as const, verificationCheckpoint: undefined, evidence: [], reports: [], findings: [], clarifications: [], workspaceReceipt: undefined, integrationReceipt: undefined };
  });
  validateTaskGraph(tasks);
  const historicalTaskIds = tasks.filter((task) => ["complete", "deferred"].includes(task.status)).map((task) => task.id);
  const allDone = historicalTaskIds.length === tasks.length;
  return {
    version: WORKFLOW_VERSION, topic: value.topic as string, revision: value.revision as number,
    status: allDone ? "complete" : "paused", goal: value.goal.trim(), ...(typeof value.plan === "string" && value.plan.trim() ? { plan: value.plan.trim() } : {}),
    contract, orchestration: { mode: "multi-agent", phase: allDone ? "complete" : "plan-review", nextFence: 1, history: [] },
    tasks, updatedAt, migration: { sourceVersion: 1, readAt: validTimestamp(readAt, "migration readAt"), historicalTaskIds },
    ...(normalizeWorkflowImport(value.importedFrom) ? { importedFrom: normalizeWorkflowImport(value.importedFrom)! } : {}),
  };
}

function normalizeTask(task: Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">, options: { contract: ContractIdentity; compatibility: boolean; previousContract?: ContractIdentity }): WorkflowTask {
  if (!record(task) || typeof task.id !== "string" || !TASK_ID.test(task.id)) throw new Error("invalid task id");
  const title = boundedText(task.title, `task ${task.id} title`, 256);
  if (!title) throw new Error(`task ${task.id} requires a title`);
  if (task.status !== undefined && !isTaskStatus(task.status)) throw new Error(`task ${task.id} has invalid status`);
  const status = isTaskStatus(task.status) ? task.status : "pending";
  const kind: TaskKind = task.kind === "coordination" ? "coordination" : "implementation";
  const dependsOn = boundedStrings(task.dependsOn, `task ${task.id} dependencies`, 64, 64);
  const acceptance = boundedStrings(task.acceptance, `task ${task.id} acceptance`, 64, 1024);
  const approaches = normalizeApproaches(task.approaches);
  const approachReasons = normalizeApproachReasons(task.approachReasons, approaches);
  const incompleteLegacyAssessment = options.compatibility && task.assessmentStatus === undefined && (task.approaches === undefined || task.approachReasons === undefined || approaches.some((approach) => !approachReasons[approach]));
  const assessmentStatus: AssessmentStatus = task.assessmentStatus === "unassessed" || incompleteLegacyAssessment ? "unassessed" : "assessed";
  if (task.assessmentStatus !== undefined && !['assessed', 'unassessed'].includes(task.assessmentStatus)) throw new Error(`task ${task.id} has invalid assessmentStatus`);
  if (assessmentStatus === "assessed") for (const approach of approaches) if (!approachReasons[approach]) throw new Error(`approach ${approach} requires a concise applicability reason`);
  const writeScope = boundedStrings(task.writeScope, `task ${task.id} write scope`, 64, 512);
  if (writeScope.some((path) => !SAFE_SCOPE.test(path))) throw new Error(`task ${task.id} write scope contains an unsafe path`);
  const nonGoals = boundedStrings(task.nonGoals, `task ${task.id} non-goals`, 32, 1024);
  const verification = normalizeCommands(task.verification, task.id);
  const verificationDecision = normalizeVerificationDecision(task.verificationDecision);
  const basis = taskContractBasis(options.contract.hash, { id: task.id, title, kind, dependsOn, acceptance, approaches, approachReasons, writeScope, nonGoals, verification, verificationDecision });
  const calculatedHash = hashContract(basis);
  const supplied = task.contract ? normalizeContract(task.contract) : undefined;
  if (supplied && supplied.hash !== calculatedHash) throw new Error(`task ${task.id} contract hash does not match its requirements`);
  const previous = options.previousContract;
  const contract: ContractIdentity = supplied ?? { revision: previous && previous.hash !== calculatedHash ? previous.revision + 1 : previous?.revision ?? 1, hash: calculatedHash };
  if (task.phase !== undefined && !isTaskPhase(task.phase)) throw new Error(`task ${task.id} has invalid phase`);
  const phase = isTaskPhase(task.phase) ? task.phase : status === "complete" || status === "deferred" ? "historical" : status === "active" ? "implementation" : "pending";
  const evidence = Array.isArray(task.evidence) ? task.evidence.map(normalizeEvidence) : task.evidence === undefined ? [] : (() => { throw new Error(`task ${task.id} evidence must be an array`); })();
  if (evidence.length > 32) throw new Error(`task ${task.id} has too much verification evidence`);
  const reports = Array.isArray(task.reports) ? task.reports.map(normalizeReport) : task.reports === undefined ? [] : (() => { throw new Error(`task ${task.id} reports must be an array`); })();
  if (reports.length > MAX_REPORTS) throw new Error(`task ${task.id} has too many reports`);
  const clarifications = Array.isArray(task.clarifications) ? task.clarifications.map(normalizeClarification) : task.clarifications === undefined ? [] : (() => { throw new Error(`task ${task.id} clarifications must be an array`); })();
  if (clarifications.length > 32) throw new Error(`task ${task.id} has too many clarifications`);
  const findings = Array.isArray(task.findings) ? task.findings.map(normalizeFinding) : task.findings === undefined ? [] : (() => { throw new Error(`task ${task.id} findings must be an array`); })();
  if (findings.length > MAX_FINDINGS) throw new Error(`task ${task.id} has too many findings`);
  if (task.remediation !== undefined && (!record(task.remediation) || !Number.isSafeInteger(task.remediation.used) || !Number.isSafeInteger(task.remediation.max) || (task.remediation.used as number) < 0 || (task.remediation.max as number) < 0 || (task.remediation.max as number) > 8 || (task.remediation.used as number) > (task.remediation.max as number))) throw new Error(`task ${task.id} has invalid remediation budget`);
  const remediation = record(task.remediation) ? { used: task.remediation.used as number, max: task.remediation.max as number } : { used: 0, max: 2 };
  return {
    id: task.id, title, kind, status, phase, dependsOn, acceptance, approaches, approachReasons, assessmentStatus, writeScope, nonGoals, contract, verification,
    ...(verificationDecision ? { verificationDecision } : {}), ...(normalizeCheckpoint(task.verificationCheckpoint) ? { verificationCheckpoint: normalizeCheckpoint(task.verificationCheckpoint)! } : {}),
    evidence, evidenceLinks: boundedStrings(task.evidenceLinks, `task ${task.id} evidence links`, 64, MAX_TEXT), reports, clarifications, findings, remediation,
    ...(task.workspaceReceipt ? { workspaceReceipt: normalizeWorkspaceReceipt(task.workspaceReceipt) } : {}),
    ...(task.integrationReceipt ? { integrationReceipt: normalizeIntegrationReceipt(task.integrationReceipt) } : {}),
    ...(typeof task.blockedReason === "string" && task.blockedReason.trim() ? { blockedReason: boundedText(task.blockedReason, `task ${task.id} blocked reason`) } : {}),
    ...(typeof task.completedAt === "string" ? { completedAt: validTimestamp(task.completedAt, `task ${task.id} completedAt`) } : {}),
    ...(normalizeTaskImport(task.importedFrom) ? { importedFrom: normalizeTaskImport(task.importedFrom)! } : {}),
  };
}

function validateWorkflowInput(topic: string, goal: string, plan: string | undefined, taskCount: number): void {
  if (!isValidTopic(topic)) throw new Error("topic must be lowercase kebab-case path segments");
  if (!goal.trim()) throw new Error("goal is required");
  if (goal.trim().length > MAX_TEXT) throw new Error("goal exceeds 2048 characters");
  if (plan?.trim() && plan.trim().length > MAX_TEXT) throw new Error("plan exceeds 2048 characters");
  if (!taskCount || taskCount > MAX_TASKS) throw new Error("workflow requires 1 to 100 tasks");
}
function planIdentity(goal: string, plan: string | undefined, linked: string | undefined, revision: number): ContractIdentity {
  const linkedPlanHash = linked ? (linked.startsWith("sha256:") && !linked.includes("\n") ? linked : hashContract(linked)) : undefined;
  return { revision, hash: hashContract({ goal, plan: plan ?? null, linkedPlanHash: linkedPlanHash ?? null }), ...(linkedPlanHash ? { linkedPlanHash } : {}) };
}
function taskContractBasis(planHash: string, task: object): object { return { planContractHash: planHash, ...task }; }
export function hashContract(value: unknown): string { return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function activeTask(workflow: Workflow): WorkflowTask | undefined { return workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : undefined; }
function requireTaskPhase(task: WorkflowTask | undefined, phase: TaskPhase): void { if (!task || task.phase !== phase || task.status !== "active") throw new Error(`${phase} report is not valid in the current task stage`); }
function requireReport(report: StageReport, kind: StageReport["kind"], role: RunnerRole, contractHash: string, lease?: RunLease): void {
  if (report.kind !== kind || report.provenance.role !== role) throw new Error(`${kind} report has incorrect runner provenance`);
  if (report.provenance.contractHash !== contractHash) throw new Error(`${kind} report has a stale contract`);
  if (lease && (report.provenance.leaseId !== lease.id || report.provenance.leaseFence !== lease.fence || report.provenance.runId !== lease.runId)) throw new Error(`${kind} report has a stale run lease`);
}
function approvedReport(report: StageReport | undefined, contractHash: string): boolean { return !!report && report.outcome === "approved" && report.provenance.contractHash === contractHash && !report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open"); }
function requiresConcernReview(task: WorkflowTask): boolean { return task.approaches.some((approach) => CONCERN_APPROACHES.has(approach)); }
function appendTaskReport(task: WorkflowTask, report: StageReport): Partial<WorkflowTask> {
  const reports = boundedAppend(task.reports, report, MAX_REPORTS, "task reports");
  const findings = boundedMergeById(task.findings, report.findings, MAX_FINDINGS, "task findings");
  const clarifications = boundedMergeById(task.clarifications, report.questions ?? [], 32, "task clarifications");
  return { reports, findings, clarifications };
}
function verificationSatisfied(task: WorkflowTask, evidence: VerificationEvidence[]): boolean {
  if (!task.verification.length) return !!task.verificationDecision;
  const snapshot = task.integrationReceipt?.postSnapshotHash;
  return task.verification.every((planned) => evidence.some((item) => item.exitCode === 0 && item.contractHash === task.contract.hash && item.snapshotHash === snapshot && commandKey(item) === commandKey(planned)));
}
function blockForDecision(workflow: Workflow, task: WorkflowTask, reason: string, now: string): WorkflowDecision { return replaceTask(workflow, task.id, { status: "blocked", blockedReason: reason }, { status: "blocked", activeTask: undefined }, now, `${task.id} blocked: ${reason}`); }
function claimRun(workflow: Workflow, lease: RunLease, now: string): WorkflowDecision {
  const normalized = normalizeLease(lease);
  const active = workflow.orchestration.activeRun;
  if (active && Date.parse(active.expiresAt) > Date.parse(now)) throw new Error(`run lease ${active.runId} is already active`);
  if (normalized.fence !== workflow.orchestration.nextFence) throw new Error(`run lease fence must be ${workflow.orchestration.nextFence}`);
  return update(workflow, { orchestration: { ...workflow.orchestration, activeRun: normalized, nextFence: normalized.fence + 1 } }, now, `claimed run ${normalized.runId}`);
}
function cancelRun(workflow: Workflow, lease: RunLease, reason: string, now: string): WorkflowDecision {
  const active = workflow.orchestration.activeRun;
  if (!active || active.id !== lease.id || active.fence !== lease.fence || active.runId !== lease.runId) throw new Error("stale run lease cannot cancel the active run");
  return update(workflow, { status: workflow.status === "active" ? "paused" : workflow.status, orchestration: { ...workflow.orchestration, activeRun: undefined, history: appendHistory(workflow.orchestration.history, { id: `run-${lease.fence}-cancelled`, type: "run-cancelled", at: now, summary: boundedText(reason, "cancellation reason"), ...(lease.taskId ? { taskId: lease.taskId } : {}), auditCritical: true }) } }, now, `cancelled run ${lease.runId}`);
}
function scopeAllows(scopes: string[], path: string): boolean { return scopes.some((scope) => scope.endsWith("/**") ? path === scope.slice(0, -3) || path.startsWith(scope.slice(0, -2)) : scope === path); }
function replaceTask(workflow: Workflow, id: string, taskPatch: Partial<WorkflowTask>, workflowPatch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return changed(workflow, { ...workflowPatch, tasks: workflow.tasks.map((task) => task.id === id ? { ...task, ...taskPatch } : task) }, now, message); }
function update(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return changed(workflow, patch, now, message); }
function changed(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return { workflow: { ...workflow, ...patch, revision: workflow.revision + 1, updatedAt: validTimestamp(now, "workflow timestamp") }, changed: true, message }; }
function unchanged(workflow: Workflow, message: string): WorkflowDecision { return { workflow, changed: false, message }; }
function conciseAssessment(task: WorkflowTask): string { const text = task.approaches.map((approach) => `${approach} (${task.approachReasons[approach]})`).join(", "); return text.length <= 300 ? text : `${text.slice(0, 297)}...`; }
function commandKey(command: VerificationCommand): string { return [command.command, ...command.args].join(" ").trim(); }
function evidenceMatchesCheckpoint(evidence: VerificationEvidence, checkpoint: VerificationCheckpoint): boolean { return Date.parse(evidence.at) > Date.parse(checkpoint.at) && evidence.source?.kind === "bash-tool-result" && evidence.source.workflowRevision >= checkpoint.revision && (checkpoint.sessionId === undefined || evidence.source.sessionId === checkpoint.sessionId); }
function normalizeCommands(value: unknown, taskId: string): VerificationCommand[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 16) throw new Error(`task ${taskId} verification must be an array of at most 16 commands`); const commands = value.map(normalizeCommand); if (new Set(commands.map(commandKey)).size !== commands.length) throw new Error(`task ${taskId} has duplicate verification commands`); return commands; }
function normalizeCommand(value: unknown): VerificationCommand { if (!record(value) || typeof value.command !== "string" || !value.command.trim() || value.command.trim().length > 256 || (value.args !== undefined && !Array.isArray(value.args))) throw new Error("invalid verification command"); const args = Array.isArray(value.args) ? value.args.map((arg) => { if (typeof arg !== "string" || arg.length > 512) throw new Error("invalid verification argument"); return arg; }) : []; if (args.length > 64) throw new Error("too many verification arguments"); return { command: value.command.trim(), args }; }
function normalizeEvidence(value: unknown): VerificationEvidence { const command = normalizeCommand(value); if (!record(value) || !Number.isInteger(value.exitCode)) throw new Error("invalid verification evidence"); const at = validTimestamp(value.at, "verification evidence timestamp"); if (value.contractHash !== undefined && (typeof value.contractHash !== "string" || value.contractHash.length > 80)) throw new Error("invalid verification contract hash"); if (value.snapshotHash !== undefined && (typeof value.snapshotHash !== "string" || value.snapshotHash.length > 128)) throw new Error("invalid verification snapshot hash"); if (value.source !== undefined && (!record(value.source) || value.source.kind !== "bash-tool-result" || typeof value.source.toolCallId !== "string" || !value.source.toolCallId || !Number.isSafeInteger(value.source.workflowRevision) || (value.source.workflowRevision as number) < 1)) throw new Error("invalid verification evidence source"); const source = record(value.source) ? { kind: "bash-tool-result" as const, toolCallId: value.source.toolCallId as string, workflowRevision: value.source.workflowRevision as number, ...(typeof value.source.sessionId === "string" ? { sessionId: value.source.sessionId } : {}) } : undefined; return { ...command, exitCode: value.exitCode as number, at, ...(typeof value.contractHash === "string" ? { contractHash: value.contractHash } : {}), ...(typeof value.snapshotHash === "string" ? { snapshotHash: value.snapshotHash } : {}), ...(source ? { source } : {}) }; }
function normalizeReport(value: unknown): StageReport { if (!record(value) || !['plan-review','implementation','general-review','concern-review','final-acceptance'].includes(value.kind as string) || !['approved','changes-requested','needs-input','completed','no-change','failed'].includes(value.outcome as string) || !Array.isArray(value.findings)) throw new Error("invalid stage report"); const summary = boundedText(value.summary, "stage report summary"); const findings = value.findings.map(normalizeFinding); if (findings.length > MAX_FINDINGS) throw new Error("stage report has too many findings"); const changedPaths = value.changedPaths === undefined ? undefined : boundedStrings(value.changedPaths, "changed paths", 128, 512); const questions = value.questions === undefined ? undefined : (Array.isArray(value.questions) ? value.questions.map(normalizeClarification) : (() => { throw new Error("stage report questions must be an array"); })()); if (questions && questions.length > 32) throw new Error("stage report has too many questions"); return { kind: value.kind as StageReport["kind"], outcome: value.outcome as StageReport["outcome"], summary, ...(typeof value.rationale === "string" && value.rationale.trim() ? { rationale: boundedText(value.rationale, "stage report rationale") } : {}), ...(changedPaths ? { changedPaths } : {}), findings, ...(questions ? { questions } : {}), provenance: normalizeProvenance(value.provenance) }; }
function normalizeProvenance(value: unknown): RunnerProvenance { if (!record(value) || typeof value.runId !== "string" || !value.runId || value.runId.length > 128 || !['plan-reviewer','implementer','general-reviewer','concern-reviewer','final-reviewer'].includes(value.role as string) || typeof value.actorId !== "string" || !value.actorId || value.actorId.length > 128 || typeof value.leaseId !== "string" || !value.leaseId || value.leaseId.length > 128 || !Number.isSafeInteger(value.leaseFence) || (value.leaseFence as number) < 1 || typeof value.contractHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contractHash) || (value.snapshotHash !== undefined && (typeof value.snapshotHash !== "string" || !value.snapshotHash || value.snapshotHash.length > 128))) throw new Error("invalid runner provenance"); return { runId: value.runId, role: value.role as RunnerRole, actorId: value.actorId, leaseId: value.leaseId, leaseFence: value.leaseFence as number, contractHash: value.contractHash, ...(typeof value.snapshotHash === "string" ? { snapshotHash: value.snapshotHash } : {}), startedAt: validTimestamp(value.startedAt, "runner start"), completedAt: validTimestamp(value.completedAt, "runner completion") }; }
function normalizeFinding(value: unknown): Finding { if (!record(value) || typeof value.id !== "string" || !TASK_ID.test(value.id) || !['blocking','warning'].includes(value.severity as string) || !['open','resolved','accepted-risk'].includes(value.status as string)) throw new Error("invalid finding"); return { id: value.id, severity: value.severity as Finding["severity"], status: value.status as Finding["status"], summary: boundedText(value.summary, "finding summary", 1024), evidence: boundedText(value.evidence, "finding evidence"), ...(typeof value.disposition === "string" && value.disposition.trim() ? { disposition: boundedText(value.disposition, "finding disposition") } : {}) }; }
function normalizeClarification(value: unknown): Clarification { if (!record(value) || typeof value.id !== "string" || !TASK_ID.test(value.id) || typeof value.askedByRunId !== "string" || !value.askedByRunId) throw new Error("invalid clarification"); return { id: value.id, question: boundedText(value.question, "clarification question"), askedByRunId: value.askedByRunId, askedAt: validTimestamp(value.askedAt, "clarification timestamp"), ...(typeof value.answer === "string" ? { answer: boundedText(value.answer, "clarification answer") } : {}), ...(typeof value.answeredBy === "string" ? { answeredBy: boundedText(value.answeredBy, "clarification answerer", 128) } : {}), ...(typeof value.answeredAt === "string" ? { answeredAt: validTimestamp(value.answeredAt, "clarification answer timestamp") } : {}) }; }
function normalizeWorkspaceReceipt(value: unknown): WorkspaceReceipt { if (!record(value) || typeof value.workspaceId !== "string" || !value.workspaceId || typeof value.baselineHash !== "string" || typeof value.snapshotHash !== "string") throw new Error("invalid workspace receipt"); return { workspaceId: boundedText(value.workspaceId, "workspace id", 128), baselineHash: boundedText(value.baselineHash, "baseline hash", 128), snapshotHash: boundedText(value.snapshotHash, "snapshot hash", 128), changedPaths: boundedStrings(value.changedPaths, "workspace changed paths", 128, 512), createdAt: validTimestamp(value.createdAt, "workspace receipt timestamp") }; }
function normalizeIntegrationReceipt(value: unknown): IntegrationReceipt { if (!record(value) || typeof value.integrationId !== "string" || !value.integrationId || typeof value.preSnapshotHash !== "string" || typeof value.postSnapshotHash !== "string" || typeof value.patchHash !== "string") throw new Error("invalid integration receipt"); return { integrationId: boundedText(value.integrationId, "integration id", 128), preSnapshotHash: boundedText(value.preSnapshotHash, "pre snapshot hash", 128), postSnapshotHash: boundedText(value.postSnapshotHash, "post snapshot hash", 128), patchHash: boundedText(value.patchHash, "patch hash", 128), integratedAt: validTimestamp(value.integratedAt, "integration timestamp") }; }
function normalizeLease(value: unknown): RunLease { if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.runId !== "string" || !value.runId || typeof value.ownerId !== "string" || !value.ownerId || !Number.isSafeInteger(value.fence) || (value.fence as number) < 1 || !['plan-review','task-execution','initiative-acceptance','complete','pending','implementation','general-review','concern-review','remediation','workspace','integration','verification','ready-to-complete','historical'].includes(value.stage as string)) throw new Error("invalid run lease"); const acquiredAt = validTimestamp(value.acquiredAt, "run lease acquiredAt"); const expiresAt = validTimestamp(value.expiresAt, "run lease expiresAt"); if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error("run lease must expire after acquisition"); return { id: boundedText(value.id, "lease id", 128), runId: boundedText(value.runId, "run id", 128), ownerId: boundedText(value.ownerId, "lease owner", 128), stage: value.stage as RunLease["stage"], ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}), fence: value.fence as number, acquiredAt, expiresAt }; }
function normalizeContract(value: unknown): ContractIdentity { if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.hash)) throw new Error("invalid contract identity"); return { revision: value.revision as number, hash: value.hash, ...(typeof value.linkedPlanHash === "string" ? { linkedPlanHash: value.linkedPlanHash } : {}) }; }
function normalizeCheckpoint(value: unknown): VerificationCheckpoint | undefined { if (value === undefined) return undefined; if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid verification checkpoint"); return { revision: value.revision as number, at: validTimestamp(value.at, "verification checkpoint"), ...(typeof value.sessionId === "string" && value.sessionId ? { sessionId: value.sessionId } : {}), ...(Number.isSafeInteger(value.branchLength) && (value.branchLength as number) >= 0 ? { branchLength: value.branchLength as number } : {}) }; }
function normalizeVerificationDecision(value: unknown): WorkflowTask["verificationDecision"] { if (value === undefined) return undefined; if (!record(value) || value.kind !== "manual" || typeof value.decidedBy !== "string" || !value.decidedBy) throw new Error("invalid manual verification decision"); return { kind: "manual", rationale: boundedText(value.rationale, "manual verification rationale"), decidedBy: boundedText(value.decidedBy, "manual verification decision owner", 128), at: validTimestamp(value.at, "manual verification decision timestamp") }; }
function normalizeHistory(value: unknown): HistoryEntry[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > MAX_HISTORY) throw new Error(`workflow history exceeds ${MAX_HISTORY} entries`); return value.map((item) => { if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type) throw new Error("invalid workflow history"); return { id: boundedText(item.id, "history id", 128), type: boundedText(item.type, "history type", 128), at: validTimestamp(item.at, "history timestamp"), summary: boundedText(item.summary, "history summary"), ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}), ...(item.provenance ? { provenance: normalizeProvenance(item.provenance) } : {}), ...(item.auditCritical === true ? { auditCritical: true } : {}) }; }); }
function appendHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] { const next = [...history, entry]; if (next.length <= MAX_HISTORY) return next; const removable = next.findIndex((item) => !item.auditCritical); if (removable < 0) throw new Error("workflow history is full of audit-critical provenance; archive before continuing"); return next.filter((_, index) => index !== removable); }
function boundedAppend<T>(items: T[], value: T, max: number, label: string): T[] { if (items.length >= max) throw new Error(`${label} exceeds ${max} entries`); return [...items, value]; }
function boundedMergeById<T extends { id: string }>(items: T[], additions: T[], max: number, label: string): T[] { const map = new Map(items.map((item) => [item.id, item])); additions.forEach((item) => map.set(item.id, item)); if (map.size > max) throw new Error(`${label} exceeds ${max} entries`); return [...map.values()]; }
function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) throw new Error(`${label} contains an invalid value`); const normalized = [...new Set(value.map((item) => (item as string).trim()))]; if (normalized.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`); return normalized; }
function boundedText(value: unknown, label: string, max = MAX_TEXT): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); if (value.trim().length > max) throw new Error(`${label} exceeds ${max} characters`); return value.trim(); }
function validTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`); return value; }
function normalizeApproaches(value: unknown): WorkflowApproach[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error("task approaches must be an array"); const result: WorkflowApproach[] = []; for (const item of value) { if (typeof item !== "string" || !WORKFLOW_APPROACHES.includes(item as WorkflowApproach)) throw new Error(`invalid approach ${String(item)}`); if (!result.includes(item as WorkflowApproach)) result.push(item as WorkflowApproach); } return result; }
function normalizeApproachReasons(value: unknown, approaches: WorkflowApproach[]): ApproachReasons { if (value === undefined) return {}; if (!record(value)) throw new Error("task approachReasons must be an object"); const reasons: ApproachReasons = {}; for (const [key, reason] of Object.entries(value)) { if (!approaches.includes(key as WorkflowApproach) || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1024) throw new Error(`approach ${key} requires a concise applicability reason`); reasons[key as WorkflowApproach] = reason.trim(); } return reasons; }
function validateTaskGraph(tasks: WorkflowTask[]): void { const ids = new Set<string>(); for (const task of tasks) { if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`); ids.add(task.id); } for (const task of tasks) for (const dependency of task.dependsOn) { if (!ids.has(dependency)) throw new Error(`task ${task.id} has missing dependency ${dependency}`); if (dependency === task.id) throw new Error(`task ${task.id} depends on itself`); } const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(tasks.map((task) => [task.id, task])); const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`); if (visited.has(id)) return; visiting.add(id); byId.get(id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); }; tasks.forEach((task) => visit(task.id)); }
function isStatus(value: unknown): value is WorkflowStatus { return ["draft", "active", "paused", "blocked", "complete"].includes(value as string); }
function isTaskStatus(value: unknown): value is TaskStatus { return ["pending", "active", "blocked", "deferred", "complete"].includes(value as string); }
function isTaskPhase(value: unknown): value is TaskPhase { return ["pending","implementation","general-review","concern-review","remediation","workspace","integration","verification","ready-to-complete","historical"].includes(value as string); }
function normalizeMigration(value: unknown): Workflow["migration"] | undefined { if (value === undefined) return undefined; if (!record(value) || value.sourceVersion !== 1) throw new Error("invalid workflow migration provenance"); return { sourceVersion: 1, readAt: validTimestamp(value.readAt, "migration readAt"), historicalTaskIds: boundedStrings(value.historicalTaskIds, "historical task ids", MAX_TASKS, 64) }; }
function normalizeWorkflowImport(value: unknown): Workflow["importedFrom"] | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.kind !== "pi-swe-v2") throw new Error("invalid workflow import provenance");
  return { kind: "pi-swe-v2", manifestPath: boundedText(value.manifestPath, "legacy manifest path"), ...(Number.isSafeInteger(value.planRevision) && (value.planRevision as number) >= 1 ? { planRevision: value.planRevision as number } : {}) };
}
function normalizeTaskImport(value: unknown): ImportedTaskProvenance | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.kind !== "pi-swe-v2-contract") throw new Error("invalid task import provenance");
  const completion = value.completion;
  let normalizedCompletion: ImportedTaskProvenance["completion"];
  if (completion !== undefined) {
    if (!record(completion)) throw new Error("invalid imported completion provenance");
    const stringField = (key: string, max = MAX_TEXT): string | undefined => completion[key] === undefined ? undefined : boundedText(completion[key], `imported completion ${key}`, max);
    normalizedCompletion = {
      ...(Number.isSafeInteger(completion.schemaVersion) && (completion.schemaVersion as number) >= 1 ? { schemaVersion: completion.schemaVersion as number } : {}),
      ...(stringField("requestId", 128) ? { requestId: stringField("requestId", 128) } : {}),
      ...(typeof completion.completedAt === "string" ? { completedAt: validTimestamp(completion.completedAt, "imported completion timestamp") } : {}),
      ...(Number.isSafeInteger(completion.planRevision) && (completion.planRevision as number) >= 1 ? { planRevision: completion.planRevision as number } : {}),
      ...(stringField("contractPath") ? { contractPath: stringField("contractPath") } : {}),
      ...(stringField("preCompletionContentHash", 128) ? { preCompletionContentHash: stringField("preCompletionContentHash", 128) } : {}),
      ...(stringField("verificationPath") ? { verificationPath: stringField("verificationPath") } : {}),
      ...(stringField("verificationContentHash", 128) ? { verificationContentHash: stringField("verificationContentHash", 128) } : {}),
      ...(stringField("reviewPath") ? { reviewPath: stringField("reviewPath") } : {}),
      ...(stringField("reviewContentHash", 128) ? { reviewContentHash: stringField("reviewContentHash", 128) } : {}),
      ...(stringField("reviewDecision", 128) ? { reviewDecision: stringField("reviewDecision", 128) } : {}),
      ...(stringField("nextInitiativeState", 128) ? { nextInitiativeState: stringField("nextInitiativeState", 128) } : {}),
      ...(completion.nextActiveContractId === null ? { nextActiveContractId: null } : typeof completion.nextActiveContractId === "string" ? { nextActiveContractId: boundedText(completion.nextActiveContractId, "next active contract", 64) } : {}),
      ...(completion.nextReadyContractIds !== undefined ? { nextReadyContractIds: boundedStrings(completion.nextReadyContractIds, "next ready contract ids", MAX_TASKS, 64) } : {}),
    };
  }
  return { kind: "pi-swe-v2-contract", contractPath: boundedText(value.contractPath, "legacy contract path"), ...(typeof value.contentHash === "string" ? { contentHash: boundedText(value.contentHash, "legacy content hash", 128) } : {}), ...(normalizedCompletion ? { completion: normalizedCompletion } : {}) };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
