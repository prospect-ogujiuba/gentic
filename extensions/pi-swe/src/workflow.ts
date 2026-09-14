export const WORKFLOW_VERSION = 1 as const;

export type WorkflowStatus = "draft" | "active" | "paused" | "blocked" | "complete";
export type TaskStatus = "pending" | "active" | "blocked" | "deferred" | "complete";
export const WORKFLOW_APPROACHES = ["tdd", "diagnosis", "dsa", "security", "performance", "migration", "accessibility-ux", "operations"] as const;
export type WorkflowApproach = typeof WORKFLOW_APPROACHES[number];
export type ApproachReasons = Partial<Record<WorkflowApproach, string>>;
export type AssessmentStatus = "assessed" | "unassessed";
export type VerificationCheckpoint = { revision: number; at: string; sessionId?: string; branchLength?: number };

export type VerificationCommand = { command: string; args: string[] };
export type VerificationEvidence = VerificationCommand & {
  exitCode: number;
  at: string;
  source?: { kind: "bash-tool-result"; toolCallId: string; workflowRevision: number; sessionId?: string };
};
export type ImportedTaskProvenance = {
  kind: "pi-swe-v2-contract";
  contractPath: string;
  contentHash?: string;
  completion?: {
    schemaVersion?: number;
    requestId?: string;
    completedAt?: string;
    planRevision?: number;
    contractPath?: string;
    preCompletionContentHash?: string;
    verificationPath?: string;
    verificationContentHash?: string;
    reviewPath?: string;
    reviewContentHash?: string;
    reviewDecision?: string;
    nextInitiativeState?: string;
    nextActiveContractId?: string | null;
    nextReadyContractIds?: string[];
  };
};

export type WorkflowTask = {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptance: string[];
  approaches: WorkflowApproach[];
  approachReasons: ApproachReasons;
  assessmentStatus: AssessmentStatus;
  verification: VerificationCommand[];
  verificationCheckpoint?: VerificationCheckpoint;
  evidence: VerificationEvidence[];
  evidenceLinks: string[];
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
  activeTask?: string;
  tasks: WorkflowTask[];
  updatedAt: string;
  importedFrom?: { kind: "pi-swe-v2"; manifestPath: string; planRevision?: number };
};

export type WorkflowEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "block"; reason: string }
  | { type: "record-verification"; evidence: VerificationEvidence }
  | { type: "complete-task"; allowGap?: boolean };

export type WorkflowDecision = {
  workflow: Workflow;
  changed: boolean;
  message: string;
};

export type WorkflowTaskRevision = Pick<WorkflowTask, "id" | "title"> & Partial<Pick<WorkflowTask, "dependsOn" | "acceptance" | "approaches" | "approachReasons" | "verification">>;

const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TASKS = 100;
const MAX_TEXT = 2048;

export function isValidTopic(value: string): boolean {
  return value.length <= 256 && TOPIC.test(value);
}

export function createWorkflow(input: {
  topic: string;
  goal: string;
  plan?: string;
  tasks: Array<Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">>;
  now?: string;
}): Workflow {
  if (!isValidTopic(input.topic)) throw new Error("topic must be lowercase kebab-case path segments");
  if (!input.goal.trim()) throw new Error("goal is required");
  if (input.goal.trim().length > MAX_TEXT) throw new Error("goal exceeds 2048 characters");
  if (input.plan?.trim() && input.plan.trim().length > MAX_TEXT) throw new Error("plan exceeds 2048 characters");
  if (!input.tasks.length || input.tasks.length > MAX_TASKS) throw new Error("workflow requires 1 to 100 tasks");
  const tasks = input.tasks.map((task) => normalizeTask(task));
  validateTaskGraph(tasks);
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("invalid workflow timestamp");
  return {
    version: WORKFLOW_VERSION,
    topic: input.topic,
    revision: 1,
    status: "draft",
    goal: input.goal.trim(),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}),
    tasks,
    updatedAt: now,
  };
}

export function parseWorkflow(value: unknown): Workflow {
  if (!record(value) || value.version !== WORKFLOW_VERSION) throw new Error(`unsupported workflow version`);
  if (!isValidTopic(value.topic as string)) throw new Error("invalid workflow topic");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid workflow revision");
  if (!isStatus(value.status) || typeof value.goal !== "string" || !(value.goal as string).trim() || (value.goal as string).trim().length > MAX_TEXT) throw new Error("invalid workflow state");
  if (value.plan !== undefined && (typeof value.plan !== "string" || !value.plan.trim() || value.plan.trim().length > MAX_TEXT)) throw new Error("invalid workflow plan");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("invalid workflow updatedAt");
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > MAX_TASKS) throw new Error("workflow requires 1 to 100 tasks");
  const tasks = value.tasks.map((task) => normalizeTask(task as Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">, true));
  validateTaskGraph(tasks);
  const active = tasks.filter((task) => task.status === "active");
  if (active.length > 1) throw new Error("workflow has multiple active tasks");
  for (const task of tasks) {
    if (task.verificationCheckpoint && task.verificationCheckpoint.revision > (value.revision as number)) throw new Error(`task ${task.id} verification checkpoint exceeds workflow revision`);
    if (task.evidence.some((item) => item.source && item.source.workflowRevision > (value.revision as number))) throw new Error(`task ${task.id} evidence exceeds workflow revision`);
  }
  if (value.activeTask !== undefined && (typeof value.activeTask !== "string" || active[0]?.id !== value.activeTask)) throw new Error("activeTask does not match task state");
  if (active.length && value.activeTask !== active[0]!.id) throw new Error("active task pointer is missing");
  if (active.length && value.status !== "active" && value.status !== "paused") throw new Error("active task requires active or paused workflow status");
  if (value.status === "active" && !active.length) throw new Error("active workflow requires an active task");
  const allDone = tasks.every((task) => task.status === "complete" || task.status === "deferred");
  if ((value.status === "complete") !== allDone) throw new Error("complete workflow status does not match task states");
  const effectiveStatus: WorkflowStatus = value.status === "active" && (active[0]?.assessmentStatus === "unassessed" || !active[0]?.verificationCheckpoint) ? "paused" : value.status;
  return {
    version: WORKFLOW_VERSION,
    topic: value.topic as string,
    revision: value.revision as number,
    status: effectiveStatus,
    goal: (value.goal as string).trim(),
    ...(typeof value.plan === "string" && value.plan.trim() ? { plan: value.plan.trim() } : {}),
    ...(typeof value.activeTask === "string" ? { activeTask: value.activeTask } : {}),
    tasks,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    ...(validImport(value.importedFrom) ? { importedFrom: value.importedFrom } : {}),
  };
}

export function reviseWorkflow(workflow: Workflow, input: { goal?: string; plan?: string; tasks: WorkflowTaskRevision[] }, now = new Date().toISOString()): WorkflowDecision {
  if (!input.tasks.length || input.tasks.length > MAX_TASKS) throw new Error("revised workflow requires 1 to 100 tasks");
  const proposedIds = new Set(input.tasks.map((task) => task.id));
  for (const task of workflow.tasks) {
    if ((task.status === "complete" || task.status === "active" || task.status === "blocked") && !proposedIds.has(task.id)) {
      throw new Error(`cannot remove ${task.status} task ${task.id}`);
    }
  }
  const existing = new Map(workflow.tasks.map((task) => [task.id, task]));
  const tasks = input.tasks.map((task) => {
    const previous = existing.get(task.id);
    const normalized = normalizeTask(task);
    if (!previous) return normalized;
    if (previous.status === "complete") return previous;
    return {
      ...normalized,
      status: previous.status,
      evidence: previous.evidence,
      evidenceLinks: previous.evidenceLinks,
      ...(["active", "blocked"].includes(previous.status) ? { verificationCheckpoint: { revision: workflow.revision + 1, at: now } } : {}),
      ...(previous.blockedReason ? { blockedReason: previous.blockedReason } : {}),
      ...(previous.completedAt ? { completedAt: previous.completedAt } : {}),
      ...(previous.importedFrom ? { importedFrom: previous.importedFrom } : {}),
    };
  });
  validateTaskGraph(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const activeTask = workflow.activeTask ? byId.get(workflow.activeTask) : undefined;
  if (activeTask && activeTask.dependsOn.some((id) => !["complete", "deferred"].includes(byId.get(id)!.status))) {
    throw new Error(`active task ${activeTask.id} cannot depend on unfinished work`);
  }
  const allDone = tasks.every((task) => task.status === "complete" || task.status === "deferred");
  const status: WorkflowStatus = allDone ? "complete" : activeTask ? (workflow.status === "paused" ? "paused" : "active") : workflow.status === "complete" || workflow.status === "active" ? "draft" : workflow.status;
  const goal = input.goal === undefined ? workflow.goal : input.goal.trim();
  if (!goal) throw new Error("goal is required");
  if (goal.length > MAX_TEXT) throw new Error("goal exceeds 2048 characters");
  const plan = input.plan === undefined ? workflow.plan : input.plan.trim() || undefined;
  if (plan && plan.length > MAX_TEXT) throw new Error("plan exceeds 2048 characters");
  return changed(workflow, { goal, status, ...(plan ? { plan } : { plan: undefined }), tasks }, now, "workflow plan revised");
}

export function bindVerificationCheckpoint(workflow: Workflow, sessionId: string, branchLength: number): Workflow {
  if (workflow.status !== "active" || !workflow.activeTask) return workflow;
  return {
    ...workflow,
    tasks: workflow.tasks.map((task) => task.id === workflow.activeTask && task.assessmentStatus === "assessed" && task.verificationCheckpoint
      ? { ...task, verificationCheckpoint: { ...task.verificationCheckpoint, sessionId, branchLength } }
      : task),
  };
}

export function readyTasks(workflow: Workflow): WorkflowTask[] {
  const complete = new Set(workflow.tasks.filter((task) => task.status === "complete" || task.status === "deferred").map((task) => task.id));
  return workflow.tasks.filter((task) => task.status === "pending" && task.dependsOn.every((id) => complete.has(id)));
}

export function reduceWorkflow(workflow: Workflow, event: WorkflowEvent, now = new Date().toISOString()): WorkflowDecision {
  const current = workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : undefined;
  if (event.type === "start" || event.type === "resume") {
    if (workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
    if (current) {
      if (current.assessmentStatus === "unassessed") return unchanged(workflow, `${current.id} is unassessed; revise the workflow before execution`);
      return replaceTask(workflow, current.id, { verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active" }, now, `resumed ${current.id}`);
    }
    const blocked = event.type === "resume" ? workflow.tasks.find((task) => task.status === "blocked") : undefined;
    if (blocked) {
      if (blocked.assessmentStatus === "unassessed") return unchanged(workflow, `${blocked.id} is unassessed; revise the workflow before execution`);
      return replaceTask(workflow, blocked.id, { status: "active", blockedReason: undefined, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active", activeTask: blocked.id }, now, `resumed ${blocked.id}`);
    }
    const next = readyTasks(workflow)[0];
    if (!next) return unchanged(workflow, "no dependency-ready task is available");
    if (next.assessmentStatus === "unassessed") return unchanged(workflow, `${next.id} is unassessed; revise the workflow before execution`);
    return replaceTask(workflow, next.id, { status: "active", blockedReason: undefined, verificationCheckpoint: { revision: workflow.revision + 1, at: now } }, { status: "active", activeTask: next.id }, now, `started ${next.id}`);
  }
  if (event.type === "pause") {
    if (workflow.status === "complete") return unchanged(workflow, "workflow is already complete");
    return update(workflow, { status: "paused" }, now, "workflow paused");
  }
  if (event.type === "block") {
    if (!current) return unchanged(workflow, "no active task to block");
    return replaceTask(workflow, current.id, { status: "blocked", blockedReason: event.reason.trim() || "blocked" }, { status: "blocked", activeTask: undefined }, now, `${current.id} blocked`);
  }
  if (event.type === "record-verification") {
    if (workflow.status !== "active" || !current) return unchanged(workflow, "no actively executing task to verify");
    return replaceTask(workflow, current.id, { evidence: [...current.evidence, event.evidence] }, {}, now, `recorded verification for ${current.id}`);
  }
  if (workflow.status !== "active" || !current) return unchanged(workflow, "no actively executing task to complete");
  const latestEvidence = current.evidence.at(-1);
  const checkpoint = current.verificationCheckpoint;
  const currentEvidence = checkpoint ? current.evidence.filter((item) => evidenceMatchesCheckpoint(item, checkpoint)) : [];
  const latestIsCurrent = !!checkpoint && !!latestEvidence && evidenceMatchesCheckpoint(latestEvidence, checkpoint);
  const missingChecks = current.verification.filter((planned) => !currentEvidence.some((item) => item.exitCode === 0 && commandKey(item) === commandKey(planned)));
  if (!event.allowGap && (latestEvidence?.exitCode !== 0 || !latestIsCurrent || latestEvidence.source?.workflowRevision !== workflow.revision - 1 || missingChecks.length)) {
    const suffix = missingChecks.length ? `; missing passing checks: ${missingChecks.map(commandKey).join(", ")}` : "";
    return unchanged(workflow, `${current.id} requires passing protected bash results recorded after its activation/revision checkpoint${suffix}`);
  }
  const completed = replaceTask(workflow, current.id, { status: "complete", blockedReason: undefined, completedAt: now }, { activeTask: undefined }, now, `completed ${current.id}`).workflow;
  const next = readyTasks(completed)[0];
  if (next) {
    if (next.assessmentStatus === "unassessed") return update(completed, { status: "draft" }, now, `completed ${current.id}; ${next.id} requires assessment before execution`);
    return replaceTask(completed, next.id, { status: "active", verificationCheckpoint: { revision: completed.revision + 1, at: now } }, { status: "active", activeTask: next.id }, now, `completed ${current.id}; started ${next.id}`);
  }
  const unfinished = completed.tasks.some((task) => task.status === "pending" || task.status === "active" || task.status === "blocked");
  return update(completed, { status: unfinished ? "blocked" : "complete" }, now, unfinished ? `completed ${current.id}; remaining work is blocked` : `completed ${current.id}; workflow complete`);
}

export function summarizeWorkflow(workflow: Workflow): string {
  const counts = Object.fromEntries(["pending", "active", "blocked", "deferred", "complete"].map((status) => [status, workflow.tasks.filter((task) => task.status === status).length]));
  const current = workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : undefined;
  const ready = readyTasks(workflow).map((task) => task.id);
  return [
    `pi-swe ${workflow.topic} — ${workflow.status} (revision ${workflow.revision})`,
    `goal: ${workflow.goal}`,
    `tasks: ${counts.complete} complete, ${counts.active} active, ${counts.pending} pending, ${counts.blocked} blocked, ${counts.deferred} deferred`,
    `active: ${current ? `${current.id} — ${current.title}` : "none"}`,
    `assessments:`,
    ...workflow.tasks.map((task) => task.assessmentStatus === "unassessed"
      ? `  ${task.id}: unassessed (${task.status === "complete" || task.status === "deferred" ? "legacy terminal record" : "revise before execution"})`
      : `  ${task.id}: ${task.approaches.length ? conciseAssessment(task) : "none"}`),
    `ready: ${ready.length ? ready.join(", ") : "none"}`,
    ...(workflow.importedFrom ? [`source: migrated ${workflow.importedFrom.kind} (${workflow.importedFrom.manifestPath})`] : []),
  ].join("\n");
}

function conciseAssessment(task: WorkflowTask): string {
  const text = task.approaches.map((approach) => `${approach} (${task.approachReasons[approach]})`).join(", ");
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

function normalizeTask(task: Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">, compatibility = false): WorkflowTask {
  if (!record(task) || typeof task.id !== "string" || !TASK_ID.test(task.id)) throw new Error("invalid task id");
  if (typeof task.title !== "string" || !task.title.trim()) throw new Error(`task ${task.id} requires a title`);
  if (task.title.trim().length > 256) throw new Error(`task ${task.id} title exceeds 256 characters`);
  if (task.status !== undefined && !isTaskStatus(task.status)) throw new Error(`task ${task.id} has invalid status`);
  const status = isTaskStatus(task.status) ? task.status : "pending";
  const dependsOn = boundedStrings(task.dependsOn, `task ${task.id} dependencies`, 64, 64);
  const acceptance = boundedStrings(task.acceptance, `task ${task.id} acceptance`, 64, 1024);
  const approaches = normalizeApproaches(task.approaches);
  const approachReasons = normalizeApproachReasons(task.approachReasons, approaches);
  if (task.assessmentStatus !== undefined && task.assessmentStatus !== "assessed" && task.assessmentStatus !== "unassessed") throw new Error(`task ${task.id} has invalid assessmentStatus`);
  const incompleteLegacyAssessment = compatibility && task.assessmentStatus === undefined && (task.approaches === undefined || task.approachReasons === undefined || approaches.some((approach) => !approachReasons[approach]));
  const assessmentStatus: AssessmentStatus = task.assessmentStatus === "unassessed" || incompleteLegacyAssessment ? "unassessed" : "assessed";
  if (assessmentStatus === "assessed") for (const approach of approaches) {
    if (!approachReasons[approach]) throw new Error(`approach ${approach} requires a concise applicability reason`);
  }
  if (task.verification !== undefined && !Array.isArray(task.verification)) throw new Error(`task ${task.id} verification must be an array`);
  if (Array.isArray(task.verification) && task.verification.length > 16) throw new Error(`task ${task.id} has too many verification commands`);
  const verification = Array.isArray(task.verification) ? task.verification.map(normalizeCommand) : [];
  if (new Set(verification.map(commandKey)).size !== verification.length) throw new Error(`task ${task.id} has duplicate verification commands`);
  const verificationCheckpoint = normalizeCheckpoint(task.verificationCheckpoint);
  if (task.evidence !== undefined && !Array.isArray(task.evidence)) throw new Error(`task ${task.id} evidence must be an array`);
  const evidence = Array.isArray(task.evidence) ? task.evidence.map(normalizeEvidence) : [];
  const evidenceLinks = boundedStrings(task.evidenceLinks, `task ${task.id} evidence links`, Number.MAX_SAFE_INTEGER, MAX_TEXT);
  if (typeof task.blockedReason === "string" && task.blockedReason.trim().length > MAX_TEXT) throw new Error(`task ${task.id} blocked reason exceeds 2048 characters`);
  if (task.completedAt !== undefined && (typeof task.completedAt !== "string" || !Number.isFinite(Date.parse(task.completedAt)))) throw new Error(`task ${task.id} has invalid completedAt`);
  return {
    id: task.id,
    title: task.title.trim(),
    status,
    dependsOn,
    acceptance,
    approaches,
    approachReasons,
    assessmentStatus,
    verification,
    ...(verificationCheckpoint ? { verificationCheckpoint } : {}),
    evidence,
    evidenceLinks,
    ...(typeof task.blockedReason === "string" && task.blockedReason.trim() ? { blockedReason: task.blockedReason.trim() } : {}),
    ...(typeof task.completedAt === "string" ? { completedAt: task.completedAt } : {}),
    ...(validTaskImport(task.importedFrom) ? { importedFrom: task.importedFrom } : {}),
  };
}

function validateTaskGraph(tasks: WorkflowTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) {
    if (!ids.has(dependency)) throw new Error(`task ${task.id} has missing dependency ${dependency}`);
    if (dependency === task.id) throw new Error(`task ${task.id} depends on itself`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`task dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

function replaceTask(workflow: Workflow, id: string, taskPatch: Partial<WorkflowTask>, workflowPatch: Partial<Workflow>, now: string, message: string): WorkflowDecision {
  return changed(workflow, { ...workflowPatch, tasks: workflow.tasks.map((task) => task.id === id ? { ...task, ...taskPatch } : task) }, now, message);
}
function update(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision { return changed(workflow, patch, now, message); }
function changed(workflow: Workflow, patch: Partial<Workflow>, now: string, message: string): WorkflowDecision {
  if (!Number.isFinite(Date.parse(now))) throw new Error("invalid workflow timestamp");
  return { workflow: { ...workflow, ...patch, revision: workflow.revision + 1, updatedAt: now }, changed: true, message };
}
function unchanged(workflow: Workflow, message: string): WorkflowDecision { return { workflow, changed: false, message }; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : []; }
function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > maxLength)) throw new Error(`${label} contains an invalid value`);
  const normalized = [...new Set(value.map((item) => (item as string).trim()))];
  if (normalized.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`);
  return normalized;
}
function normalizeApproaches(value: unknown): WorkflowApproach[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("task approaches must be an array");
  const approaches: WorkflowApproach[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !WORKFLOW_APPROACHES.includes(item as WorkflowApproach)) throw new Error(`invalid approach ${String(item)}`);
    if (!approaches.includes(item as WorkflowApproach)) approaches.push(item as WorkflowApproach);
  }
  return approaches;
}
function normalizeApproachReasons(value: unknown, approaches: WorkflowApproach[]): ApproachReasons {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("task approachReasons must be an object");
  const reasons: ApproachReasons = {};
  for (const [key, reason] of Object.entries(value)) {
    if (!approaches.includes(key as WorkflowApproach)) throw new Error(`approach reason ${key} does not name an applicable approach`);
    if (typeof reason !== "string" || !reason.trim()) throw new Error(`approach ${key} requires a non-empty reason`);
    if (reason.trim().length > 1024) throw new Error(`approach ${key} reason exceeds 1024 characters`);
    reasons[key as WorkflowApproach] = reason.trim();
  }
  return reasons;
}
function normalizeCheckpoint(value: unknown): VerificationCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) throw new Error("invalid verification checkpoint");
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId)) throw new Error("invalid verification checkpoint session");
  if (value.branchLength !== undefined && (!Number.isSafeInteger(value.branchLength) || (value.branchLength as number) < 0)) throw new Error("invalid verification checkpoint branch length");
  return { revision: value.revision as number, at: value.at, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}), ...(typeof value.branchLength === "number" ? { branchLength: value.branchLength } : {}) };
}
function commandKey(command: VerificationCommand): string { return [command.command, ...command.args].join(" ").trim(); }
function evidenceMatchesCheckpoint(evidence: VerificationEvidence, checkpoint: VerificationCheckpoint): boolean {
  return Date.parse(evidence.at) > Date.parse(checkpoint.at)
    && evidence.source?.kind === "bash-tool-result"
    && evidence.source.workflowRevision >= checkpoint.revision
    && (checkpoint.sessionId === undefined || evidence.source.sessionId === checkpoint.sessionId);
}
function normalizeCommand(value: unknown): VerificationCommand {
  if (!record(value) || typeof value.command !== "string" || !value.command.trim() || value.command.trim().length > 256) throw new Error("invalid verification command");
  if (value.args !== undefined && !Array.isArray(value.args)) throw new Error("verification args must be an array");
  const args = Array.isArray(value.args) ? value.args.map((arg) => {
    if (typeof arg !== "string" || arg.length > 512) throw new Error("invalid verification argument");
    return arg;
  }) : [];
  if (args.length > 64) throw new Error("too many verification arguments");
  return { command: value.command.trim(), args };
}
function normalizeEvidence(value: unknown): VerificationEvidence {
  const command = normalizeCommand(value);
  if (!record(value) || !Number.isInteger(value.exitCode) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) throw new Error("invalid verification evidence");
  if (value.source !== undefined && (!record(value.source) || value.source.kind !== "bash-tool-result" || typeof value.source.toolCallId !== "string" || !value.source.toolCallId || !Number.isSafeInteger(value.source.workflowRevision) || (value.source.workflowRevision as number) < 1 || (value.source.sessionId !== undefined && (typeof value.source.sessionId !== "string" || !value.source.sessionId)))) throw new Error("invalid verification evidence source");
  const source = record(value.source)
    ? { kind: "bash-tool-result" as const, toolCallId: value.source.toolCallId as string, workflowRevision: value.source.workflowRevision as number, ...(typeof value.source.sessionId === "string" ? { sessionId: value.source.sessionId } : {}) }
    : undefined;
  return { ...command, exitCode: value.exitCode as number, at: value.at, ...(source ? { source } : {}) };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isStatus(value: unknown): value is WorkflowStatus { return ["draft", "active", "paused", "blocked", "complete"].includes(value as string); }
function isTaskStatus(value: unknown): value is TaskStatus { return ["pending", "active", "blocked", "deferred", "complete"].includes(value as string); }
function validImport(value: unknown): value is Workflow["importedFrom"] { return record(value) && value.kind === "pi-swe-v2" && typeof value.manifestPath === "string"; }
function validTaskImport(value: unknown): value is ImportedTaskProvenance {
  if (!record(value) || value.kind !== "pi-swe-v2-contract" || typeof value.contractPath !== "string") return false;
  if (value.contentHash !== undefined && typeof value.contentHash !== "string") return false;
  if (value.completion !== undefined && !record(value.completion)) return false;
  return true;
}
