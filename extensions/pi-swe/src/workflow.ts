export const WORKFLOW_VERSION = 1 as const;

export type WorkflowStatus = "draft" | "active" | "paused" | "blocked" | "complete";
export type TaskStatus = "pending" | "active" | "blocked" | "deferred" | "complete";

export type VerificationCommand = { command: string; args: string[] };
export type VerificationEvidence = VerificationCommand & { exitCode: number; at: string };

export type WorkflowTask = {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  acceptance: string[];
  verification: VerificationCommand[];
  evidence: VerificationEvidence[];
  blockedReason?: string;
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

const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  if (!input.tasks.length) throw new Error("at least one task is required");
  const tasks = input.tasks.map((task) => normalizeTask(task));
  validateTaskGraph(tasks);
  return {
    version: WORKFLOW_VERSION,
    topic: input.topic,
    revision: 1,
    status: "draft",
    goal: input.goal.trim(),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}),
    tasks,
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function parseWorkflow(value: unknown): Workflow {
  if (!record(value) || value.version !== WORKFLOW_VERSION) throw new Error(`unsupported workflow version`);
  if (!isValidTopic(value.topic as string)) throw new Error("invalid workflow topic");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid workflow revision");
  if (!isStatus(value.status) || typeof value.goal !== "string" || !(value.goal as string).trim()) throw new Error("invalid workflow state");
  if (!Array.isArray(value.tasks) || !value.tasks.length) throw new Error("workflow requires tasks");
  const tasks = value.tasks.map((task) => normalizeTask(task as Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">));
  validateTaskGraph(tasks);
  const active = tasks.filter((task) => task.status === "active");
  if (active.length > 1) throw new Error("workflow has multiple active tasks");
  if (value.activeTask !== undefined && (typeof value.activeTask !== "string" || active[0]?.id !== value.activeTask)) throw new Error("activeTask does not match task state");
  if (active.length && value.activeTask !== active[0]!.id) throw new Error("active task pointer is missing");
  return {
    version: WORKFLOW_VERSION,
    topic: value.topic as string,
    revision: value.revision as number,
    status: value.status,
    goal: (value.goal as string).trim(),
    ...(typeof value.plan === "string" && value.plan.trim() ? { plan: value.plan.trim() } : {}),
    ...(typeof value.activeTask === "string" ? { activeTask: value.activeTask } : {}),
    tasks,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    ...(validImport(value.importedFrom) ? { importedFrom: value.importedFrom } : {}),
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
    if (current) return update(workflow, { status: "active" }, now, `resumed ${current.id}`);
    const blocked = event.type === "resume" ? workflow.tasks.find((task) => task.status === "blocked") : undefined;
    if (blocked) return replaceTask(workflow, blocked.id, { status: "active", blockedReason: undefined }, { status: "active", activeTask: blocked.id }, now, `resumed ${blocked.id}`);
    const next = readyTasks(workflow)[0];
    if (!next) return unchanged(workflow, "no dependency-ready task is available");
    return replaceTask(workflow, next.id, { status: "active", blockedReason: undefined }, { status: "active", activeTask: next.id }, now, `started ${next.id}`);
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
    if (!current) return unchanged(workflow, "no active task to verify");
    return replaceTask(workflow, current.id, { evidence: [...current.evidence, event.evidence] }, {}, now, `recorded verification for ${current.id}`);
  }
  if (!current) return unchanged(workflow, "no active task to complete");
  if (!event.allowGap && current.evidence.at(-1)?.exitCode !== 0) return unchanged(workflow, `${current.id} requires a passing latest verification command`);
  const completed = replaceTask(workflow, current.id, { status: "complete", blockedReason: undefined }, { activeTask: undefined }, now, `completed ${current.id}`).workflow;
  const next = readyTasks(completed)[0];
  if (next) return replaceTask(completed, next.id, { status: "active" }, { status: "active", activeTask: next.id }, now, `completed ${current.id}; started ${next.id}`);
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
    `ready: ${ready.length ? ready.join(", ") : "none"}`,
    ...(workflow.importedFrom ? [`source: migrated ${workflow.importedFrom.kind} (${workflow.importedFrom.manifestPath})`] : []),
  ].join("\n");
}

function normalizeTask(task: Partial<WorkflowTask> & Pick<WorkflowTask, "id" | "title">): WorkflowTask {
  if (!record(task) || typeof task.id !== "string" || !TASK_ID.test(task.id)) throw new Error("invalid task id");
  if (typeof task.title !== "string" || !task.title.trim()) throw new Error(`task ${task.id} requires a title`);
  const status = isTaskStatus(task.status) ? task.status : "pending";
  const dependsOn = strings(task.dependsOn);
  const acceptance = strings(task.acceptance);
  const verification = Array.isArray(task.verification) ? task.verification.map(normalizeCommand) : [];
  const evidence = Array.isArray(task.evidence) ? task.evidence.map(normalizeEvidence) : [];
  return { id: task.id, title: task.title.trim(), status, dependsOn, acceptance, verification, evidence, ...(typeof task.blockedReason === "string" && task.blockedReason.trim() ? { blockedReason: task.blockedReason.trim() } : {}) };
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
  return { workflow: { ...workflow, ...patch, revision: workflow.revision + 1, updatedAt: now }, changed: true, message };
}
function unchanged(workflow: Workflow, message: string): WorkflowDecision { return { workflow, changed: false, message }; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : []; }
function normalizeCommand(value: unknown): VerificationCommand {
  if (!record(value) || typeof value.command !== "string" || !value.command.trim()) throw new Error("invalid verification command");
  return { command: value.command.trim(), args: strings(value.args) };
}
function normalizeEvidence(value: unknown): VerificationEvidence {
  const command = normalizeCommand(value);
  if (!record(value) || !Number.isInteger(value.exitCode) || typeof value.at !== "string") throw new Error("invalid verification evidence");
  return { ...command, exitCode: value.exitCode as number, at: value.at };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isStatus(value: unknown): value is WorkflowStatus { return ["draft", "active", "paused", "blocked", "complete"].includes(value as string); }
function isTaskStatus(value: unknown): value is TaskStatus { return ["pending", "active", "blocked", "deferred", "complete"].includes(value as string); }
function validImport(value: unknown): value is Workflow["importedFrom"] { return record(value) && value.kind === "pi-swe-v2" && typeof value.manifestPath === "string"; }
