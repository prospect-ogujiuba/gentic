import { state } from "../state.ts";
import type { HudSnapshot, Theme } from "../types.ts";

export function renderAgentStatus(_s: HudSnapshot, theme: Theme): string {
  return `${theme.fg("dim", "agent:")} ${theme.fg(state.agent === "idle" ? "dim" : "accent", state.agent)}`;
}
