import { createHash } from "node:crypto";

export const WORKFLOW_VERSION = 2 as const;
export const LEGACY_WORKFLOW_VERSION = 1 as const;
export const BOOTSTRAP_PLAN_ANCHOR = "e882cd62deb541aa437c16c72781a1ccd243055e" as const;
export const BOOTSTRAP_NATIVE_TAKEOVER_TASK = "cutover-readiness" as const;

export type WorkflowStatus = "draft" | "active" | "paused" | "blocked" | "complete";
export type TaskStatus = "pending" | "active" | "blocked" | "deferred" | "complete";
export const WORKFLOW_APPROACHES = ["tdd", "diagnosis", "dsa", "security", "performance", "migration", "accessibility-ux", "operations"] as const;
export type WorkflowApproach = typeof WORKFLOW_APPROACHES[number];
export type ApproachReasons = Partial<Record<WorkflowApproach, string>>;
export type AssessmentStatus = "assessed" | "unassessed";
export type VerificationCheckpoint = { revision: number; at: string; sessionId?: string; branchLength?: number };
export type ParentAuthority = { ownerId: string; sessionId: string; runtimeId: string; cwd: string; sessionFile?: string; claimedAt: string; valid: boolean; invalidatedAt?: string; invalidatedReason?: string };
export type Gate2DecisionAttestation = {
  decisionId: string; authorizedBy: string; authorizedAt: string;
  readinessEvidenceHash: string; migrationEvidenceHash: string;
  targetRuntime: "v2"; rollbackSelector: "compatibility"; rollbackWindowEnd: string; rationale: string;
};
export type RuntimeHandoff = {
  id: string;
  decisionId: string;
  decision?: Gate2DecisionAttestation;
  from: "compatibility" | "v2";
  to: "compatibility" | "v2";
  phase: "prepared" | "reclaimed";
  selectorGeneration: number;
  preparedAt: string;
  reclaimedAt?: string;
  previousParent?: ParentAuthority;
};
export type ContractIdentity = { revision: number; hash: string; linkedPlanHash?: string };
export type TaskKind = "implementation" | "coordination";
export type TaskPhase = "pending" | "implementation" | "general-review" | "concern-review" | "remediation" | "workspace" | "integration" | "verification" | "ready-to-complete" | "historical";
export type WorkflowPhase = "plan-review" | "task-execution" | "initiative-acceptance" | "complete";
export type RunnerRole = "plan-reviewer" | "implementer" | "general-reviewer" | "concern-reviewer" | "final-reviewer";

export type RunnerProvenance = {
  runId: string;
  role: RunnerRole;
  actorId: string;
  provider?: string;
  model?: string;
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
export type WorkspaceReceipt = {
  workspaceId: string;
  baselineHash: string;
  snapshotHash: string;
  changedPaths: string[];
  createdAt: string;
  version?: 1;
  root?: string;
  path?: string;
  taskId?: string;
  topic?: string;
  baselineCommit?: string;
  baselineRef?: string;
  worktreeGitDir?: string;
  ownershipToken?: string;
  intentPath?: string;
  workspaceHeadCommit?: string;
  preparedResultCommit?: string;
  preparedResultRef?: string;
  preparedPatchHash?: string;
  realHead?: string;
  realBranch?: string | null;
  realIndexHash?: string;
  realIndexTree?: string;
  stagedPatchHash?: string;
  unstagedPatchHash?: string;
  realSourceSnapshotHash?: string;
  includedUntracked?: string[];
  baselineUntrackedPathHashes?: string[];
  managedPaths?: string[];
  integrationBaseCommit?: string;
  writeScope?: string[];
};
export type IntegrationReceipt = {
  integrationId: string;
  preSnapshotHash: string;
  postSnapshotHash: string;
  patchHash: string;
  integratedAt: string;
  version?: 1;
  workspaceId?: string;
  resultCommit?: string;
  resultRef?: string;
  observedHead?: string;
  observedBranch?: string | null;
  observedIndexHash?: string;
  changedPaths?: string[];
};
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
export type RepositorySnapshot = { hash: string; head: string; branch: string | null; changedPaths: string[]; capturedAt: string };
export type ManualValidationOutcome = { status: "required" | "approved" | "rejected"; rationale: string; decidedBy?: string; at: string };
export type BootstrapFindingDecision = { findingId: string; disposition: string; decidedBy: string; at: string };
export type BootstrapAdoption = {
  anchorCommit: string;
  descendantHead: string;
  snapshot: RepositorySnapshot;
  taskIds: string[];
  planReview: StageReport;
  generalReview: StageReport;
  concernReview?: { concerns: WorkflowApproach[]; report: StageReport };
  checks: Array<{ taskId: string; evidence: VerificationEvidence }>;
  decisions: BootstrapFindingDecision[];
  authorization: { id: string; authorizedBy: string; ownerId: string; sessionId: string; runtimeId: string; authorizedAt: string };
  adoptedAt: string;
};
export type InitiativeCloseout = {
  snapshot: RepositorySnapshot;
  cumulativeDeltaHash: string;
  checkpoint: { revision: number; at: string; ownerId: string; sessionId: string; runtimeId: string; branchLength: number };
  evidence: VerificationEvidence[];
  unresolvedRisks: string[];
  blockingRisks: string[];
  followUpTaskIds: string[];
  manualValidation?: ManualValidationOutcome;
};

export type VerificationEvidence = VerificationCommand & {
  exitCode: number;
  at: string;
  contractHash?: string;
  snapshotHash?: string;
  cwd?: string;
  branch?: string | null;
  head?: string;
  beforeSnapshotHash?: string;
  afterSnapshotHash?: string;
  source?: {
    kind: "bash-tool-result";
    toolCallId: string;
    toolName?: "bash";
    workflowRevision: number;
    sessionId?: string;
    ownerId?: string;
    runtimeId?: string;
    sessionFile?: string;
    sessionBranchId?: string;
    branchLength?: number;
  };
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
  verificationDriftPaths: string[];
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
  orchestration: { mode: "legacy" | "multi-agent"; phase: WorkflowPhase; nextFence: number; activeRun?: RunLease; parent?: ParentAuthority; runtimeHandoff?: RuntimeHandoff; history: HistoryEntry[] };
  planReview?: StageReport;
  initiativeVerification: VerificationCommand[];
  closeout?: InitiativeCloseout;
  initiativeAcceptance?: StageReport;
  bootstrapAdoption?: BootstrapAdoption;
  activeTask?: string;
  tasks: WorkflowTask[];
  updatedAt: string;
  migration?: {
    sourceVersion: 1;
    readAt: string;
    historicalTaskIds: string[];
    disposition?: "continue" | "reopen" | "grandfather-read-only";
    decidedBy?: string;
    preimageHash?: string;
  };
  importedFrom?: { kind: "pi-swe-v2"; manifestPath: string; planRevision?: number };
};

export type WorkflowEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "block"; reason: string }
  | { type: "record-plan-review"; report: StageReport }
  | { type: "adopt-bootstrap"; adoption: Omit<BootstrapAdoption, "adoptedAt"> }
  | { type: "record-implementation"; report: StageReport; receipt?: WorkspaceReceipt }
  | { type: "record-review"; report: StageReport }
  | { type: "record-run-failure"; stage: WorkflowPhase | TaskPhase; taskId?: string; reason: string }
  | { type: "record-verification-failure"; evidence: VerificationEvidence; observedSnapshotHash: string; observedChangedPaths: string[]; reason: string }
  | { type: "invalidate-integrated-source"; observedSnapshotHash: string; observedChangedPaths: string[]; reason: string }
  | { type: "decide-finding"; taskId: string; findingId: string; disposition: string; decidedBy: string }
  | { type: "reset-remediation"; taskId: string; max: number; reason: string; decidedBy: string }
  | { type: "record-workspace"; receipt: WorkspaceReceipt }
  | { type: "record-integration"; receipt: IntegrationReceipt }
  | { type: "record-verification"; evidence: VerificationEvidence }
  | { type: "complete-task"; allowGap?: boolean }
  | { type: "begin-initiative-closeout"; snapshot: RepositorySnapshot; cumulativeDeltaHash: string; unresolvedRisks: string[]; blockingRisks?: string[]; branchLength: number }
  | { type: "record-initiative-verification"; evidence: VerificationEvidence; observedSnapshot: RepositorySnapshot }
  | { type: "record-initiative-acceptance"; report: StageReport }
  | { type: "record-manual-validation"; outcome: ManualValidationOutcome & { status: "approved" | "rejected"; decidedBy: string } }
  | { type: "add-closeout-follow-up"; task: WorkflowTaskRevision }
  | { type: "invalidate-initiative-closeout"; observedSnapshot: RepositorySnapshot; reason: string }
  | { type: "complete-initiative"; observedSnapshot: RepositorySnapshot; branchLength: number }
  | { type: "claim-run"; lease: RunLease }
  | { type: "cancel-run"; lease: RunLease; reason: string }
  | { type: "respond-clarification"; taskId?: string; questionId: string; answer: string; answeredBy: string }
  | { type: "claim-parent"; authority: ParentAuthority }
  | { type: "invalidate-parent"; ownerId: string; sessionId: string; runtimeId: string; reason: string }
  | { type: "fence-parent"; ownerId: string; sessionId: string; runtimeId: string; reason: string }
  | { type: "recover-parent"; authority: ParentAuthority; reason: string; decidedBy: string }
  | { type: "prepare-runtime-handoff"; handoff: Omit<RuntimeHandoff, "phase" | "preparedAt" | "reclaimedAt" | "previousParent"> }
  | { type: "reclaim-runtime-handoff"; handoffId: string; decisionId: string; selectorGeneration: number; authority: ParentAuthority }
  | { type: "rotate-runtime-parent"; handoffId: string; decisionId: string; from: "compatibility" | "v2"; to: "compatibility" | "v2"; selectorGeneration: number; authority: ParentAuthority };

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

/** Match a normalized repository path against an exact, segment-glob, or recursive `/**` write scope. */
export function scopeAllowsPath(scope: string, path: string): boolean {
  const scopeSegments = scope.split("/");
  const pathSegments = path.split("/");
  const memo = new Map<string, boolean>();
  const match = (scopeIndex: number, pathIndex: number): boolean => {
    const key = `${scopeIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (scopeIndex === scopeSegments.length) result = pathIndex === pathSegments.length;
    else if (scopeSegments[scopeIndex] === "**") result = match(scopeIndex + 1, pathIndex) || (pathIndex < pathSegments.length && match(scopeIndex, pathIndex + 1));
    else if (pathIndex >= pathSegments.length) result = false;
    else {
      const expression = scopeSegments[scopeIndex]!.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
      result = new RegExp(`^${expression}$`).test(pathSegments[pathIndex]!) && match(scopeIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export function createWorkflow(input: {
  topic: string;
  goal: string;
  plan?: string;
  linkedPlanContent?: string;
  initiativeVerification?: VerificationCommand[];
  tasks: Array<Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">>;
  now?: string;
}): Workflow {
  validateWorkflowInput(input.topic, input.goal, input.plan, input.tasks.length);
  const now = validTimestamp(input.now ?? new Date().toISOString(), "workflow timestamp");
  const mode = input.tasks.some((task) => task.writeScope !== undefined || task.nonGoals !== undefined) ? "multi-agent" : "legacy";
  const initiativeVerification = normalizeCommands(input.initiativeVerification ?? deriveInitiativeVerification(input.tasks), "initiative");
  const contract = planIdentity(input.goal.trim(), input.plan?.trim(), input.linkedPlanContent, 1, initiativeVerification);
  const tasks = input.tasks.map((task) => normalizeTask(task, { contract, compatibility: false }));
  validateTaskGraph(tasks);
  return {
    version: WORKFLOW_VERSION, topic: input.topic, revision: 1, status: "draft", goal: input.goal.trim(),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}), contract, initiativeVerification,
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

export function reviseWorkflow(workflow: Workflow, input: { goal?: string; plan?: string; linkedPlanContent?: string; initiativeVerification?: VerificationCommand[]; tasks: WorkflowTaskRevision[] }, now = new Date().toISOString()): WorkflowDecision {
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
  const initiativeVerification = normalizeCommands(input.initiativeVerification ?? workflow.initiativeVerification, "initiative");
  const nextPlan = planIdentity(goal, plan, linkedPlanContent, workflow.contract.revision, initiativeVerification);
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
      verificationDriftPaths: contractChanged ? [] : previous.verificationDriftPaths,
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
    goal, ...(plan ? { plan } : { plan: undefined }), contract, initiativeVerification, tasks, status,
    ...(anyContractChange ? { planReview: undefined, closeout: undefined, initiativeAcceptance: undefined, orchestration: { ...workflow.orchestration, phase: "plan-review", activeRun: undefined } } : {}),
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
  if (workflow.orchestration.runtimeHandoff?.phase === "prepared" && event.type !== "reclaim-runtime-handoff") throw new Error("runtime handoff is prepared; only exact fresh-parent reclaim may mutate the workflow");
  if (event.type === "claim-parent") return claimParent(workflow, event.authority, now);
  if (event.type === "invalidate-parent") return invalidateParent(workflow, event, now);
  if (event.type === "fence-parent") return fenceParent(workflow, event, now);
  if (event.type === "recover-parent") return recoverParent(workflow, event, now);
  if (event.type === "prepare-runtime-handoff") return prepareRuntimeHandoff(workflow, event, now);
  if (event.type === "reclaim-runtime-handoff") return reclaimRuntimeHandoff(workflow, event, now);
  if (event.type === "rotate-runtime-parent") return rotateRuntimeParent(workflow, event, now);
  if (event.type === "claim-run") return claimRun(workflow, event.lease, now);
  if (event.type === "cancel-run") return cancelRun(workflow, event.lease, event.reason, now);
  if (event.type === "respond-clarification") return respondClarification(workflow, event, now);
  if (event.type === "record-run-failure") return recordRunFailure(workflow, event, now);
  if (event.type === "pause") {
    if (workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
    return update(workflow, { status: "paused" }, now, "workflow paused");
  }
  if (event.type === "record-plan-review") return recordPlanReview(workflow, event.report, now);
  if (event.type === "adopt-bootstrap") return adoptBootstrap(workflow, event.adoption, now);
  if (workflow.orchestration.mode === "legacy") return reduceLegacyWorkflow(workflow, event, now);
  return reduceOrchestratedWorkflow(workflow, event, now);
}

function reduceOrchestratedWorkflow(workflow: Workflow, event: Exclude<WorkflowEvent, { type: "claim-parent" | "invalidate-parent" | "fence-parent" | "recover-parent" | "prepare-runtime-handoff" | "reclaim-runtime-handoff" | "rotate-runtime-parent" | "claim-run" | "cancel-run" | "pause" | "record-plan-review" | "record-run-failure" }>, now: string): WorkflowDecision {
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
    const phase: TaskPhase = current && workflow.status === "paused" && current.status === "active"
      ? current.phase
      : next.phase === "pending" || next.phase === "remediation" ? "implementation" : next.phase;
    return replaceTask(workflow, next.id, { status: "active", phase, remediation, blockedReason: undefined }, { status: "active", activeTask: next.id, orchestration: { ...workflow.orchestration, phase: "task-execution" } }, now, `${event.type === "resume" ? "resumed" : "started"} ${next.id}`);
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
    const receipt = event.receipt ? normalizeWorkspaceReceipt(event.receipt) : undefined;
    if (receipt) {
      if (workflow.orchestration.mode === "multi-agent" && (receipt.version !== 1 || !receipt.preparedResultCommit || !receipt.preparedResultRef || !receipt.preparedPatchHash)) throw new Error("implementation requires a recoverable prepared workspace receipt");
      if (receipt.changedPaths.some((path) => !scopeAllows(current!.writeScope, path))) throw new Error("workspace receipt contains an out-of-scope path");
      if (report.provenance.snapshotHash !== receipt.snapshotHash || !sameStringSet(report.changedPaths ?? [], receipt.changedPaths)) throw new Error("implementation report does not match its prepared cumulative source snapshot");
    }
    if (["completed", "no-change"].includes(report.outcome) && !receipt) throw new Error("implementation completion requires a prepared workspace receipt");
    const patch: Partial<WorkflowTask> = { ...appendTaskReport(current!, report), ...(receipt ? { workspaceReceipt: receipt, integrationReceipt: undefined, verificationDriftPaths: [] } : {}) };
    if (report.outcome === "needs-input") return replaceTask(workflow, current!.id, { ...patch, status: "blocked", phase: "implementation", blockedReason: "implementation needs clarification" }, { status: "blocked", activeTask: undefined }, now, `${current!.id} needs input`);
    if (report.outcome === "failed") return replaceTask(workflow, current!.id, { ...patch, status: "blocked", phase: "implementation", blockedReason: "implementation failed" }, { status: "blocked", activeTask: undefined }, now, `${current!.id} implementation failed`);
    return replaceTask(workflow, current!.id, { ...patch, phase: "general-review" }, {}, now, `recorded implementation report for ${current!.id}`);
  }
  if (event.type === "record-review") {
    if (!current || !["general-review", "concern-review"].includes(current.phase)) throw new Error("review report is not valid in the current task stage");
    const expectedKind = current.phase === "general-review" ? "general-review" : "concern-review";
    const expectedRole = current.phase === "general-review" ? "general-reviewer" : "concern-reviewer";
    const report = normalizeReport(event.report);
    requireReport(report, expectedKind, expectedRole, current.contract.hash, workflow.orchestration.activeRun);
    const implementation = [...current.reports].reverse().find((item) => item.kind === "implementation");
    if (!implementation) throw new Error("review requires an implementation report");
    if (implementation.provenance.runId === report.provenance.runId || implementation.provenance.actorId === report.provenance.actorId) throw new Error("self-review is not permitted");
    const priorGeneral = [...current.reports].reverse().find((item) => item.kind === "general-review");
    if (expectedKind === "concern-review" && priorGeneral && (priorGeneral.provenance.runId === report.provenance.runId || priorGeneral.provenance.actorId === report.provenance.actorId)) throw new Error("independent reviewers must use distinct fresh actors");
    if (!implementation.provenance.snapshotHash || report.provenance.snapshotHash !== implementation.provenance.snapshotHash || report.provenance.snapshotHash !== current.workspaceReceipt?.snapshotHash) throw new Error("review report has a stale source snapshot");
    if (report.findings.some((finding) => finding.status === "accepted-risk")) throw new Error("reviewers cannot accept blocking risk on the user's behalf");
    const patch = appendTaskReport(current, report);
    const unresolved = patch.findings!.some((finding) => finding.severity === "blocking" && finding.status === "open");
    if (report.outcome === "needs-input") return replaceTask(workflow, current.id, { ...patch, status: "blocked", blockedReason: `${expectedKind} needs clarification` }, { status: "blocked", activeTask: undefined }, now, `${current.id} needs input`);
    if (report.outcome === "failed") return replaceTask(workflow, current.id, { ...patch, status: "blocked", blockedReason: `${expectedKind} failed` }, { status: "blocked", activeTask: undefined }, now, `${current.id} review failed`);
    if (report.outcome === "changes-requested" || unresolved) return replaceTask(workflow, current.id, { ...patch, status: "blocked", phase: "remediation", blockedReason: "review has unresolved blocking findings" }, { status: "blocked", activeTask: undefined }, now, `${current.id} requires remediation`);
    if (report.outcome !== "approved") throw new Error("review must approve, request changes, or report blocking findings");
    const nextPhase: TaskPhase = current.phase === "general-review" && requiresConcernReview(current) ? "concern-review" : implementation.outcome === "no-change" ? (current.verification.length ? "verification" : "ready-to-complete") : "workspace";
    return replaceTask(workflow, current.id, { ...patch, phase: nextPhase, ...(nextPhase === "verification" ? { verificationCheckpoint: { revision: workflow.revision + 1, at: now } } : {}) }, {}, now, `recorded ${expectedKind} for ${current.id}`);
  }
  if (event.type === "record-workspace") {
    requireTaskPhase(current, "workspace");
    const receipt = normalizeWorkspaceReceipt(event.receipt);
    const implementation = [...current!.reports].reverse().find((report) => report.kind === "implementation");
    const general = [...current!.reports].reverse().find((report) => report.kind === "general-review");
    const concern = [...current!.reports].reverse().find((report) => report.kind === "concern-review");
    if (workflow.orchestration.mode === "multi-agent" && (receipt.version !== 1 || !receipt.preparedResultCommit || !receipt.preparedResultRef || !receipt.preparedPatchHash)) throw new Error("multi-agent execution requires a recoverable prepared workspace receipt");
    if (!implementation || !approvedReport(general, current!.contract.hash) || general?.provenance.snapshotHash !== receipt.snapshotHash || (requiresConcernReview(current!) && (!approvedReport(concern, current!.contract.hash) || concern?.provenance.snapshotHash !== receipt.snapshotHash))) throw new Error("workspace cannot advance without current snapshot-bound independent approvals");
    if (receipt.changedPaths.some((path) => !scopeAllows(current!.writeScope, path))) throw new Error("workspace receipt contains an out-of-scope path");
    if (receipt.version === 1) {
      if (receipt.baselineHash !== receipt.realSourceSnapshotHash) throw new Error("workspace receipt baseline does not match its source preimage");
      if (implementation?.provenance.snapshotHash !== receipt.snapshotHash) throw new Error("workspace receipt does not match the reviewed implementation snapshot");
      if (!sameStringSet(implementation.changedPaths ?? [], receipt.changedPaths)) throw new Error("workspace receipt paths do not match the implementation report");
      if (!sameStringSet(receipt.writeScope ?? [], current!.writeScope)) throw new Error("workspace receipt does not match the task write scope");
    }
    return replaceTask(workflow, current!.id, { workspaceReceipt: receipt, phase: "integration" }, {}, now, `recorded workspace receipt for ${current!.id}`);
  }
  if (event.type === "record-integration") {
    requireTaskPhase(current, "integration");
    const workspaceSnapshot = current!.workspaceReceipt?.snapshotHash;
    const implementation = [...current!.reports].reverse().find((report) => report.kind === "implementation");
    const general = [...current!.reports].reverse().find((report) => report.kind === "general-review");
    const concern = [...current!.reports].reverse().find((report) => report.kind === "concern-review");
    if (!workspaceSnapshot || implementation?.provenance.snapshotHash !== workspaceSnapshot || general?.provenance.snapshotHash !== workspaceSnapshot || !approvedReport(general, current!.contract.hash) || (requiresConcernReview(current!) && (concern?.provenance.snapshotHash !== workspaceSnapshot || !approvedReport(concern, current!.contract.hash)))) throw new Error("integration requires all current snapshot-bound independent approvals");
    const receipt = normalizeIntegrationReceipt(event.receipt);
    if (workflow.orchestration.mode === "multi-agent" && receipt.version !== 1) throw new Error("multi-agent execution requires a recoverable versioned integration receipt");
    const workspaceReceipt = current!.workspaceReceipt;
    if (receipt.preSnapshotHash !== workspaceReceipt?.baselineHash) throw new Error("integration receipt does not match the workspace baseline");
    if (workspaceReceipt?.version === 1 && receipt.version !== 1) throw new Error("versioned workspace requires a recoverable integration receipt");
    if (receipt.version === 1 && (
      receipt.workspaceId !== workspaceReceipt?.workspaceId || receipt.postSnapshotHash !== workspaceReceipt.snapshotHash ||
      receipt.resultCommit !== workspaceReceipt.preparedResultCommit || receipt.resultRef !== workspaceReceipt.preparedResultRef ||
      receipt.patchHash !== workspaceReceipt.preparedPatchHash || receipt.observedHead !== workspaceReceipt.realHead || receipt.observedBranch !== workspaceReceipt.realBranch || receipt.observedIndexHash !== workspaceReceipt.realIndexHash || !sameStringSet(receipt.changedPaths ?? [], workspaceReceipt.changedPaths)
    )) throw new Error("integration receipt does not match the prepared workspace result");
    const phase: TaskPhase = current!.verification.length ? "verification" : current!.verificationDecision ? "ready-to-complete" : "verification";
    return replaceTask(workflow, current!.id, { integrationReceipt: receipt, phase, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, {}, now, `recorded integration receipt for ${current!.id}`);
  }
  if (event.type === "record-verification") {
    requireTaskPhase(current, "verification");
    const evidence = normalizeEvidence(event.evidence);
    if (evidence.exitCode !== 0) throw new Error("failing verification must enter remediation");
    if (!current!.verificationCheckpoint || !evidenceMatchesCheckpoint(evidence, current!.verificationCheckpoint)) throw new Error("verification evidence is not a fresh protected-bash result after integration");
    if (evidence.contractHash !== current!.contract.hash) throw new Error("verification evidence has a stale contract");
    if (evidence.snapshotHash !== taskVerificationSnapshot(current!)) throw new Error("verification evidence has a stale snapshot");
    const nextEvidence = boundedAppend(current!.evidence, evidence, 32, "verification evidence");
    const phase = verificationSatisfied(current!, nextEvidence) ? "ready-to-complete" : "verification";
    return replaceTask(workflow, current!.id, { evidence: nextEvidence, phase }, {}, now, `recorded verification for ${current!.id}`);
  }
  if (event.type === "invalidate-integrated-source") {
    if (!current || !["verification", "ready-to-complete"].includes(current.phase) || !taskVerificationSnapshot(current)) throw new Error("integrated source invalidation is not valid in the current task stage");
    if (event.observedSnapshotHash === taskVerificationSnapshot(current)) return unchanged(workflow, "integrated source snapshot is unchanged");
    const observedChangedPaths = boundedStrings(event.observedChangedPaths, "source drift paths", 128, 512);
    if (!observedChangedPaths.length || observedChangedPaths.some((path) => !SAFE_SCOPE.test(path) || path.includes("*"))) throw new Error("source drift requires bounded exact changed paths");
    const finding: Finding = { id: `source-drift-${current.remediation.used}-${current.evidence.length + 1}`, severity: "blocking", status: "open", summary: "verification changed the protected source snapshot", evidence: boundedText(event.reason, "source drift reason") };
    return replaceTask(workflow, current.id, {
      evidence: [], findings: boundedMergeFindings(current.findings, [finding], MAX_FINDINGS), verificationDriftPaths: observedChangedPaths,
      status: "blocked", phase: "remediation", blockedReason: "integrated source changed; cumulative remediation and complete re-review required",
    }, { status: "blocked", activeTask: undefined }, now, `${current.id} source drift requires remediation`);
  }
  if (event.type === "record-verification-failure") {
    requireTaskPhase(current, "verification");
    const evidence = normalizeEvidence(event.evidence);
    if (!current!.verificationCheckpoint || !evidenceMatchesCheckpoint(evidence, current!.verificationCheckpoint)) throw new Error("verification failure is not a fresh protected-bash result after integration");
    if (evidence.contractHash !== current!.contract.hash || evidence.snapshotHash !== taskVerificationSnapshot(current!)) throw new Error("verification failure evidence is stale");
    const sourceChanged = event.observedSnapshotHash !== taskVerificationSnapshot(current!);
    if (evidence.exitCode === 0 && !sourceChanged) throw new Error("passing unchanged verification is not a failure");
    const observedChangedPaths = boundedStrings(event.observedChangedPaths, "verification changed paths", 128, 512);
    if (observedChangedPaths.some((path) => !SAFE_SCOPE.test(path) || path.includes("*"))) throw new Error("verification changed paths contain an unsafe or non-exact path");
    if (sourceChanged && !observedChangedPaths.length) throw new Error("source-changing verification requires explicit changed paths for cumulative remediation");
    const id = `verification-${current!.remediation.used}-${current!.evidence.length + 1}`;
    const finding: Finding = { id, severity: "blocking", status: "open", summary: sourceChanged ? "verification changed the protected source snapshot" : "protected verification failed", evidence: boundedText(event.reason, "verification failure reason") };
    return replaceTask(workflow, current!.id, {
      evidence: boundedAppend(current!.evidence, evidence, 32, "verification evidence"),
      findings: boundedMergeFindings(current!.findings, [finding], MAX_FINDINGS), verificationDriftPaths: observedChangedPaths, status: "blocked", phase: "remediation",
      blockedReason: sourceChanged ? "verification changed source; cumulative remediation and re-review required" : "verification failed; cumulative remediation and re-review required",
    }, { status: "blocked", activeTask: undefined }, now, `${current!.id} verification requires remediation`);
  }
  if (event.type === "decide-finding") return decideFinding(workflow, event, now);
  if (event.type === "reset-remediation") return resetRemediation(workflow, event, now);
  if (event.type === "complete-task") return completeOrchestratedTask(workflow, current, now);
  if (event.type === "begin-initiative-closeout") {
    requireCloseoutPhase(workflow);
    if (workflow.closeout) throw new Error("initiative closeout is already checkpointed");
    if (!workflow.initiativeVerification.length) throw new Error("initiative closeout requires integration checks established by the approved plan");
    const parent = requireValidParent(workflow);
    const snapshot = normalizeRepositorySnapshot(event.snapshot);
    const closeout: InitiativeCloseout = {
      snapshot, cumulativeDeltaHash: requireDigest(event.cumulativeDeltaHash, "cumulative delta hash"),
      checkpoint: { revision: workflow.revision + 1, at: now, ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, branchLength: validBranchLength(event.branchLength) },
      evidence: [], unresolvedRisks: boundedStrings(event.unresolvedRisks, "unresolved initiative risks", 64, 1024), blockingRisks: boundedStrings(event.blockingRisks ?? event.unresolvedRisks, "blocking initiative risks", 64, 1024), followUpTaskIds: [],
    };
    return update(workflow, { closeout, initiativeAcceptance: undefined, status: "paused" }, now, "initiative closeout checkpointed");
  }
  if (event.type === "record-initiative-verification") {
    requireCloseoutPhase(workflow);
    const closeout = requireFreshCloseout(workflow, event.observedSnapshot);
    const evidence = normalizeEvidence(event.evidence);
    requireCloseoutEvidence(workflow, closeout, evidence);
    const nextEvidence = boundedAppend(closeout.evidence, evidence, 32, "initiative verification evidence");
    if (evidence.exitCode !== 0) return update(workflow, { closeout: { ...closeout, evidence: nextEvidence }, status: "blocked", initiativeAcceptance: undefined }, now, "initiative integration verification failed");
    return update(workflow, { closeout: { ...closeout, evidence: nextEvidence } }, now, "recorded initiative integration verification");
  }
  if (event.type === "record-initiative-acceptance") {
    requireCloseoutPhase(workflow);
    const closeout = requireCompleteCloseoutVerification(workflow);
    const report = normalizeReport(event.report);
    requireReport(report, "final-acceptance", "final-reviewer", workflow.contract.hash, workflow.orchestration.activeRun);
    if (report.provenance.snapshotHash !== closeout.snapshot.hash || Date.parse(report.provenance.startedAt) <= Date.parse(closeout.checkpoint.at) || Date.parse(report.provenance.completedAt) < Date.parse(report.provenance.startedAt)) throw new Error("final acceptance is not fresh for the repository checkpoint");
    if (report.findings.some((finding) => finding.status === "accepted-risk")) throw new Error("final reviewers cannot accept risk on the user's behalf");
    const priorIdentities = workflowRunnerIdentities(workflow);
    if (priorIdentities.has(report.provenance.runId) || priorIdentities.has(report.provenance.actorId)) throw new Error("final self-review or reviewer identity reuse is not permitted");
    const hasOpenBlocking = report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open");
    if (report.outcome === "approved" && hasOpenBlocking) throw new Error("final acceptance cannot approve with unresolved blocking findings");
    const orchestration = { ...workflow.orchestration, history: appendHistory(workflow.orchestration.history, { id: `final-acceptance-${workflow.revision + 1}`, type: "final-acceptance", at: now, summary: `${report.outcome}: ${report.summary}`, provenance: report.provenance, auditCritical: true }) };
    if (report.outcome === "needs-input") return update(workflow, { initiativeAcceptance: report, closeout: { ...closeout, manualValidation: { status: "required", rationale: report.rationale ?? report.summary, at: now } }, status: "paused", orchestration }, now, "final acceptance requires explicit user or manual validation");
    if (report.outcome === "changes-requested" || report.outcome === "failed" || hasOpenBlocking) return update(workflow, { initiativeAcceptance: report, status: "blocked", orchestration }, now, "final acceptance requested scoped follow-up work");
    if (report.outcome !== "approved") throw new Error("invalid final acceptance outcome");
    return update(workflow, { initiativeAcceptance: report, status: "paused", orchestration }, now, "recorded independent initiative acceptance");
  }
  if (event.type === "record-manual-validation") {
    requireCloseoutPhase(workflow);
    const closeout = workflow.closeout;
    if (!closeout?.manualValidation || closeout.manualValidation.status !== "required") throw new Error("manual validation was not requested by final acceptance");
    const outcome = normalizeManualValidation(event.outcome);
    if (Date.parse(outcome.at) < Date.parse(closeout.manualValidation.at) || Date.parse(outcome.at) > Date.parse(now)) throw new Error("manual validation outcome is stale or future-dated");
    if (workflowRunnerIdentities(workflow).has(outcome.decidedBy!)) throw new Error("a workflow child cannot provide user manual validation");
    return update(workflow, { closeout: { ...closeout, manualValidation: outcome }, ...(outcome.status === "approved" ? { initiativeAcceptance: undefined } : {}), status: outcome.status === "approved" ? "paused" : "blocked" }, now, `manual validation ${outcome.status}`);
  }
  if (event.type === "add-closeout-follow-up") return addCloseoutFollowUp(workflow, event.task, now);
  if (event.type === "invalidate-initiative-closeout") {
    requireCloseoutPhase(workflow);
    normalizeRepositorySnapshot(event.observedSnapshot);
    if (!workflow.closeout) return unchanged(workflow, "initiative closeout is already invalidated");
    return update(workflow, { closeout: undefined, initiativeAcceptance: undefined, status: "blocked" }, now, `initiative closeout invalidated: ${boundedText(event.reason, "closeout invalidation reason")}`);
  }
  if (event.type === "complete-initiative") {
    const closeout = requireCompleteCloseoutVerification(workflow);
    requireFreshCloseout(workflow, event.observedSnapshot);
    if (!approvedReport(workflow.initiativeAcceptance, workflow.contract.hash) || workflow.initiativeAcceptance?.provenance.snapshotHash !== closeout.snapshot.hash) throw new Error("initiative completion requires fresh independent final acceptance");
    if (closeout.blockingRisks.length || workflow.tasks.some((task) => task.status === "blocked" || task.findings.some((finding) => finding.severity === "blocking" && finding.status === "open"))) throw new Error("initiative completion has unresolved blockers or risks");
    const parent = requireValidParent(workflow);
    if (closeout.checkpoint.ownerId !== parent.ownerId || closeout.checkpoint.sessionId !== parent.sessionId || closeout.checkpoint.runtimeId !== parent.runtimeId || validBranchLength(event.branchLength) < closeout.checkpoint.branchLength) throw new Error("initiative completion parent, session, or branch provenance is stale");
    return update(workflow, { status: "complete", orchestration: { ...workflow.orchestration, phase: "complete", activeRun: undefined } }, now, "workflow implementation accepted; commit, push, deployment, release, and external side effects remain separately authorized");
  }
  throw new Error("event is not valid in the current orchestration stage");
}

function reduceLegacyWorkflow(workflow: Workflow, event: Exclude<WorkflowEvent, { type: "claim-parent" | "invalidate-parent" | "fence-parent" | "recover-parent" | "prepare-runtime-handoff" | "reclaim-runtime-handoff" | "rotate-runtime-parent" | "claim-run" | "cancel-run" | "pause" | "record-plan-review" | "record-run-failure" }>, now: string): WorkflowDecision {
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
  const missingChecks = current.verification.filter((planned) => !currentEvidence.some((item) => item.exitCode === 0 && legacyCommandKey(item) === legacyCommandKey(planned)));
  if (!event.allowGap && (latestEvidence?.exitCode !== 0 || !checkpoint || !latestEvidence || !evidenceMatchesCheckpoint(latestEvidence, checkpoint) || missingChecks.length)) return unchanged(workflow, `${current.id} requires passing protected bash results recorded after its activation/revision checkpoint${missingChecks.length ? `; missing passing checks: ${missingChecks.map(commandDisplay).join(", ")}` : ""}`);
  const completed = replaceTask(workflow, current.id, { status: "complete", phase: "historical", blockedReason: undefined, completedAt: now }, { activeTask: undefined }, now, `completed ${current.id}`).workflow;
  const next = readyTasks(completed)[0];
  if (next) return replaceTask(completed, next.id, { status: "active", phase: "implementation", verificationCheckpoint: { revision: completed.revision + 1, at: now } }, { status: "active", activeTask: next.id }, now, `completed ${current.id}; started ${next.id}`);
  const unfinished = completed.tasks.some((task) => ["pending", "active", "blocked"].includes(task.status));
  return update(completed, { status: unfinished ? "blocked" : "complete", orchestration: { ...completed.orchestration, phase: unfinished ? "task-execution" : "complete" } }, now, unfinished ? `completed ${current.id}; remaining work is blocked` : `completed ${current.id}; workflow complete`);
}

function claimParent(workflow: Workflow, raw: ParentAuthority, now: string): WorkflowDecision {
  if (workflow.orchestration.mode !== "multi-agent" || workflow.orchestration.phase === "complete") throw new Error("parent authority is available only during managed multi-agent execution");
  const authority = normalizeParentAuthority(raw);
  if (!authority.valid) throw new Error("new parent authority must be valid");
  const current = workflow.orchestration.parent;
  if (current) {
    if (current.valid && current.ownerId === authority.ownerId && current.sessionId === authority.sessionId && current.runtimeId === authority.runtimeId && current.cwd === authority.cwd) return unchanged(workflow, "parent authority already claimed by this runtime");
    throw new Error(current.valid ? "managed workflow is owned by a competing parent session" : "parent authority was invalidated; explicit recovery and fresh checkpoints are required");
  }
  return update(workflow, { orchestration: { ...workflow.orchestration, parent: authority } }, now, `claimed parent authority for ${authority.ownerId}`);
}

function staleAuthorityPatch(workflow: Workflow): Pick<Workflow, "tasks" | "closeout" | "initiativeAcceptance"> {
  const tasks = workflow.tasks.map((task) => ({
    ...task,
    ...(["verification", "ready-to-complete"].includes(task.phase) ? { phase: "verification" as const, evidence: [] } : {}),
    verificationCheckpoint: undefined,
  }));
  return { tasks, closeout: undefined, initiativeAcceptance: undefined };
}

function invalidateParent(workflow: Workflow, event: Extract<WorkflowEvent, { type: "invalidate-parent" }>, now: string): WorkflowDecision {
  if (workflow.orchestration.runtimeHandoff?.phase === "reclaimed") throw new Error("reclaimed runtime authority must use the atomic parent fence transition");
  return fenceParent(workflow, { ...event, type: "fence-parent" }, now);
}

function fenceParent(workflow: Workflow, event: Extract<WorkflowEvent, { type: "fence-parent" }>, now: string): WorkflowDecision {
  const parent = workflow.orchestration.parent;
  if (!parent || !parent.valid || parent.ownerId !== event.ownerId || parent.sessionId !== event.sessionId || parent.runtimeId !== event.runtimeId) throw new Error("parent fence does not match current authority");
  const reason = boundedText(event.reason, "parent fence reason");
  return update(workflow, {
    status: workflow.status === "complete" ? workflow.status : "paused", ...staleAuthorityPatch(workflow),
    orchestration: { ...workflow.orchestration, nextFence: workflow.orchestration.nextFence + 1, activeRun: undefined, parent: { ...parent, valid: false, invalidatedAt: now, invalidatedReason: reason } },
  }, now, `fenced parent authority: ${reason}`);
}

function recoverParent(workflow: Workflow, event: Extract<WorkflowEvent, { type: "recover-parent" }>, now: string): WorkflowDecision {
  const current = workflow.orchestration.parent;
  if (!current || current.valid) throw new Error("parent recovery requires an explicitly invalidated authority");
  if (workflow.orchestration.activeRun && Date.parse(workflow.orchestration.activeRun.expiresAt) > Date.parse(now)) throw new Error("parent recovery cannot take ownership from a live child run");
  const authority = normalizeParentAuthority(event.authority);
  if (!authority.valid || authority.cwd !== current.cwd) throw new Error("recovered parent must be valid and remain in the same repository");
  const decidedBy = boundedText(event.decidedBy, "parent recovery decision owner", 128);
  const reason = boundedText(event.reason, "parent recovery reason");
  const tasks = workflow.tasks.map((task) => task.id === workflow.activeTask && ["verification", "ready-to-complete"].includes(task.phase)
    ? { ...task, phase: "verification" as const, evidence: [], verificationCheckpoint: undefined }
    : task);
  const history = appendHistory(workflow.orchestration.history, { id: `parent-recovery-${workflow.revision + 1}`, type: "parent-recovered", at: now, summary: `${reason}; decided by ${decidedBy}`, auditCritical: true });
  return update(workflow, {
    status: "paused", tasks,
    ...(workflow.orchestration.phase === "initiative-acceptance" ? { closeout: undefined, initiativeAcceptance: undefined } : {}),
    orchestration: { ...workflow.orchestration, parent: authority, activeRun: undefined, history },
  }, now, `recovered parent authority for ${authority.ownerId}; fresh checkpoints are required`);
}

function prepareRuntimeHandoff(workflow: Workflow, event: Extract<WorkflowEvent, { type: "prepare-runtime-handoff" }>, now: string): WorkflowDecision {
  if (workflow.orchestration.mode !== "multi-agent" || workflow.orchestration.phase === "complete") throw new Error("runtime handoff requires a managed multi-agent workflow");
  if (workflow.orchestration.activeRun) throw new Error("runtime handoff requires a durable no-child checkpoint");
  if (workflow.orchestration.runtimeHandoff?.phase === "prepared") throw new Error("a runtime handoff is already prepared");
  const id = boundedText(event.handoff.id, "runtime handoff id", 128);
  const decisionId = boundedText(event.handoff.decisionId, "runtime handoff decision id", 128);
  if (!Number.isSafeInteger(event.handoff.selectorGeneration) || event.handoff.selectorGeneration < 1) throw new Error("runtime handoff selector generation is invalid");
  const parent = workflow.orchestration.parent;
  if (parent && !parent.valid) throw new Error("runtime handoff cannot begin from invalid parent authority");
  const invalidatedParent = parent ? { ...parent, valid: false, invalidatedAt: now, invalidatedReason: `runtime handoff ${id} prepared` } : undefined;
  const tasks = workflow.tasks.map((task) => task.id === workflow.activeTask
    ? { ...task, verificationCheckpoint: undefined, ...(["verification", "ready-to-complete"].includes(task.phase) ? { phase: "verification" as const, evidence: [] } : {}) }
    : task);
  const decision = normalizeGate2DecisionAttestation(event.handoff.decision);
  if (decision.decisionId !== decisionId) throw new Error("runtime handoff decision attestation identity does not match");
  const runtimeHandoff: RuntimeHandoff = { ...event.handoff, id, decisionId, decision, phase: "prepared", preparedAt: now, ...(parent ? { previousParent: parent } : {}) };
  const history = appendHistory(workflow.orchestration.history, { id: `runtime-handoff-${workflow.revision + 1}-prepared`, type: "runtime-handoff-prepared", at: now, summary: `${event.handoff.from} to ${event.handoff.to}; decision ${decisionId}`, auditCritical: true });
  return update(workflow, {
    status: "paused", tasks,
    ...(workflow.orchestration.phase === "initiative-acceptance" ? { closeout: undefined, initiativeAcceptance: undefined } : {}),
    orchestration: { ...workflow.orchestration, nextFence: workflow.orchestration.nextFence + 1, activeRun: undefined, ...(invalidatedParent ? { parent: invalidatedParent } : {}), runtimeHandoff, history },
  }, now, `prepared runtime handoff ${id} at a durable no-child checkpoint`);
}

function reclaimRuntimeHandoff(workflow: Workflow, event: Extract<WorkflowEvent, { type: "reclaim-runtime-handoff" }>, now: string): WorkflowDecision {
  const handoff = workflow.orchestration.runtimeHandoff;
  if (!handoff || handoff.phase !== "prepared" || handoff.id !== event.handoffId || handoff.decisionId !== event.decisionId || handoff.selectorGeneration !== event.selectorGeneration) throw new Error("runtime handoff reclaim does not match the durable prepared checkpoint");
  if (workflow.orchestration.activeRun) throw new Error("runtime handoff reclaim requires no active child");
  const authority = normalizeParentAuthority(event.authority);
  if (!authority.valid) throw new Error("reclaimed parent authority must be valid");
  const previous = handoff.previousParent;
  if (previous && (authority.cwd !== previous.cwd || authority.ownerId !== previous.ownerId || authority.sessionId !== previous.sessionId || authority.runtimeId === previous.runtimeId)) throw new Error("runtime handoff must preserve owner, session, and repository while using a fresh parent runtime");
  if (workflow.orchestration.parent?.valid) throw new Error("runtime handoff cannot replace live parent authority");
  if (!handoff.decision) throw new Error("runtime handoff reclaim requires its durable Gate 2 decision attestation");
  const reclaimed: RuntimeHandoff = { ...handoff, phase: "reclaimed", reclaimedAt: now };
  const history = appendHistory(workflow.orchestration.history, { id: `runtime-handoff-${workflow.revision + 1}-reclaimed`, type: "runtime-handoff-reclaimed", at: now, summary: `${handoff.to} generation ${handoff.selectorGeneration}; parent ${authority.runtimeId}`, auditCritical: true });
  return update(workflow, { status: "paused", orchestration: { ...workflow.orchestration, parent: authority, activeRun: undefined, runtimeHandoff: reclaimed, history } }, now, `reclaimed workflow under fresh ${handoff.to} parent authority`);
}

function rotateRuntimeParent(workflow: Workflow, event: Extract<WorkflowEvent, { type: "rotate-runtime-parent" }>, now: string): WorkflowDecision {
  if (workflow.orchestration.mode !== "multi-agent" || workflow.orchestration.phase === "complete") throw new Error("runtime parent rotation requires a managed workflow");
  const previous = workflow.orchestration.parent;
  if (!previous) throw new Error("runtime parent rotation requires current fenced or valid authority");
  const authority = normalizeParentAuthority(event.authority);
  if (!authority.valid || authority.ownerId !== previous.ownerId || authority.sessionId !== previous.sessionId || authority.cwd !== previous.cwd || authority.runtimeId === previous.runtimeId) throw new Error("runtime parent rotation must preserve owner, session, and cwd while installing a fresh runtime id");
  if (!Number.isSafeInteger(event.selectorGeneration) || event.selectorGeneration !== (workflow.orchestration.runtimeHandoff?.selectorGeneration ?? 0) + 1) throw new Error("runtime parent rotation selector generation is stale");
  const handoff: RuntimeHandoff = {
    id: boundedText(event.handoffId, "runtime rotation id", 128), decisionId: boundedText(event.decisionId, "runtime rotation decision id", 128),
    from: event.from, to: event.to, phase: "reclaimed", selectorGeneration: event.selectorGeneration, preparedAt: now, reclaimedAt: now, previousParent: previous,
  };
  const history = appendHistory(workflow.orchestration.history, { id: `runtime-parent-${workflow.revision + 1}-rotated`, type: "runtime-parent-rotated", at: now, summary: `${event.to} generation ${event.selectorGeneration}; parent ${authority.runtimeId}`, auditCritical: true });
  return update(workflow, {
    status: "paused", ...staleAuthorityPatch(workflow),
    orchestration: { ...workflow.orchestration, nextFence: workflow.orchestration.nextFence + 1, activeRun: undefined, parent: authority, runtimeHandoff: handoff, history },
  }, now, `atomically rotated ${event.to} parent authority`);
}

function recordRunFailure(workflow: Workflow, event: Extract<WorkflowEvent, { type: "record-run-failure" }>, now: string): WorkflowDecision {
  const lease = workflow.orchestration.activeRun;
  if (!lease || lease.stage !== event.stage || lease.taskId !== event.taskId) throw new Error("run failure does not match the active fenced stage");
  const reason = boundedText(event.reason, "run failure reason");
  const history = appendHistory(workflow.orchestration.history, {
    id: `run-${lease.fence}-failed`, type: "run-failed", at: now, summary: reason,
    ...(event.taskId ? { taskId: event.taskId } : {}), auditCritical: true,
  });
  if (!event.taskId) return update(workflow, { status: "blocked", orchestration: { ...workflow.orchestration, history } }, now, `plan review blocked: ${reason}`);
  const task = workflow.tasks.find((candidate) => candidate.id === event.taskId);
  if (!task || workflow.activeTask !== task.id || task.status !== "active") throw new Error("run failure does not match the active task");
  return replaceTask(workflow, task.id, { status: "blocked", blockedReason: reason }, {
    status: "blocked", activeTask: undefined, orchestration: { ...workflow.orchestration, history },
  }, now, `${task.id} blocked: ${reason}`);
}

function adoptBootstrap(workflow: Workflow, raw: Omit<BootstrapAdoption, "adoptedAt">, now: string): WorkflowDecision {
  if (workflow.orchestration.mode !== "multi-agent") throw new Error("bootstrap adoption requires multi-agent orchestration");
  if (workflow.status !== "draft" || workflow.orchestration.phase !== "plan-review" || workflow.activeTask || workflow.planReview || workflow.bootstrapAdoption || workflow.orchestration.activeRun) throw new Error("bootstrap adoption is permitted only before the workflow has started");
  if (workflow.tasks.some((task) => task.status !== "pending" || task.phase !== "pending" || task.reports.length || task.evidence.length || task.workspaceReceipt || task.integrationReceipt || task.completedAt)) throw new Error("bootstrap adoption refuses a workflow that has already started");
  const snapshot = normalizeRepositorySnapshot(raw.snapshot);
  const taskIds = boundedStrings(raw.taskIds, "bootstrap task ids", MAX_TASKS, 64);
  if (!taskIds.length || taskIds.length >= workflow.tasks.length || taskIds.some((id, index) => id !== workflow.tasks[index]?.id)) throw new Error("bootstrap tasks must be a non-empty ordered workflow prefix that leaves native takeover work");
  const selected = workflow.tasks.slice(0, taskIds.length);
  if (workflow.tasks[selected.length]?.id !== BOOTSTRAP_NATIVE_TAKEOVER_TASK) throw new Error(`bootstrap adoption must stop before ${BOOTSTRAP_NATIVE_TAKEOVER_TASK}`);
  const selectedIds = new Set(taskIds);
  if (selected.some((task) => task.dependsOn.some((id) => !selectedIds.has(id)))) throw new Error("bootstrap task order omits a dependency");
  if (snapshot.changedPaths.some((path) => !selected.some((task) => scopeAllows(task.writeScope, path)))) throw new Error("bootstrap descendant delta contains a path outside adopted task scope");
  const anchorCommit = normalizeCommit(raw.anchorCommit, "bootstrap anchor commit");
  if (anchorCommit !== BOOTSTRAP_PLAN_ANCHOR) throw new Error("bootstrap adoption is not bound to the approved rollout-plan anchor");
  const descendantHead = normalizeCommit(raw.descendantHead, "bootstrap descendant HEAD");
  if (snapshot.head !== descendantHead) throw new Error("bootstrap snapshot HEAD does not match descendant provenance");

  const planReview = normalizeReport(raw.planReview);
  const generalReview = normalizeReport(raw.generalReview);
  requireReport(planReview, "plan-review", "plan-reviewer", workflow.contract.hash);
  requireReport(generalReview, "general-review", "general-reviewer", workflow.contract.hash);
  if (planReview.outcome !== "approved" || generalReview.outcome !== "approved") throw new Error("bootstrap adoption requires approved plan and general review");
  const requiredConcerns = [...new Set(selected.flatMap((task) => task.approaches.filter((approach) => CONCERN_APPROACHES.has(approach))))].sort();
  let concernReview: BootstrapAdoption["concernReview"];
  if (requiredConcerns.length) {
    if (!raw.concernReview || !sameStringSet(raw.concernReview.concerns, requiredConcerns)) throw new Error("bootstrap adoption requires one composed review for every selected specialist concern");
    const report = normalizeReport(raw.concernReview.report);
    requireReport(report, "concern-review", "concern-reviewer", workflow.contract.hash);
    if (report.outcome !== "approved") throw new Error("bootstrap concern review must approve the cumulative delta");
    concernReview = { concerns: requiredConcerns as WorkflowApproach[], report };
  } else if (raw.concernReview) throw new Error("bootstrap concern review cannot substitute for an unselected concern");
  const reviews = [planReview, generalReview, ...(concernReview ? [concernReview.report] : [])];
  const identities = new Set<string>();
  for (const review of reviews) {
    if (!review.changedPaths || !sameStringSet(review.changedPaths, snapshot.changedPaths)) throw new Error("bootstrap review does not cover the complete bounded descendant delta");
    if (review.provenance.snapshotHash !== snapshot.hash || Date.parse(review.provenance.startedAt) <= Date.parse(snapshot.capturedAt) || Date.parse(review.provenance.completedAt) > Date.parse(now)) throw new Error("bootstrap review is not fresh for the unchanged bootstrap snapshot");
    if (identities.has(review.provenance.runId) || identities.has(review.provenance.actorId)) throw new Error("bootstrap reviewers require distinct fresh run and actor provenance");
    identities.add(review.provenance.runId); identities.add(review.provenance.actorId);
  }
  const decisions = raw.decisions.map(normalizeBootstrapDecision);
  if (decisions.some((decision) => Date.parse(decision.at) <= Date.parse(snapshot.capturedAt) || Date.parse(decision.at) > Date.parse(now))) throw new Error("bootstrap finding decision is stale or future-dated");
  const blocking = reviews.flatMap((review) => review.findings).filter((finding) => finding.severity === "blocking" && finding.status === "open");
  if (blocking.some((finding) => !decisions.some((decision) => decision.findingId === finding.id))) throw new Error("bootstrap adoption has an unresolved or undecided blocking finding");

  const authorization = normalizeBootstrapAuthorization(raw.authorization, snapshot.capturedAt, now);
  const checks = raw.checks.map((item) => ({ taskId: boundedText(item.taskId, "bootstrap check task id", 64), evidence: normalizeEvidence(item.evidence) }));
  const expectedCheckCount = selected.reduce((count, task) => count + task.verification.length, 0);
  if (checks.length !== expectedCheckCount) throw new Error("bootstrap adoption requires one receipt for every exact task verification command");
  const toolCallIds = checks.map((item) => item.evidence.source?.toolCallId);
  if (toolCallIds.some((id) => !id) || new Set(toolCallIds).size !== toolCallIds.length) throw new Error("bootstrap check receipts require unique protected tool-call provenance");
  for (const task of selected) {
    const receipts = checks.filter((item) => item.taskId === task.id);
    if (receipts.length !== task.verification.length) throw new Error(`bootstrap verification receipts do not match ${task.id}`);
    const unused = [...receipts];
    for (const planned of task.verification) {
      const index = unused.findIndex((item) => commandKey(item.evidence) === commandKey(planned));
      if (index < 0) throw new Error(`missing exact bootstrap verification for ${task.id}: ${commandDisplay(planned)}`);
      const evidence = unused.splice(index, 1)[0]!.evidence;
      const source = evidence.source;
      if (evidence.exitCode !== 0 || evidence.contractHash !== task.contract.hash || evidence.snapshotHash !== snapshot.hash || evidence.beforeSnapshotHash !== snapshot.hash || evidence.afterSnapshotHash !== snapshot.hash || evidence.head !== snapshot.head || evidence.branch !== snapshot.branch || Date.parse(evidence.at) <= Date.parse(snapshot.capturedAt) || Date.parse(evidence.at) > Date.parse(now)) throw new Error("bootstrap verification is failing, stale, source-changing, or superseded");
      if (!source || source.kind !== "bash-tool-result" || source.toolName !== "bash" || source.workflowRevision !== workflow.revision || source.ownerId !== authorization.ownerId || source.sessionId !== authorization.sessionId || source.runtimeId !== authorization.runtimeId) throw new Error("bootstrap verification lacks exact protected v2 authority provenance");
    }
  }
  const tasks = workflow.tasks.map((task, index) => index < selected.length ? { ...task, status: "complete" as const, phase: "historical" as const, evidence: checks.filter((item) => item.taskId === task.id).map((item) => item.evidence), completedAt: now } : task);
  const adoption: BootstrapAdoption = { anchorCommit, descendantHead, snapshot, taskIds, planReview, generalReview, ...(concernReview ? { concernReview } : {}), checks, decisions, authorization, adoptedAt: now };
  const history = appendHistory(workflow.orchestration.history, { id: `bootstrap-adoption-${workflow.revision + 1}`, type: "bootstrap-adoption", at: now, summary: `authorized bootstrap adoption completed ${taskIds.length} ordered tasks from ${anchorCommit.slice(0, 12)} on snapshot ${snapshot.hash}`, auditCritical: true });
  return update(workflow, { tasks, planReview, bootstrapAdoption: adoption, status: "draft", orchestration: { ...workflow.orchestration, phase: "task-execution", history } }, now, `adopted ${taskIds.length} bootstrap tasks; ${workflow.tasks[selected.length]!.id} requires native start`);
}

function recordPlanReview(workflow: Workflow, raw: StageReport, now: string): WorkflowDecision {
  if (workflow.orchestration.mode === "multi-agent" && workflow.orchestration.phase !== "plan-review") throw new Error("plan review report is not valid after task execution begins");
  const report = normalizeReport(raw);
  requireReport(report, "plan-review", "plan-reviewer", workflow.contract.hash, workflow.orchestration.activeRun);
  if (report.outcome !== "approved") return update(workflow, { planReview: report, status: "blocked" }, now, "plan review requires revision or input");
  if (report.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) throw new Error("plan review cannot approve with unresolved blocking findings");
  const nextPhase: WorkflowPhase = workflow.tasks.every((task) => ["complete", "deferred"].includes(task.status)) ? "initiative-acceptance" : "task-execution";
  return update(workflow, { planReview: report, status: workflow.status === "blocked" ? "draft" : workflow.status, orchestration: { ...workflow.orchestration, phase: nextPhase } }, now, "plan review approved");
}

function completeOrchestratedTask(workflow: Workflow, current: WorkflowTask | undefined, now: string): WorkflowDecision {
  requireTaskPhase(current, "ready-to-complete");
  const implementation = [...current!.reports].reverse().find((report) => report.kind === "implementation");
  const general = [...current!.reports].reverse().find((report) => report.kind === "general-review");
  const concern = [...current!.reports].reverse().find((report) => report.kind === "concern-review");
  if (!implementation || !general) throw new Error("task completion requires implementation and independent general-review reports");
  if (implementation.provenance.runId === general.provenance.runId || implementation.provenance.actorId === general.provenance.actorId) throw new Error("self-review is not permitted");
  const snapshot = implementation.provenance.snapshotHash;
  if (!snapshot || general.provenance.snapshotHash !== snapshot || (requiresConcernReview(current!) && concern?.provenance.snapshotHash !== snapshot)) throw new Error("task completion requires approvals on the exact cumulative source snapshot");
  if (!approvedReport(general, current!.contract.hash) || (requiresConcernReview(current!) && !approvedReport(concern, current!.contract.hash))) throw new Error("task completion requires all independent approvals on the current contract");
  if (current!.findings.some((finding) => finding.severity === "blocking" && finding.status === "open")) throw new Error("task completion has an unresolved blocking finding");
  if (current!.verification.length && !verificationSatisfied(current!, current!.evidence)) throw new Error("task completion requires every planned objective check with no newer failure");
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

function requireCloseoutPhase(workflow: Workflow): void {
  if (!["initiative-acceptance", "complete"].includes(workflow.orchestration.phase) || workflow.tasks.some((task) => !["complete", "deferred"].includes(task.status))) throw new Error("initiative closeout requires every task gate to be terminal");
}
function requireValidParent(workflow: Workflow): ParentAuthority {
  const parent = workflow.orchestration.parent;
  if (!parent?.valid) throw new Error("initiative closeout requires current orchestrator parent ownership");
  return parent;
}
function requireFreshCloseout(workflow: Workflow, observedRaw: RepositorySnapshot): InitiativeCloseout {
  requireCloseoutPhase(workflow);
  const closeout = workflow.closeout;
  if (!closeout) throw new Error("initiative closeout checkpoint is missing");
  const observed = normalizeRepositorySnapshot(observedRaw);
  if (!sameRepositorySnapshot(closeout.snapshot, observed)) throw new Error("initiative closeout evidence is stale for the repository source, HEAD, or branch");
  const parent = requireValidParent(workflow);
  if (closeout.checkpoint.ownerId !== parent.ownerId || closeout.checkpoint.sessionId !== parent.sessionId || closeout.checkpoint.runtimeId !== parent.runtimeId) throw new Error("initiative closeout ownership provenance is stale");
  return closeout;
}
function requireCloseoutEvidence(workflow: Workflow, closeout: InitiativeCloseout, evidence: VerificationEvidence): void {
  if (!workflow.initiativeVerification.some((planned) => commandKey(planned) === commandKey(evidence))) throw new Error("initiative evidence is not an exact planned integration check");
  if (evidence.contractHash !== workflow.contract.hash || evidence.snapshotHash !== closeout.snapshot.hash || evidence.beforeSnapshotHash !== closeout.snapshot.hash || evidence.afterSnapshotHash !== closeout.snapshot.hash || evidence.head !== closeout.snapshot.head || evidence.branch !== closeout.snapshot.branch) throw new Error("initiative evidence contract or repository snapshot provenance is stale");
  const source = evidence.source;
  if (!source || source.kind !== "bash-tool-result" || source.toolName !== "bash" || source.workflowRevision < closeout.checkpoint.revision || source.ownerId !== closeout.checkpoint.ownerId || source.sessionId !== closeout.checkpoint.sessionId || source.runtimeId !== closeout.checkpoint.runtimeId || source.branchLength === undefined || source.branchLength < closeout.checkpoint.branchLength || Date.parse(evidence.at) <= Date.parse(closeout.checkpoint.at)) throw new Error("initiative evidence is not a fresh protected-bash result from the closeout parent checkpoint");
}
function requireCompleteCloseoutVerification(workflow: Workflow): InitiativeCloseout {
  requireCloseoutPhase(workflow);
  const closeout = workflow.closeout;
  if (!closeout) throw new Error("initiative closeout checkpoint is missing");
  for (const planned of workflow.initiativeVerification) {
    const latest = closeout.evidence.filter((item) => commandKey(item) === commandKey(planned)).at(-1);
    if (!latest || latest.exitCode !== 0) throw new Error(`missing current passing final integration check: ${commandDisplay(planned)}`);
    requireCloseoutEvidence(workflow, closeout, latest);
  }
  return closeout;
}
function addCloseoutFollowUp(workflow: Workflow, revision: WorkflowTaskRevision, now: string): WorkflowDecision {
  requireCloseoutPhase(workflow);
  const report = workflow.initiativeAcceptance;
  if (!report || !["changes-requested", "failed", "needs-input"].includes(report.outcome) || report.outcome === "needs-input" && workflow.closeout?.manualValidation?.status !== "rejected") throw new Error("scoped follow-up work requires a final acceptance changes request or rejected manual validation");
  if (workflow.tasks.some((task) => task.id === revision.id)) throw new Error(`duplicate task id ${revision.id}`);
  const dependencies = new Set(revision.dependsOn ?? []);
  for (const completed of workflow.tasks) dependencies.add(completed.id);
  if (!revision.acceptance?.length || !revision.nonGoals?.length || revision.approaches === undefined) throw new Error("closeout follow-up requires explicit acceptance, non-goals, and approach assessment");
  const task = normalizeTask({ ...revision, dependsOn: [...dependencies], kind: "implementation", status: "pending", phase: "pending" }, { contract: workflow.contract, compatibility: false });
  if (!task.writeScope.length || !task.verification.length && !task.verificationDecision) throw new Error("closeout follow-up requires scoped implementation and objective verification or an explicit manual decision");
  const tasks = [...workflow.tasks, task];
  validateTaskGraph(tasks);
  const history = appendHistory(workflow.orchestration.history, { id: `closeout-follow-up-${task.id}-${workflow.revision + 1}`, type: "closeout-follow-up", at: now, taskId: task.id, summary: `scoped follow-up created from ${report.outcome} final acceptance`, auditCritical: true });
  return update(workflow, { tasks, closeout: undefined, initiativeAcceptance: undefined, status: "draft", orchestration: { ...workflow.orchestration, phase: "task-execution", activeRun: undefined, history } }, now, `created scoped closeout follow-up ${task.id}; implementation, independent review, integration, and verification are required`);
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
  const parent = value.orchestration.parent === undefined ? undefined : normalizeParentAuthority(value.orchestration.parent);
  const runtimeHandoff = value.orchestration.runtimeHandoff === undefined ? undefined : normalizeRuntimeHandoff(value.orchestration.runtimeHandoff);
  const retainedHandoffHistory = history.some((entry) => entry.type === "runtime-handoff-reclaimed" || entry.type === "runtime-parent-rotated");
  if (retainedHandoffHistory && !runtimeHandoff) throw new Error("runtime handoff history requires a retained runtime handoff authority receipt");
  const nextFence = value.orchestration.nextFence;
  if (!Number.isSafeInteger(nextFence) || (nextFence as number) < 1) throw new Error("invalid orchestration fence");
  const tasks = (value.tasks as unknown[]).map((task) => normalizeTask(task as Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">, { contract, compatibility: true }));
  validateTaskGraph(tasks);
  const active = tasks.filter((task) => task.status === "active");
  if (active.length > 1 || (value.activeTask !== undefined && active[0]?.id !== value.activeTask) || (active.length && value.activeTask !== active[0]!.id)) throw new Error("activeTask does not match task state");
  if (value.status === "active" && !active.length) throw new Error("active workflow requires an active task");
  if (active.length && value.status !== "active" && value.status !== "paused") throw new Error("active task requires active or paused workflow status");
  const allDone = tasks.every((task) => ["complete", "deferred"].includes(task.status));
  const planReview = value.planReview ? normalizeReport(value.planReview) : undefined;
  const initiativeAcceptance = value.initiativeAcceptance ? normalizeReport(value.initiativeAcceptance) : undefined;
  const closeout = value.closeout ? normalizeCloseout(value.closeout) : undefined;
  const historicalMultiAgentCompletion = mode === "multi-agent" && value.status === "complete" && (!initiativeAcceptance || !closeout);
  const parsedStatus = historicalMultiAgentCompletion ? "paused" as const : value.status as WorkflowStatus;
  const parsedPhase = historicalMultiAgentCompletion ? approvedReport(planReview, contract.hash) ? "initiative-acceptance" as const : "plan-review" as const : phase as WorkflowPhase;
  if (value.status === "complete" && (!allDone || phase !== "complete" || mode === "multi-agent" && !historicalMultiAgentCompletion && (!approvedReport(initiativeAcceptance, contract.hash) || !closeout))) throw new Error("complete workflow status does not match task states or orchestration gates");
  const parsed: Workflow = {
    version: WORKFLOW_VERSION, topic: value.topic as string, revision: value.revision as number, status: parsedStatus,
    goal: (value.goal as string).trim(), ...(typeof value.plan === "string" ? { plan: value.plan.trim() } : {}), contract,
    initiativeVerification: value.initiativeVerification === undefined ? deriveInitiativeVerification(tasks) : normalizeCommands(value.initiativeVerification, "initiative"),
    orchestration: { mode: mode as "legacy" | "multi-agent", phase: parsedPhase, nextFence: nextFence as number, ...(activeRun ? { activeRun } : {}), ...(parent ? { parent } : {}), ...(runtimeHandoff ? { runtimeHandoff } : {}), history },
    ...(planReview ? { planReview } : {}),
    ...(closeout ? { closeout } : {}),
    ...(initiativeAcceptance ? { initiativeAcceptance } : {}),
    ...(value.bootstrapAdoption ? { bootstrapAdoption: normalizeBootstrapAdoption(value.bootstrapAdoption) } : {}),
    ...(typeof value.activeTask === "string" ? { activeTask: value.activeTask } : {}), tasks, updatedAt,
    ...(normalizeMigration(value.migration) ? { migration: normalizeMigration(value.migration)! } : {}),
    ...(normalizeWorkflowImport(value.importedFrom) ? { importedFrom: normalizeWorkflowImport(value.importedFrom)! } : {}),
  };
  const handoff = parsed.orchestration.runtimeHandoff;
  if (handoff?.phase === "prepared" && parsed.orchestration.parent?.valid) throw new Error("prepared runtime handoff cannot retain valid parent authority");
  if (handoff?.phase === "reclaimed") {
    const currentParent = parsed.orchestration.parent;
    if (!currentParent || !handoff.reclaimedAt || Date.parse(handoff.reclaimedAt) < Date.parse(handoff.preparedAt)) throw new Error("reclaimed runtime handoff requires retained parent authority");
    const subsequentRecovery = history.some((entry) => entry.type === "parent-recovered" && Date.parse(entry.at) > Date.parse(handoff.reclaimedAt!));
    if (handoff.previousParent && !subsequentRecovery && (currentParent.ownerId !== handoff.previousParent.ownerId || currentParent.sessionId !== handoff.previousParent.sessionId || currentParent.cwd !== handoff.previousParent.cwd || currentParent.runtimeId === handoff.previousParent.runtimeId)) throw new Error("reclaimed runtime handoff changed ownership or reused the prior runtime without an audited recovery");
  }
  if (parsed.status === "complete" && parsed.orchestration.mode === "multi-agent") {
    const completedCloseout = requireCompleteCloseoutVerification(parsed);
    const report = parsed.initiativeAcceptance!;
    requireReport(report, "final-acceptance", "final-reviewer", parsed.contract.hash);
    if (report.provenance.snapshotHash !== completedCloseout.snapshot.hash || Date.parse(report.provenance.startedAt) <= Date.parse(completedCloseout.checkpoint.at) || report.findings.some((finding) => finding.status === "accepted-risk")) throw new Error("complete workflow has stale or invalid final acceptance");
    const prior = [parsed.planReview, ...parsed.tasks.flatMap((task) => task.reports)].filter((item): item is StageReport => !!item);
    if (prior.some((item) => item.provenance.runId === report.provenance.runId || item.provenance.actorId === report.provenance.actorId)) throw new Error("complete workflow reused a prior reviewer identity");
    const auditMatches = parsed.orchestration.history.filter((entry) => entry.type === "final-acceptance" && entry.provenance && (entry.provenance.runId === report.provenance.runId || entry.provenance.actorId === report.provenance.actorId));
    if (auditMatches.length !== 1 || completedCloseout.blockingRisks.length) throw new Error("complete workflow lacks unique audited acceptance or has unresolved closeout risks");
  }
  return parsed;
}

function upgradeV1View(value: Record<string, unknown>, readAt: string): Workflow {
  if (!isValidTopic(value.topic as string) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !isStatus(value.status) || typeof value.goal !== "string" || !value.goal.trim() || !Array.isArray(value.tasks)) throw new Error("invalid v1 workflow state");
  const updatedAt = validTimestamp(value.updatedAt, "workflow updatedAt");
  const initiativeVerification = deriveInitiativeVerification(value.tasks as Array<Partial<WorkflowTask>>);
  const contract = planIdentity(value.goal.trim(), typeof value.plan === "string" ? value.plan.trim() : undefined, undefined, 1, initiativeVerification);
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
    status: "paused", goal: value.goal.trim(), ...(typeof value.plan === "string" && value.plan.trim() ? { plan: value.plan.trim() } : {}),
    contract, initiativeVerification, orchestration: { mode: "multi-agent", phase: "plan-review", nextFence: 1, history: [] },
    tasks, updatedAt, migration: { sourceVersion: 1, readAt: validTimestamp(readAt, "migration readAt"), historicalTaskIds },
    ...(normalizeWorkflowImport(value.importedFrom) ? { importedFrom: normalizeWorkflowImport(value.importedFrom)! } : {}),
  };
}

function normalizeRepositorySnapshot(value: unknown): RepositorySnapshot {
  if (!record(value)) throw new Error("invalid repository snapshot");
  const hash = boundedText(value.hash, "repository snapshot hash", 128);
  const head = boundedText(value.head, "repository snapshot HEAD", 128);
  const branch = value.branch === null ? null : boundedText(value.branch, "repository snapshot branch", 512);
  const changedPaths = boundedStrings(value.changedPaths, "repository snapshot changed paths", 256, 512);
  if (changedPaths.some((path) => !SAFE_SCOPE.test(path) || path.includes("*"))) throw new Error("repository snapshot contains an unsafe or non-exact path");
  return { hash, head, branch, changedPaths, capturedAt: validTimestamp(value.capturedAt, "repository snapshot timestamp") };
}
function normalizeManualValidation(value: unknown): ManualValidationOutcome & { status: "approved" | "rejected"; decidedBy: string } {
  if (!record(value) || !["approved", "rejected"].includes(value.status as string)) throw new Error("invalid manual validation outcome");
  return { status: value.status as "approved" | "rejected", rationale: boundedText(value.rationale, "manual validation rationale"), decidedBy: boundedText(value.decidedBy, "manual validation decision owner", 128), at: validTimestamp(value.at, "manual validation timestamp") };
}
function normalizeCloseout(value: unknown): InitiativeCloseout {
  if (!record(value) || !record(value.checkpoint)) throw new Error("invalid initiative closeout state");
  const checkpoint = value.checkpoint;
  if (!Number.isSafeInteger(checkpoint.revision) || (checkpoint.revision as number) < 1) throw new Error("invalid initiative closeout checkpoint");
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(normalizeEvidence) : (() => { throw new Error("initiative closeout evidence must be an array"); })();
  if (evidence.length > 32) throw new Error("initiative closeout has too much evidence");
  const manual = value.manualValidation === undefined ? undefined : value.manualValidation;
  let manualValidation: ManualValidationOutcome | undefined;
  if (record(manual) && manual.status === "required") manualValidation = { status: "required", rationale: boundedText(manual.rationale, "manual validation rationale"), at: validTimestamp(manual.at, "manual validation timestamp") };
  else if (manual !== undefined) manualValidation = normalizeManualValidation(manual);
  return {
    snapshot: normalizeRepositorySnapshot(value.snapshot), cumulativeDeltaHash: requireDigest(value.cumulativeDeltaHash, "cumulative delta hash"),
    checkpoint: { revision: checkpoint.revision as number, at: validTimestamp(checkpoint.at, "closeout checkpoint timestamp"), ownerId: boundedText(checkpoint.ownerId, "closeout owner", 128), sessionId: boundedText(checkpoint.sessionId, "closeout session", 128), runtimeId: boundedText(checkpoint.runtimeId, "closeout runtime", 128), branchLength: validBranchLength(checkpoint.branchLength) },
    evidence, unresolvedRisks: boundedStrings(value.unresolvedRisks, "unresolved initiative risks", 64, 1024), blockingRisks: boundedStrings(value.blockingRisks ?? value.unresolvedRisks, "blocking initiative risks", 64, 1024), followUpTaskIds: boundedStrings(value.followUpTaskIds, "closeout follow-up task ids", MAX_TASKS, 64), ...(manualValidation ? { manualValidation } : {}),
  };
}
function sameRepositorySnapshot(left: RepositorySnapshot, right: RepositorySnapshot): boolean { return left.hash === right.hash && left.head === right.head && left.branch === right.branch && sameStringSet(left.changedPaths, right.changedPaths); }
function normalizeCommit(value: unknown, label: string): string { if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`invalid ${label}`); return value; }
function normalizeBootstrapDecision(value: unknown): BootstrapFindingDecision { if (!record(value)) throw new Error("invalid bootstrap finding decision"); return { findingId: boundedText(value.findingId, "bootstrap finding id", 128), disposition: boundedText(value.disposition, "bootstrap finding disposition"), decidedBy: boundedText(value.decidedBy, "bootstrap decision owner", 128), at: validTimestamp(value.at, "bootstrap finding decision timestamp") }; }
function normalizeBootstrapAuthorization(value: unknown, capturedAt: string, now: string): BootstrapAdoption["authorization"] { if (!record(value)) throw new Error("invalid bootstrap authorization"); const authorization = { id: boundedText(value.id, "bootstrap authorization id", 128), authorizedBy: boundedText(value.authorizedBy, "bootstrap authorization actor", 128), ownerId: boundedText(value.ownerId, "bootstrap owner", 128), sessionId: boundedText(value.sessionId, "bootstrap session", 128), runtimeId: boundedText(value.runtimeId, "bootstrap runtime", 128), authorizedAt: validTimestamp(value.authorizedAt, "bootstrap authorization timestamp") }; if (Date.parse(authorization.authorizedAt) <= Date.parse(capturedAt) || Date.parse(authorization.authorizedAt) > Date.parse(now)) throw new Error("bootstrap authorization is stale or future-dated"); return authorization; }
function normalizeBootstrapAdoption(value: unknown): BootstrapAdoption { if (!record(value) || !Array.isArray(value.taskIds) || !Array.isArray(value.checks) || !Array.isArray(value.decisions)) throw new Error("invalid bootstrap adoption provenance"); const snapshot = normalizeRepositorySnapshot(value.snapshot); const adoptedAt = validTimestamp(value.adoptedAt, "bootstrap adoption timestamp"); const concernRaw = value.concernReview; const concernReview = concernRaw === undefined ? undefined : record(concernRaw) && Array.isArray(concernRaw.concerns) ? { concerns: boundedStrings(concernRaw.concerns, "bootstrap concerns", WORKFLOW_APPROACHES.length, 64) as WorkflowApproach[], report: normalizeReport(concernRaw.report) } : (() => { throw new Error("invalid bootstrap concern review"); })(); return { anchorCommit: normalizeCommit(value.anchorCommit, "bootstrap anchor commit"), descendantHead: normalizeCommit(value.descendantHead, "bootstrap descendant HEAD"), snapshot, taskIds: boundedStrings(value.taskIds, "bootstrap task ids", MAX_TASKS, 64), planReview: normalizeReport(value.planReview), generalReview: normalizeReport(value.generalReview), ...(concernReview ? { concernReview } : {}), checks: value.checks.map((item) => { if (!record(item)) throw new Error("invalid bootstrap check"); return { taskId: boundedText(item.taskId, "bootstrap check task id", 64), evidence: normalizeEvidence(item.evidence) }; }), decisions: value.decisions.map(normalizeBootstrapDecision), authorization: normalizeBootstrapAuthorization(value.authorization, snapshot.capturedAt, adoptedAt), adoptedAt }; }
function requireDigest(value: unknown, label: string): string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`invalid ${label}`); return value; }
function validBranchLength(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid closeout branch length"); return value as number; }
function deriveInitiativeVerification(tasks: Array<Partial<WorkflowTask>>): VerificationCommand[] {
  const commands = tasks.flatMap((task) => Array.isArray(task.verification) ? task.verification : []).map(normalizeCommand);
  return [...new Map(commands.map((command) => [commandKey(command), command])).values()];
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
    verificationDriftPaths: boundedStrings(task.verificationDriftPaths, `task ${task.id} verification drift paths`, 128, 512),
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
function planIdentity(goal: string, plan: string | undefined, linked: string | undefined, revision: number, initiativeVerification: VerificationCommand[]): ContractIdentity {
  const linkedPlanHash = linked ? (linked.startsWith("sha256:") && !linked.includes("\n") ? linked : hashContract(linked)) : undefined;
  return { revision, hash: hashContract({ goal, plan: plan ?? null, linkedPlanHash: linkedPlanHash ?? null, initiativeVerification }), ...(linkedPlanHash ? { linkedPlanHash } : {}) };
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
function decideFinding(workflow: Workflow, event: Extract<WorkflowEvent, { type: "decide-finding" }>, now: string): WorkflowDecision {
  const task = workflow.tasks.find((candidate) => candidate.id === event.taskId);
  if (!task || task.status === "complete") throw new Error(`finding task ${event.taskId} is not mutable`);
  const finding = task.findings.find((candidate) => candidate.id === event.findingId);
  if (!finding || finding.status !== "open") throw new Error(`open finding ${event.findingId} was not found`);
  const decidedBy = boundedText(event.decidedBy, "finding decision owner", 128);
  if (workflowRunnerIdentities(workflow).has(decidedBy)) throw new Error("a workflow child cannot decide its own finding disposition");
  const disposition = boundedText(event.disposition, "finding disposition");
  const findings = task.findings.map((candidate) => candidate.id === finding.id ? { ...candidate, status: "accepted-risk" as const, disposition: `${disposition} (decided by ${decidedBy})` } : candidate);
  const history = appendHistory(workflow.orchestration.history, { id: `finding-${finding.id}-${workflow.revision + 1}`, type: "finding-decision", at: now, taskId: task.id, summary: `${decidedBy}: ${disposition}`, auditCritical: true });
  return replaceTask(workflow, task.id, { findings }, { orchestration: { ...workflow.orchestration, history } }, now, `recorded explicit decision for ${finding.id}`);
}

function resetRemediation(workflow: Workflow, event: Extract<WorkflowEvent, { type: "reset-remediation" }>, now: string): WorkflowDecision {
  const task = workflow.tasks.find((candidate) => candidate.id === event.taskId);
  if (!task || task.status === "complete") throw new Error(`remediation task ${event.taskId} is not mutable`);
  if (!Number.isSafeInteger(event.max) || event.max < task.remediation.used || event.max > 8) throw new Error("remediation reset max must preserve used attempts and be at most 8");
  const decidedBy = boundedText(event.decidedBy, "remediation reset owner", 128);
  if (workflowRunnerIdentities(workflow).has(decidedBy)) throw new Error("a workflow child cannot reset its own remediation budget");
  const reason = boundedText(event.reason, "remediation reset reason");
  const history = appendHistory(workflow.orchestration.history, { id: `remediation-reset-${task.id}-${workflow.revision + 1}`, type: "remediation-reset", at: now, taskId: task.id, summary: `${decidedBy}: ${reason}; max ${event.max}`, auditCritical: true });
  return replaceTask(workflow, task.id, { remediation: { used: task.remediation.used, max: event.max } }, { orchestration: { ...workflow.orchestration, history } }, now, `reset remediation budget for ${task.id}`);
}

function workflowRunnerIdentities(workflow: Workflow): Set<string> {
  const reports = [workflow.planReview, workflow.initiativeAcceptance, ...workflow.tasks.flatMap((task) => task.reports), ...workflow.orchestration.history.map((entry) => entry.provenance)].filter((report): report is StageReport | RunnerProvenance => !!report);
  return new Set(reports.flatMap((report) => "provenance" in report ? [report.provenance.runId, report.provenance.actorId] : [report.runId, report.actorId]));
}

function appendTaskReport(task: WorkflowTask, report: StageReport): Partial<WorkflowTask> {
  const reports = boundedAppend(task.reports, report, MAX_REPORTS, "task reports");
  const findings = boundedMergeFindings(task.findings, report.findings, MAX_FINDINGS);
  const clarifications = boundedMergeById(task.clarifications, report.questions ?? [], 32, "task clarifications");
  return { reports, findings, clarifications };
}
function verificationSatisfied(task: WorkflowTask, evidence: VerificationEvidence[]): boolean {
  if (!task.verification.length) return !!task.verificationDecision;
  const snapshot = taskVerificationSnapshot(task);
  return task.verification.every((planned) => {
    const latest = evidence.filter((item) => commandKey(item) === commandKey(planned)).at(-1);
    return latest?.exitCode === 0 && latest.contractHash === task.contract.hash && latest.snapshotHash === snapshot;
  });
}
function taskVerificationSnapshot(task: WorkflowTask): string | undefined { return task.integrationReceipt?.postSnapshotHash ?? task.workspaceReceipt?.snapshotHash; }
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
function respondClarification(workflow: Workflow, event: Extract<WorkflowEvent, { type: "respond-clarification" }>, now: string): WorkflowDecision {
  if (workflow.status === "complete") throw new Error("completed workflow clarifications are immutable");
  if (!TASK_ID.test(event.questionId)) throw new Error("invalid clarification id");
  const answer = boundedText(event.answer, "clarification answer");
  const answeredBy = boundedText(event.answeredBy, "clarification answerer", 128);
  const apply = (question: Clarification): Clarification => {
    if (question.id !== event.questionId) return question;
    if (question.answer !== undefined) throw new Error(`clarification ${event.questionId} is already answered`);
    return { ...question, answer, answeredBy, answeredAt: now };
  };
  const updateReport = (report: StageReport): StageReport => report.questions?.some((question) => question.id === event.questionId)
    ? { ...report, questions: report.questions.map(apply) }
    : report;
  if (event.taskId) {
    const task = workflow.tasks.find((candidate) => candidate.id === event.taskId);
    if (!task) throw new Error(`task ${event.taskId} was not found`);
    if (task.status === "complete") throw new Error(`completed task ${event.taskId} clarifications are immutable`);
    if (!task.clarifications.some((question) => question.id === event.questionId)) throw new Error(`clarification ${event.questionId} was not found on ${event.taskId}`);
    return replaceTask(workflow, task.id, {
      clarifications: task.clarifications.map(apply),
      reports: task.reports.map(updateReport),
    }, {}, now, `answered clarification ${event.questionId}`);
  }
  const reportKey = workflow.planReview?.questions?.some((question) => question.id === event.questionId)
    ? "planReview"
    : workflow.initiativeAcceptance?.questions?.some((question) => question.id === event.questionId)
      ? "initiativeAcceptance"
      : undefined;
  if (!reportKey) throw new Error(`clarification ${event.questionId} was not found`);
  const report = updateReport(workflow[reportKey]!);
  return update(workflow, { [reportKey]: report }, now, `answered clarification ${event.questionId}`);
}
function scopeAllows(scopes: string[], path: string): boolean { return scopes.some((scope) => scopeAllowsPath(scope, path)); }
function replaceTask(workflow: Workflow, id: string, taskPatch: Partial<WorkflowTask>, workflowPatch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return changed(workflow, { ...workflowPatch, tasks: workflow.tasks.map((task) => task.id === id ? { ...task, ...taskPatch } : task) }, now, message); }
function update(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return changed(workflow, patch, now, message); }
function changed(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return { workflow: { ...workflow, ...patch, revision: workflow.revision + 1, updatedAt: validTimestamp(now, "workflow timestamp") }, changed: true, message }; }
function unchanged(workflow: Workflow, message: string): WorkflowDecision { return { workflow, changed: false, message }; }
function conciseAssessment(task: WorkflowTask): string { const text = task.approaches.map((approach) => `${approach} (${task.approachReasons[approach]})`).join(", "); return text.length <= 300 ? text : `${text.slice(0, 297)}...`; }
function commandKey(command: VerificationCommand): string { return JSON.stringify([command.command, command.args]); }
function legacyCommandKey(command: VerificationCommand): string { return [command.command, ...command.args].join(" ").trim(); }
function commandDisplay(command: VerificationCommand): string { return [command.command, ...command.args].join(" "); }
function evidenceMatchesCheckpoint(evidence: VerificationEvidence, checkpoint: VerificationCheckpoint): boolean { return Date.parse(evidence.at) > Date.parse(checkpoint.at) && evidence.source?.kind === "bash-tool-result" && evidence.source.workflowRevision >= checkpoint.revision && (checkpoint.sessionId === undefined || evidence.source.sessionId === checkpoint.sessionId); }
function normalizeCommands(value: unknown, taskId: string): VerificationCommand[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 16) throw new Error(`task ${taskId} verification must be an array of at most 16 commands`); const commands = value.map(normalizeCommand); if (new Set(commands.map(commandKey)).size !== commands.length) throw new Error(`task ${taskId} has duplicate verification commands`); return commands; }
function normalizeCommand(value: unknown): VerificationCommand {
  if (!record(value) || typeof value.command !== "string" || !value.command.trim() || value.command.trim().length > 256 || (value.args !== undefined && !Array.isArray(value.args))) throw new Error("invalid verification command");
  const command = value.command.trim();
  const args = Array.isArray(value.args) ? value.args.map((arg) => { if (typeof arg !== "string" || arg.length > 512) throw new Error("invalid verification argument"); return arg; }) : [];
  if (args.length > 64) throw new Error("too many verification arguments");
  const executable = command.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
  if (["echo", "printf", "true", ":"].includes(executable) || (["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"].includes(executable) && /^(?:-[a-z]*c\s+)?(?:echo|printf|true|:)\b/i.test(args.join(" ").trim()))) throw new Error("verification command must be an objective check, not an echo-style fabricated pass");
  return { command, args };
}
function normalizeEvidence(value: unknown): VerificationEvidence {
  const command = normalizeCommand(value);
  if (!record(value) || !Number.isInteger(value.exitCode)) throw new Error("invalid verification evidence");
  const at = validTimestamp(value.at, "verification evidence timestamp");
  if (value.contractHash !== undefined && (typeof value.contractHash !== "string" || value.contractHash.length > 80)) throw new Error("invalid verification contract hash");
  for (const field of ["snapshotHash", "beforeSnapshotHash", "afterSnapshotHash", "head"] as const) if (value[field] !== undefined && (typeof value[field] !== "string" || !(value[field] as string).length || (value[field] as string).length > 128)) throw new Error(`invalid verification ${field}`);
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd || value.cwd.length > 2_048)) throw new Error("invalid verification cwd");
  if (value.branch !== undefined && value.branch !== null && (typeof value.branch !== "string" || !value.branch || value.branch.length > 512)) throw new Error("invalid verification branch");
  if (value.source !== undefined && (!record(value.source) || value.source.kind !== "bash-tool-result" || typeof value.source.toolCallId !== "string" || !value.source.toolCallId || !Number.isSafeInteger(value.source.workflowRevision) || (value.source.workflowRevision as number) < 1)) throw new Error("invalid verification evidence source");
  const sourceValue = record(value.source) ? value.source : undefined;
  if (sourceValue?.toolName !== undefined && sourceValue.toolName !== "bash") throw new Error("invalid verification source tool");
  const source = sourceValue ? {
    kind: "bash-tool-result" as const, toolCallId: sourceValue.toolCallId as string, workflowRevision: sourceValue.workflowRevision as number,
    ...(sourceValue.toolName === "bash" ? { toolName: "bash" as const } : {}),
    ...stringField(sourceValue, "sessionId"), ...stringField(sourceValue, "ownerId"), ...stringField(sourceValue, "runtimeId"),
    ...stringField(sourceValue, "sessionFile"), ...stringField(sourceValue, "sessionBranchId"),
    ...(Number.isSafeInteger(sourceValue.branchLength) && (sourceValue.branchLength as number) >= 0 ? { branchLength: sourceValue.branchLength as number } : {}),
  } : undefined;
  return {
    ...command, exitCode: value.exitCode as number, at,
    ...stringField(value, "contractHash"), ...stringField(value, "snapshotHash"), ...stringField(value, "cwd"),
    ...(value.branch === null || typeof value.branch === "string" ? { branch: value.branch as string | null } : {}),
    ...stringField(value, "head"), ...stringField(value, "beforeSnapshotHash"), ...stringField(value, "afterSnapshotHash"),
    ...(source ? { source } : {}),
  };
}
function normalizeReport(value: unknown): StageReport { if (!record(value) || !['plan-review','implementation','general-review','concern-review','final-acceptance'].includes(value.kind as string) || !['approved','changes-requested','needs-input','completed','no-change','failed'].includes(value.outcome as string) || !Array.isArray(value.findings)) throw new Error("invalid stage report"); const summary = boundedText(value.summary, "stage report summary"); const findings = value.findings.map(normalizeFinding); if (findings.length > MAX_FINDINGS) throw new Error("stage report has too many findings"); const changedPaths = value.changedPaths === undefined ? undefined : boundedStrings(value.changedPaths, "changed paths", 128, 512); const questions = value.questions === undefined ? undefined : (Array.isArray(value.questions) ? value.questions.map(normalizeClarification) : (() => { throw new Error("stage report questions must be an array"); })()); if (questions && questions.length > 32) throw new Error("stage report has too many questions"); return { kind: value.kind as StageReport["kind"], outcome: value.outcome as StageReport["outcome"], summary, ...(typeof value.rationale === "string" && value.rationale.trim() ? { rationale: boundedText(value.rationale, "stage report rationale") } : {}), ...(changedPaths ? { changedPaths } : {}), findings, ...(questions ? { questions } : {}), provenance: normalizeProvenance(value.provenance) }; }
function normalizeProvenance(value: unknown): RunnerProvenance { if (!record(value) || typeof value.runId !== "string" || !value.runId || value.runId.length > 128 || !['plan-reviewer','implementer','general-reviewer','concern-reviewer','final-reviewer'].includes(value.role as string) || typeof value.actorId !== "string" || !value.actorId || value.actorId.length > 128 || typeof value.leaseId !== "string" || !value.leaseId || value.leaseId.length > 128 || !Number.isSafeInteger(value.leaseFence) || (value.leaseFence as number) < 1 || typeof value.contractHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contractHash) || (value.snapshotHash !== undefined && (typeof value.snapshotHash !== "string" || !value.snapshotHash || value.snapshotHash.length > 128))) throw new Error("invalid runner provenance"); for (const field of ["provider", "model"] as const) if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field] || value[field].length > 256)) throw new Error(`invalid runner ${field}`); return { runId: value.runId, role: value.role as RunnerRole, actorId: value.actorId, ...(typeof value.provider === "string" ? { provider: value.provider } : {}), ...(typeof value.model === "string" ? { model: value.model } : {}), leaseId: value.leaseId, leaseFence: value.leaseFence as number, contractHash: value.contractHash, ...(typeof value.snapshotHash === "string" ? { snapshotHash: value.snapshotHash } : {}), startedAt: validTimestamp(value.startedAt, "runner start"), completedAt: validTimestamp(value.completedAt, "runner completion") }; }
function normalizeFinding(value: unknown): Finding { if (!record(value) || typeof value.id !== "string" || !TASK_ID.test(value.id) || !['blocking','warning'].includes(value.severity as string) || !['open','resolved','accepted-risk'].includes(value.status as string)) throw new Error("invalid finding"); return { id: value.id, severity: value.severity as Finding["severity"], status: value.status as Finding["status"], summary: boundedText(value.summary, "finding summary", 1024), evidence: boundedText(value.evidence, "finding evidence"), ...(typeof value.disposition === "string" && value.disposition.trim() ? { disposition: boundedText(value.disposition, "finding disposition") } : {}) }; }
function normalizeClarification(value: unknown): Clarification { if (!record(value) || typeof value.id !== "string" || !TASK_ID.test(value.id) || typeof value.askedByRunId !== "string" || !value.askedByRunId) throw new Error("invalid clarification"); return { id: value.id, question: boundedText(value.question, "clarification question"), askedByRunId: value.askedByRunId, askedAt: validTimestamp(value.askedAt, "clarification timestamp"), ...(typeof value.answer === "string" ? { answer: boundedText(value.answer, "clarification answer") } : {}), ...(typeof value.answeredBy === "string" ? { answeredBy: boundedText(value.answeredBy, "clarification answerer", 128) } : {}), ...(typeof value.answeredAt === "string" ? { answeredAt: validTimestamp(value.answeredAt, "clarification answer timestamp") } : {}) }; }
function normalizeWorkspaceReceipt(value: unknown): WorkspaceReceipt {
  if (!record(value) || typeof value.workspaceId !== "string" || !value.workspaceId || typeof value.baselineHash !== "string" || typeof value.snapshotHash !== "string") throw new Error("invalid workspace receipt");
  const receipt: WorkspaceReceipt = {
    workspaceId: boundedText(value.workspaceId, "workspace id", 128), baselineHash: boundedText(value.baselineHash, "baseline hash", 128),
    snapshotHash: boundedText(value.snapshotHash, "snapshot hash", 128), changedPaths: boundedStrings(value.changedPaths, "workspace changed paths", 128, 512),
    createdAt: validTimestamp(value.createdAt, "workspace receipt timestamp"),
  };
  if (value.version !== undefined) {
    if (value.version !== 1) throw new Error("unsupported workspace receipt version");
    const required = ["root", "path", "taskId", "topic", "baselineCommit", "baselineRef", "worktreeGitDir", "ownershipToken", "intentPath", "workspaceHeadCommit", "realHead", "realIndexHash", "realIndexTree", "stagedPatchHash", "unstagedPatchHash", "realSourceSnapshotHash"] as const;
    for (const field of required) if (typeof value[field] !== "string" || !value[field]) throw new Error(`invalid workspace receipt ${field}`);
    Object.assign(receipt, {
      version: 1, root: boundedText(value.root, "workspace root"), path: boundedText(value.path, "workspace path"),
      taskId: boundedText(value.taskId, "workspace task id", 128), topic: boundedText(value.topic, "workspace topic", 256),
      baselineCommit: boundedText(value.baselineCommit, "baseline commit", 128), baselineRef: boundedText(value.baselineRef, "baseline ref", 256),
      worktreeGitDir: boundedText(value.worktreeGitDir, "worktree git directory"), ownershipToken: boundedText(value.ownershipToken, "workspace ownership token", 128),
      intentPath: boundedText(value.intentPath, "workspace recovery intent path"), workspaceHeadCommit: boundedText(value.workspaceHeadCommit, "workspace HEAD commit", 128),
      realHead: boundedText(value.realHead, "workspace real HEAD", 128), ...(value.realBranch === null || typeof value.realBranch === "string" ? { realBranch: value.realBranch as string | null } : {}), realIndexHash: boundedText(value.realIndexHash, "workspace index hash", 128),
      realIndexTree: boundedText(value.realIndexTree, "workspace index tree", 128), stagedPatchHash: boundedText(value.stagedPatchHash, "workspace staged patch hash", 128),
      unstagedPatchHash: boundedText(value.unstagedPatchHash, "workspace unstaged patch hash", 128), realSourceSnapshotHash: boundedText(value.realSourceSnapshotHash, "workspace source snapshot hash", 128),
      includedUntracked: boundedStrings(value.includedUntracked, "workspace included untracked", 128, 512),
      ...(value.baselineUntrackedPathHashes !== undefined ? { baselineUntrackedPathHashes: boundedStrings(value.baselineUntrackedPathHashes, "workspace baseline untracked path hashes", 512, 80) } : {}),
      managedPaths: boundedStrings(value.managedPaths, "workspace managed paths", 128, 512),
      writeScope: boundedStrings(value.writeScope, "workspace write scope", 64, 512),
      ...(typeof value.integrationBaseCommit === "string" ? { integrationBaseCommit: boundedText(value.integrationBaseCommit, "integration base commit", 128) } : {}),
    });
    const prepared = [value.preparedResultCommit, value.preparedResultRef, value.preparedPatchHash];
    if (prepared.some((item) => item !== undefined)) {
      if (prepared.some((item) => typeof item !== "string" || !item)) throw new Error("incomplete prepared workspace receipt");
      Object.assign(receipt, {
        preparedResultCommit: boundedText(value.preparedResultCommit, "prepared result commit", 128),
        preparedResultRef: boundedText(value.preparedResultRef, "prepared result ref", 256),
        preparedPatchHash: boundedText(value.preparedPatchHash, "prepared patch hash", 128),
      });
    }
  }
  return receipt;
}
function normalizeIntegrationReceipt(value: unknown): IntegrationReceipt {
  if (!record(value) || typeof value.integrationId !== "string" || !value.integrationId || typeof value.preSnapshotHash !== "string" || typeof value.postSnapshotHash !== "string" || typeof value.patchHash !== "string") throw new Error("invalid integration receipt");
  const receipt: IntegrationReceipt = {
    integrationId: boundedText(value.integrationId, "integration id", 128), preSnapshotHash: boundedText(value.preSnapshotHash, "pre snapshot hash", 128),
    postSnapshotHash: boundedText(value.postSnapshotHash, "post snapshot hash", 128), patchHash: boundedText(value.patchHash, "patch hash", 128),
    integratedAt: validTimestamp(value.integratedAt, "integration timestamp"),
  };
  if (value.version !== undefined) {
    if (value.version !== 1) throw new Error("unsupported integration receipt version");
    const required = ["workspaceId", "resultCommit", "resultRef", "observedHead", "observedIndexHash"] as const;
    for (const field of required) if (typeof value[field] !== "string" || !value[field]) throw new Error(`invalid integration receipt ${field}`);
    Object.assign(receipt, {
      version: 1, workspaceId: boundedText(value.workspaceId, "integration workspace id", 128),
      resultCommit: boundedText(value.resultCommit, "integration result commit", 128), resultRef: boundedText(value.resultRef, "integration result ref", 256),
      observedHead: boundedText(value.observedHead, "integration observed HEAD", 128), ...(value.observedBranch === null || typeof value.observedBranch === "string" ? { observedBranch: value.observedBranch as string | null } : {}), observedIndexHash: boundedText(value.observedIndexHash, "integration observed index hash", 128),
      changedPaths: boundedStrings(value.changedPaths, "integration changed paths", 128, 512),
    });
  }
  return receipt;
}
function normalizeLease(value: unknown): RunLease { if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.runId !== "string" || !value.runId || typeof value.ownerId !== "string" || !value.ownerId || !Number.isSafeInteger(value.fence) || (value.fence as number) < 1 || !['plan-review','task-execution','initiative-acceptance','complete','pending','implementation','general-review','concern-review','remediation','workspace','integration','verification','ready-to-complete','historical'].includes(value.stage as string)) throw new Error("invalid run lease"); const acquiredAt = validTimestamp(value.acquiredAt, "run lease acquiredAt"); const expiresAt = validTimestamp(value.expiresAt, "run lease expiresAt"); if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error("run lease must expire after acquisition"); return { id: boundedText(value.id, "lease id", 128), runId: boundedText(value.runId, "run id", 128), ownerId: boundedText(value.ownerId, "lease owner", 128), stage: value.stage as RunLease["stage"], ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}), fence: value.fence as number, acquiredAt, expiresAt }; }
function normalizeParentAuthority(value: unknown): ParentAuthority { if (!record(value) || typeof value.ownerId !== "string" || !value.ownerId || typeof value.sessionId !== "string" || !value.sessionId || typeof value.runtimeId !== "string" || !value.runtimeId || typeof value.cwd !== "string" || !value.cwd || typeof value.valid !== "boolean") throw new Error("invalid parent authority"); return { ownerId: boundedText(value.ownerId, "parent owner", 128), sessionId: boundedText(value.sessionId, "parent session", 128), runtimeId: boundedText(value.runtimeId, "parent runtime", 128), cwd: boundedText(value.cwd, "parent cwd"), ...(typeof value.sessionFile === "string" && value.sessionFile ? { sessionFile: boundedText(value.sessionFile, "parent session file") } : {}), claimedAt: validTimestamp(value.claimedAt, "parent authority claimedAt"), valid: value.valid, ...(typeof value.invalidatedAt === "string" ? { invalidatedAt: validTimestamp(value.invalidatedAt, "parent authority invalidatedAt") } : {}), ...(typeof value.invalidatedReason === "string" ? { invalidatedReason: boundedText(value.invalidatedReason, "parent authority invalidation reason") } : {}) }; }
function normalizeRuntimeHandoff(value: unknown): RuntimeHandoff {
  if (!record(value) || (value.from !== "compatibility" && value.from !== "v2") || (value.to !== "compatibility" && value.to !== "v2") || (value.phase !== "prepared" && value.phase !== "reclaimed") || !Number.isSafeInteger(value.selectorGeneration) || (value.selectorGeneration as number) < 1) throw new Error("invalid runtime handoff");
  const reclaimedAt = typeof value.reclaimedAt === "string" ? validTimestamp(value.reclaimedAt, "runtime handoff reclaimedAt") : undefined;
  if ((value.phase === "reclaimed") !== !!reclaimedAt) throw new Error("runtime handoff phase does not match reclaim timestamp");
  const decision = value.decision === undefined ? undefined : normalizeGate2DecisionAttestation(value.decision);
  if (value.phase === "prepared" && !decision) throw new Error("prepared runtime handoff lacks durable Gate 2 decision attestation");
  const decisionId = boundedText(value.decisionId, "runtime handoff decision id", 128);
  if (decision && decision.decisionId !== decisionId) throw new Error("runtime handoff decision attestation identity does not match");
  return { id: boundedText(value.id, "runtime handoff id", 128), decisionId, ...(decision ? { decision } : {}), from: value.from, to: value.to, phase: value.phase, selectorGeneration: value.selectorGeneration as number, preparedAt: validTimestamp(value.preparedAt, "runtime handoff preparedAt"), ...(reclaimedAt ? { reclaimedAt } : {}), ...(value.previousParent === undefined ? {} : { previousParent: normalizeParentAuthority(value.previousParent) }) };
}
function normalizeGate2DecisionAttestation(value: unknown): Gate2DecisionAttestation {
  if (!record(value)) throw new Error("runtime handoff Gate 2 decision attestation is missing");
  const expectedKeys = ["authorizedAt", "authorizedBy", "decisionId", "migrationEvidenceHash", "rationale", "readinessEvidenceHash", "rollbackSelector", "rollbackWindowEnd", "targetRuntime"];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("runtime handoff Gate 2 attestation has missing or unknown fields");
  const decision: Gate2DecisionAttestation = {
    decisionId: boundedText(value.decisionId, "Gate 2 decision id", 128), authorizedBy: boundedText(value.authorizedBy, "Gate 2 authorized actor", 128),
    authorizedAt: validTimestamp(value.authorizedAt, "Gate 2 authorization"), readinessEvidenceHash: String(value.readinessEvidenceHash ?? ""), migrationEvidenceHash: String(value.migrationEvidenceHash ?? ""),
    targetRuntime: value.targetRuntime as "v2", rollbackSelector: value.rollbackSelector as "compatibility", rollbackWindowEnd: validTimestamp(value.rollbackWindowEnd, "Gate 2 rollback deadline"), rationale: boundedText(value.rationale, "Gate 2 rationale"),
  };
  if ([decision.decisionId, decision.authorizedBy, decision.rationale].some((text) => /^<.*>$/.test(text)) || decision.readinessEvidenceHash !== "sha256:c20d05e239978d456801410ac986c22ef21c7f78bb6e3cad485a00181fabfadc" || decision.migrationEvidenceHash !== "sha256:0b40a9d1b4352408d0b22ba3814cd0858ebd13e7c04728e563adf294ccd5f157" || decision.targetRuntime !== "v2" || decision.rollbackSelector !== "compatibility" || Date.parse(decision.rollbackWindowEnd) <= Date.parse(decision.authorizedAt)) throw new Error("runtime handoff Gate 2 attestation does not match reviewed evidence");
  return decision;
}
function normalizeContract(value: unknown): ContractIdentity { if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.hash)) throw new Error("invalid contract identity"); return { revision: value.revision as number, hash: value.hash, ...(typeof value.linkedPlanHash === "string" ? { linkedPlanHash: value.linkedPlanHash } : {}) }; }
function normalizeCheckpoint(value: unknown): VerificationCheckpoint | undefined { if (value === undefined) return undefined; if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid verification checkpoint"); return { revision: value.revision as number, at: validTimestamp(value.at, "verification checkpoint"), ...(typeof value.sessionId === "string" && value.sessionId ? { sessionId: value.sessionId } : {}), ...(Number.isSafeInteger(value.branchLength) && (value.branchLength as number) >= 0 ? { branchLength: value.branchLength as number } : {}) }; }
function normalizeVerificationDecision(value: unknown): WorkflowTask["verificationDecision"] { if (value === undefined) return undefined; if (!record(value) || value.kind !== "manual" || typeof value.decidedBy !== "string" || !value.decidedBy) throw new Error("invalid manual verification decision"); return { kind: "manual", rationale: boundedText(value.rationale, "manual verification rationale"), decidedBy: boundedText(value.decidedBy, "manual verification decision owner", 128), at: validTimestamp(value.at, "manual verification decision timestamp") }; }
function normalizeHistory(value: unknown): HistoryEntry[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > MAX_HISTORY) throw new Error(`workflow history exceeds ${MAX_HISTORY} entries`); return value.map((item) => { if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type) throw new Error("invalid workflow history"); return { id: boundedText(item.id, "history id", 128), type: boundedText(item.type, "history type", 128), at: validTimestamp(item.at, "history timestamp"), summary: boundedText(item.summary, "history summary"), ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}), ...(item.provenance ? { provenance: normalizeProvenance(item.provenance) } : {}), ...(item.auditCritical === true ? { auditCritical: true } : {}) }; }); }
function appendHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] { const next = [...history, entry]; if (next.length <= MAX_HISTORY) return next; const removable = next.findIndex((item) => !item.auditCritical); if (removable < 0) throw new Error("workflow history is full of audit-critical provenance; archive before continuing"); return next.filter((_, index) => index !== removable); }
function boundedAppend<T>(items: T[], value: T, max: number, label: string): T[] { if (items.length >= max) throw new Error(`${label} exceeds ${max} entries`); return [...items, value]; }
function sameStringSet(left: string[], right: string[]): boolean { const orderedRight = [...right].sort(); return left.length === right.length && [...left].sort().every((value, index) => value === orderedRight[index]); }
function boundedMergeById<T extends { id: string }>(items: T[], additions: T[], max: number, label: string): T[] { const map = new Map(items.map((item) => [item.id, item])); additions.forEach((item) => map.set(item.id, item)); if (map.size > max) throw new Error(`${label} exceeds ${max} entries`); return [...map.values()]; }
function boundedMergeFindings(items: Finding[], additions: Finding[], max: number): Finding[] {
  const map = new Map(items.map((item) => [item.id, item]));
  for (const addition of additions) {
    const previous = map.get(addition.id);
    if (!previous && addition.status !== "open") throw new Error(`finding ${addition.id} cannot be resolved before it is recorded`);
    if (previous && (previous.severity !== addition.severity || previous.summary !== addition.summary || previous.evidence !== addition.evidence)) throw new Error(`finding ${addition.id} identity was changed`);
    if (previous && previous.status !== "open" && addition.status === "open") throw new Error(`finding ${addition.id} cannot be reopened without an explicit decision`);
    if (addition.status !== "open" && !addition.disposition) throw new Error(`finding ${addition.id} resolution requires a disposition`);
    map.set(addition.id, addition);
  }
  if (map.size > max) throw new Error(`task findings exceeds ${max} entries`);
  return [...map.values()];
}
function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) throw new Error(`${label} contains an invalid value`); const normalized = [...new Set(value.map((item) => (item as string).trim()))]; if (normalized.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`); return normalized; }
function boundedText(value: unknown, label: string, max = MAX_TEXT): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); if (value.trim().length > max) throw new Error(`${label} exceeds ${max} characters`); return value.trim(); }
function validTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`); return value; }
function normalizeApproaches(value: unknown): WorkflowApproach[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error("task approaches must be an array"); const result: WorkflowApproach[] = []; for (const item of value) { if (typeof item !== "string" || !WORKFLOW_APPROACHES.includes(item as WorkflowApproach)) throw new Error(`invalid approach ${String(item)}`); if (!result.includes(item as WorkflowApproach)) result.push(item as WorkflowApproach); } return result; }
function normalizeApproachReasons(value: unknown, approaches: WorkflowApproach[]): ApproachReasons { if (value === undefined) return {}; if (!record(value)) throw new Error("task approachReasons must be an object"); const reasons: ApproachReasons = {}; for (const [key, reason] of Object.entries(value)) { if (!approaches.includes(key as WorkflowApproach) || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1024) throw new Error(`approach ${key} requires a concise applicability reason`); reasons[key as WorkflowApproach] = reason.trim(); } return reasons; }
function validateTaskGraph(tasks: WorkflowTask[]): void { const ids = new Set<string>(); for (const task of tasks) { if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`); ids.add(task.id); } for (const task of tasks) for (const dependency of task.dependsOn) { if (!ids.has(dependency)) throw new Error(`task ${task.id} has missing dependency ${dependency}`); if (dependency === task.id) throw new Error(`task ${task.id} depends on itself`); } const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(tasks.map((task) => [task.id, task])); const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`); if (visited.has(id)) return; visiting.add(id); byId.get(id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); }; tasks.forEach((task) => visit(task.id)); }
function isStatus(value: unknown): value is WorkflowStatus { return ["draft", "active", "paused", "blocked", "complete"].includes(value as string); }
function isTaskStatus(value: unknown): value is TaskStatus { return ["pending", "active", "blocked", "deferred", "complete"].includes(value as string); }
function isTaskPhase(value: unknown): value is TaskPhase { return ["pending","implementation","general-review","concern-review","remediation","workspace","integration","verification","ready-to-complete","historical"].includes(value as string); }
function normalizeMigration(value: unknown): Workflow["migration"] | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.sourceVersion !== 1) throw new Error("invalid workflow migration provenance");
  const disposition = value.disposition;
  if (disposition !== undefined && !["continue", "reopen", "grandfather-read-only"].includes(disposition as string)) throw new Error("invalid workflow migration disposition");
  if (value.preimageHash !== undefined && (typeof value.preimageHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.preimageHash))) throw new Error("invalid workflow migration preimage hash");
  return {
    sourceVersion: 1,
    readAt: validTimestamp(value.readAt, "migration readAt"),
    historicalTaskIds: boundedStrings(value.historicalTaskIds, "historical task ids", MAX_TASKS, 64),
    ...(typeof disposition === "string" ? { disposition: disposition as "continue" | "reopen" | "grandfather-read-only" } : {}),
    ...(typeof value.decidedBy === "string" ? { decidedBy: boundedText(value.decidedBy, "migration decision owner", 128) } : {}),
    ...(typeof value.preimageHash === "string" ? { preimageHash: value.preimageHash } : {}),
  };
}
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
function stringField<T extends string>(value: Record<string, unknown>, field: T): Partial<Record<T, string>> { const item = value[field]; return typeof item === "string" && item ? { [field]: item } as Partial<Record<T, string>> : {}; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
