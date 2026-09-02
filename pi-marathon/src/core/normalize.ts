import type { CriticOutput, FinalAuditOutput, PlanOutput, PlannedTask, TaskType, VerifierOutput, WorkerOutput } from "./types.js";
import { clamp, uniqueStrings } from "./util.js";

const TASK_TYPES = new Set<TaskType>(["research", "implementation", "test", "documentation", "review"]);
const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value.trim() || fallback : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function normalizeTask(value: unknown, index: number): PlannedTask {
  const input = record(value);
  const rawKey = text(input.key, `task-${index + 1}`).toLowerCase();
  const key = rawKey.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `task-${index + 1}`;
  const rawType = text(input.type, "implementation") as TaskType;
  const commands = uniqueStrings(record(input.verification).commands, 20);
  const notes = uniqueStrings(record(input.verification).notes, 20);
  const maxAttempts = typeof input.maxAttempts === "number" ? Math.floor(clamp(input.maxAttempts, 1, 20)) : undefined;
  return {
    key,
    title: text(input.title, key),
    description: text(input.description, text(input.title, key)),
    type: TASK_TYPES.has(rawType) ? rawType : "implementation",
    priority: typeof input.priority === "number" ? clamp(input.priority, 0, 100) : 50,
    dependsOn: uniqueStrings(input.dependsOn, 100),
    acceptanceCriteria: uniqueStrings(input.acceptanceCriteria, 50).length ? uniqueStrings(input.acceptanceCriteria, 50) : [`${text(input.title, key)} is complete and verified`],
    verification: { commands, ...(notes.length ? { notes } : {}) },
    ...(maxAttempts ? { maxAttempts } : {}),
  };
}

function assertAcyclic(tasks: PlannedTask[]): void {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (key: string, stack: string[]): void => {
    const current = state.get(key) ?? 0;
    if (current === 1) throw new Error(`Task dependency cycle: ${[...stack, key].join(" -> ")}`);
    if (current === 2) return;
    state.set(key, 1);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency, [...stack, key]);
    state.set(key, 2);
  };
  for (const task of tasks) visit(task.key, []);
}

export function normalizePlan(value: unknown, maxTasks: number): PlanOutput {
  const input = record(value);
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (!rawTasks.length) throw new Error("Planner returned no tasks");
  const tasks = rawTasks.slice(0, maxTasks).map(normalizeTask);
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) throw new Error(`Duplicate task key: ${task.key}`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((key) => key !== task.key);
    for (const dependency of task.dependsOn) if (!keys.has(dependency)) throw new Error(`Task ${task.key} depends on unknown task ${dependency}`);
  }
  assertAcyclic(tasks);
  return { summary: text(input.summary, `Plan with ${tasks.length} tasks`), tasks };
}

export function normalizeRepairTasks(value: unknown, existingKeys: Set<string>, maxTasks: number): PlannedTask[] {
  const values = Array.isArray(value) ? value : [];
  const result: PlannedTask[] = [];
  for (let index = 0; index < values.length && result.length < maxTasks; index += 1) {
    const task = normalizeTask(values[index], index);
    let key = task.key;
    let suffix = 2;
    while (existingKeys.has(key)) key = `${task.key}-${suffix++}`.slice(0, 80);
    task.key = key;
    task.dependsOn = task.dependsOn.filter((item) => existingKeys.has(item));
    existingKeys.add(key);
    result.push(task);
  }
  return result;
}

export function normalizeWorkerOutput(value: unknown): WorkerOutput {
  const input = record(value);
  const changes = (Array.isArray(input.changes) ? input.changes : []).map((item) => {
    const row = record(item); return { path: text(row.path), description: text(row.description) };
  }).filter((item) => item.path);
  return {
    status: input.status === "blocked" ? "blocked" : "completed",
    summary: text(input.summary, "Worker completed"),
    changes,
    commandsRun: uniqueStrings(input.commandsRun, 100),
    evidence: uniqueStrings(input.evidence, 100),
    blockers: uniqueStrings(input.blockers, 50),
    suggestedTasks: (Array.isArray(input.suggestedTasks) ? input.suggestedTasks : []).slice(0, 20).map(normalizeTask),
  };
}

function issues(value: unknown): VerifierOutput["issues"] {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => {
    const row = record(item);
    const severity: "critical" | "major" | "minor" = row.severity === "critical" || row.severity === "minor" ? row.severity : "major";
    return { severity, description: text(row.description), evidence: text(row.evidence), recommendedFix: text(row.recommendedFix) };
  }).filter((item) => item.description);
}

export function normalizeVerifierOutput(value: unknown): VerifierOutput {
  const input = record(value);
  const verdict = input.verdict === "pass" || input.verdict === "blocked" ? input.verdict : "fail";
  const acceptance = (Array.isArray(input.acceptance) ? input.acceptance : []).slice(0, 100).map((item) => {
    const row = record(item); return { criterion: text(row.criterion), passed: row.passed === true, evidence: text(row.evidence) };
  }).filter((item) => item.criterion);
  return {
    verdict, summary: text(input.summary, `Verification ${verdict}`), acceptance, issues: issues(input.issues),
    retryGuidance: text(input.retryGuidance), repairTasks: (Array.isArray(input.repairTasks) ? input.repairTasks : []).slice(0, 20).map(normalizeTask),
  };
}

export function normalizeCriticOutput(value: unknown): CriticOutput {
  const input = record(value);
  return {
    diagnosis: text(input.diagnosis, "The previous strategy did not resolve the verified failure."),
    failedAssumptions: uniqueStrings(input.failedAssumptions, 50),
    newStrategy: text(input.newStrategy, "Reinspect the failure evidence and use a materially different implementation strategy."),
    concreteNextActions: uniqueStrings(input.concreteNextActions, 50),
  };
}

export function normalizeFinalAuditOutput(value: unknown): FinalAuditOutput {
  const input = record(value);
  const verdict = input.verdict === "pass" || input.verdict === "blocked" ? input.verdict : "fail";
  return {
    verdict, summary: text(input.summary, `Final audit ${verdict}`), goalSatisfied: input.goalSatisfied === true,
    evidence: uniqueStrings(input.evidence, 100), issues: issues(input.issues),
    repairTasks: (Array.isArray(input.repairTasks) ? input.repairTasks : []).slice(0, 50).map(normalizeTask),
  };
}
