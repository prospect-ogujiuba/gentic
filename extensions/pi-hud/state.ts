import type { HudComponentId, HudState, Placement } from "./types.ts";

export const COMPONENT_IDS = ["model", "context", "git", "session", "agent", "tools", "events"] as const satisfies readonly HudComponentId[];
export const PLACEMENTS = ["footer", "widget", "both"] as const satisfies readonly Placement[];

export const state: HudState = {
  enabled: true,
  placement: "footer",
  components: { model: true, context: true, git: true, session: true, agent: true, tools: true, events: true },
  agent: "idle",
  turn: 0,
  recentEvents: ["loaded"],
  activeTools: [],
  toolCounts: {},
  successCalls: 0,
  errorCalls: 0,
  warningCalls: 0,
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
