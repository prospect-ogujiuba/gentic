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
