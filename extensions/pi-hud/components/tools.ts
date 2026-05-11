import { MUTED_WARNING_COLOR } from "../lib/format.ts";
import { state } from "../state.ts";
import type { HudSnapshot, Theme } from "../types.ts";

export function renderToolBadges(s: HudSnapshot, theme: Theme): string {
  return Object.entries(s.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const active = s.activeTools.some((tool) => tool.toolName === name);
      const label = theme.fg(active ? "accent" : count === 0 ? "dim" : "text", `[${name} ${count}]`);
      return theme.bg ? theme.bg("selectedBg", label) : label;
    })
    .join(theme.fg("dim", " "));
}

export function renderToolSummary(s: HudSnapshot, theme: Theme): string {
  const completed = state.successCalls + state.errorCalls;
  const parts: string[] = [];
  if (completed > 0) {
    parts.push(`${theme.fg("error", "err")} ${theme.fg(state.errorCalls > 0 ? "error" : "dim", `${state.errorCalls}`)}`);
    parts.push(`${theme.fg(MUTED_WARNING_COLOR, "warn")} ${theme.fg(state.warningCalls > 0 ? MUTED_WARNING_COLOR : "dim", `${state.warningCalls}`)}`);
    parts.push(`${theme.fg("dim", "ok/fail")} ${theme.fg(state.successCalls > 0 ? "success" : "dim", `${state.successCalls}`)}${theme.fg("dim", ":")}${theme.fg(state.errorCalls > 0 ? "error" : "dim", `${state.errorCalls}`)}`);
  }
  if (s.activeTools.length > 0) parts.push(`${theme.fg("accent", "pending")} ${theme.fg("accent", `${s.activeTools.length}`)}`);
  return parts.join(` ${theme.fg("dim", "·")} `);
}
