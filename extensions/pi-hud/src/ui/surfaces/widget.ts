import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentState, GitSnapshotStatus, HudSnapshot, Theme } from "../../../types.ts";
import { cleanTruncate, compactNumber } from "../lib/format.ts";

const SEPARATOR = " · ";

function modelValue(snapshot: HudSnapshot): string {
  const model = snapshot.modelId?.trim();
  if (!model) return "unknown";
  const slash = model.lastIndexOf("/");
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}

function contextValues(snapshot: HudSnapshot): { level: string; remaining?: string } {
  const context = snapshot.piContext;
  if (context?.available && context.pressure.available) {
    const percent = context.pressure.remainingPercent;
    const remaining = percent === undefined
      ? context.remainingTokens === undefined ? undefined : `${compactNumber(context.remainingTokens)} left`
      : `${Math.max(0, Math.min(100, Math.round(percent)))}% left`;
    return { level: context.pressure.level, remaining };
  }

  const usedPercent = snapshot.usage?.contextPct;
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
    const bounded = Math.max(0, Math.min(100, usedPercent));
    const level = bounded >= 90 ? "critical" : bounded >= 60 ? "warning" : "normal";
    return { level, remaining: `${Math.round(100 - bounded)}% left` };
  }
  return { level: "unavailable" };
}

function gitValues(snapshot: HudSnapshot): { full: string; compact: string } {
  const status: GitSnapshotStatus = snapshot.gitState?.status ?? (snapshot.git ? "fresh" : "unavailable");
  if (!snapshot.git) {
    const label = status === "error" ? "error" : status;
    return { full: label, compact: label };
  }

  const git = snapshot.git;
  const state = status === "stale" ? " stale" : status === "loading" ? " loading" : "";
  const divergence = [git.behindCount ? `↓${git.behindCount}` : "", git.aheadCount ? `↑${git.aheadCount}` : ""].filter(Boolean).join(" ");
  const full = [git.branch, git.dirty ? "dirty" : "clean", divergence, state.trim()].filter(Boolean).join(" ");
  return { full, compact: `${git.branch}${git.dirty ? "*" : ""}${state}` };
}

function activityValue(snapshot: HudSnapshot): string {
  const tool = snapshot.activeTools[0]?.toolName?.trim();
  return tool || snapshot.activity || "idle";
}

function colorForPressure(level: string): string {
  if (level === "critical") return "error";
  if (level === "warning") return "syntaxString";
  return level === "unavailable" ? "dim" : "success";
}

function labeled(theme: Theme, label: string, value: string, color = "text"): string {
  return `${theme.fg("dim", `${label} `)}${theme.fg(color, value)}`;
}

function fits(line: string, width: number): boolean {
  return visibleWidth(line) <= width;
}

/** Pure projection of a HUD snapshot into one optional, width-bounded widget. */
export function renderHudWidgetLines(snapshot: HudSnapshot, theme: Theme, width: number): string[] {
  const boundedWidth = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (boundedWidth === 0) return [];

  const context = contextValues(snapshot);
  const git = gitValues(snapshot);
  const activity = activityValue(snapshot);
  const pressureColor = colorForPressure(context.level);
  const separator = theme.fg("dim", SEPARATOR);
  const candidates = [
    [
      labeled(theme, "model", modelValue(snapshot), "accent"),
      labeled(theme, "context", [context.level, context.remaining].filter(Boolean).join(" "), pressureColor),
      labeled(theme, "git", git.full),
      labeled(theme, "activity", activity),
    ],
    [
      labeled(theme, "model", modelValue(snapshot), "accent"),
      labeled(theme, "context", context.level, pressureColor),
      labeled(theme, "git", git.compact),
      labeled(theme, "activity", activity),
    ],
    [
      labeled(theme, "m", modelValue(snapshot), "accent"),
      labeled(theme, "ctx", context.level, pressureColor),
      labeled(theme, "git", git.compact),
      labeled(theme, "act", activity),
    ],
  ].map((parts) => parts.join(separator));

  return [cleanTruncate(candidates.find((line) => fits(line, boundedWidth)) ?? candidates.at(-1)!, boundedWidth)];
}
