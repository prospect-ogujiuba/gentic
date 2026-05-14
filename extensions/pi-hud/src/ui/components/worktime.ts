import { getWorkElapsedMs, getWorkRunMs, state } from "../../app/state.ts";
import type { HudSnapshot, Theme } from "../../../types.ts";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function renderWorktime(_s: HudSnapshot, theme: Theme): string {
  const color = state.workTimer.active ? "accent" : "dim";
  return `${theme.fg("dim", "work:")} ${theme.fg(color, formatDuration(getWorkElapsedMs()))}`;
}

export function renderWorktimeDetails(_s: HudSnapshot, theme: Theme): string[] {
  return [
    `${theme.fg("dim", "active")} ${theme.fg("accent", formatDuration(getWorkElapsedMs()))}`,
    `${theme.fg("dim", "last run")} ${theme.fg("text", formatDuration(getWorkRunMs()))}`,
  ];
}
