import type { HudComponentId, HudState, Placement, UsageSnapshot } from "../../types.ts";

export const COMPONENT_IDS = ["provider", "model", "context", "git", "session", "tools", "events", "worktime"] as const satisfies readonly HudComponentId[];
export const PLACEMENTS = ["footer", "widget", "both"] as const satisfies readonly Placement[];

export const state: HudState = {
  enabled: true,
  placement: "footer",
  components: { provider: true, model: true, context: true, git: true, session: true, tools: true, events: true, worktime: true },
  agent: "idle",
  turn: 0,
  recentEvents: ["loaded"],
  activeTools: [],
  toolCounts: {},
  successCalls: 0,
  errorCalls: 0,
  warningCalls: 0,
  usageMessageKeys: new Set<string>(),
  workTimer: { active: false, elapsedMs: 0, lastRunMs: 0 },
};

export function isComponentId(value: string | undefined): value is HudComponentId {
  return COMPONENT_IDS.includes(value as HudComponentId);
}

export function isPlacement(value: string | undefined): value is Placement {
  return PLACEMENTS.includes(value as Placement);
}

export function resetConfig(): void {
  state.enabled = true;
  state.placement = "footer";
  for (const id of COMPONENT_IDS) state.components[id] = true;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumUsageField(field: keyof UsageSnapshot, usage: UsageSnapshot): number | undefined {
  const current = state.usage?.[field];
  const next = usage[field];
  return current === undefined && next === undefined ? undefined : (current ?? 0) + (next ?? 0);
}

function addUsage(usage: UsageSnapshot): void {
  state.usage = {
    input: sumUsageField("input", usage),
    output: sumUsageField("output", usage),
    cost: sumUsageField("cost", usage),
    totalTokens: sumUsageField("totalTokens", usage),
  };
}

function messageUsage(message: unknown): UsageSnapshot | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { role?: unknown; usage?: unknown };
  if (record.role !== "assistant" || typeof record.usage !== "object" || record.usage === null) return undefined;

  const usage = record.usage as { input?: unknown; output?: unknown; totalTokens?: unknown; cost?: unknown };
  const cost = typeof usage.cost === "object" && usage.cost !== null
    ? numberOrUndefined((usage.cost as { total?: unknown }).total)
    : numberOrUndefined(usage.cost);
  const snapshot = {
    input: numberOrUndefined(usage.input),
    output: numberOrUndefined(usage.output),
    totalTokens: numberOrUndefined(usage.totalTokens),
    cost,
  };
  return Object.values(snapshot).some((value) => value !== undefined) ? snapshot : undefined;
}

function messageUsageKey(message: unknown, usage: UsageSnapshot): string {
  const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : {};
  return [record.timestamp, record.provider, record.model, usage.input, usage.output, usage.totalTokens, usage.cost].map((value) => value ?? "").join("|");
}

export function resetSessionUsage(): void {
  state.usage = undefined;
  state.usageMessageKeys.clear();
}

export function recordMessageUsage(message: unknown): void {
  const usage = messageUsage(message);
  if (!usage) return;
  const key = messageUsageKey(message, usage);
  if (state.usageMessageKeys.has(key)) return;
  state.usageMessageKeys.add(key);
  addUsage(usage);
}

export function recordMessagesUsage(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) recordMessageUsage(message);
}

export function startWorkTimer(now = Date.now()): void {
  if (state.workTimer.active) return;
  state.workTimer.active = true;
  state.workTimer.startedAt = now;
}

export function stopWorkTimer(now = Date.now()): void {
  if (!state.workTimer.active || state.workTimer.startedAt === undefined) return;
  const runMs = Math.max(0, now - state.workTimer.startedAt);
  state.workTimer.elapsedMs += runMs;
  state.workTimer.lastRunMs = runMs;
  state.workTimer.active = false;
  state.workTimer.startedAt = undefined;
}

export function resetWorkTimer(): void {
  state.workTimer = { active: false, elapsedMs: 0, lastRunMs: 0 };
}

export function getWorkElapsedMs(now = Date.now()): number {
  if (!state.workTimer.active || state.workTimer.startedAt === undefined) return state.workTimer.elapsedMs;
  return state.workTimer.elapsedMs + Math.max(0, now - state.workTimer.startedAt);
}

export function getWorkRunMs(now = Date.now()): number {
  if (!state.workTimer.active || state.workTimer.startedAt === undefined) return state.workTimer.lastRunMs;
  return Math.max(0, now - state.workTimer.startedAt);
}
