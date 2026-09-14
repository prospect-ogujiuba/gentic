import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentState, GitSnapshotStatus, HudSnapshot, Theme } from "../../../types.ts";
import { cleanTruncate, compactNumber } from "../lib/format.ts";

const SEPARATOR = " · ";
type HudSnapshotSource = HudSnapshot | (() => HudSnapshot);

function resolveSnapshot(source: HudSnapshotSource): HudSnapshot {
  return typeof source === "function" ? source() : source;
}

function modelValue(snapshot: HudSnapshot): string {
  const model = snapshot.modelId?.trim();
  if (!model) return "unknown";
  const slash = model.lastIndexOf("/");
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}

type ContextValues = {
  level: string;
  remaining?: string;
  usedPercent?: number;
  tokens?: string;
};

function contextValues(snapshot: HudSnapshot): ContextValues {
  const context = snapshot.piContext;
  if (context?.available && context.pressure.available) {
    const remainingPercent = context.pressure.remainingPercent;
    const usedPercent = remainingPercent !== undefined
      ? 100 - remainingPercent
      : context.totalTokens !== undefined && context.contextWindowTokens
        ? (context.totalTokens / context.contextWindowTokens) * 100
        : undefined;
    const remaining = remainingPercent === undefined
      ? context.remainingTokens === undefined ? undefined : `${compactNumber(context.remainingTokens)} left`
      : `${Math.max(0, Math.min(100, Math.round(remainingPercent)))}% left`;
    const tokens = context.totalTokens !== undefined && context.contextWindowTokens !== undefined
      ? `${compactNumber(context.totalTokens)}/${compactNumber(context.contextWindowTokens)}`
      : undefined;
    return { level: context.pressure.level, remaining, usedPercent, tokens };
  }

  const usedPercent = snapshot.usage?.contextPct;
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
    const bounded = Math.max(0, Math.min(100, usedPercent));
    const level = bounded >= 90 ? "critical" : bounded >= 60 ? "warning" : "normal";
    const tokens = snapshot.usage?.contextTokens !== undefined && snapshot.usage.contextWindow !== undefined
      ? `${compactNumber(snapshot.usage.contextTokens)}/${compactNumber(snapshot.usage.contextWindow)}`
      : undefined;
    return { level, remaining: `${Math.round(100 - bounded)}% left`, usedPercent: bounded, tokens };
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
  const state = status === "stale" ? "stale" : status === "loading" ? "loading" : "";
  const parts = [`${git.branch}${git.dirty ? "(*)" : ""}`];
  if (!git.upstream) parts.push("no upstream");
  else {
    if (git.remoteName) parts.push(git.remoteName);
    if (git.aheadCount === 0 && git.behindCount === 0) parts.push("synced");
    parts.push(`↓(${git.behindCount})|↑(${git.aheadCount})`);
  }
  if (git.unstagedCount > 0) parts.push(`unstaged (${git.unstagedCount})`);
  if (git.untrackedCount > 0) parts.push(`untracked (${git.untrackedCount})`);
  if (git.stagedCount > 0) parts.push(`staged (${git.stagedCount})`);
  if (state) parts.push(state);
  return { full: parts.join(SEPARATOR), compact: `${git.branch}${git.dirty ? "*" : ""}${state ? ` ${state}` : ""}` };
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

function renderContext(theme: Theme, context: ContextValues, color: string): string {
  const parts = [theme.fg(color, context.level)];
  if (context.usedPercent !== undefined) {
    const barWidth = 16;
    const bounded = Math.max(0, Math.min(100, context.usedPercent));
    const filled = Math.round((bounded / 100) * barWidth);
    parts.push(`${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(barWidth - filled))}`);
  }
  if (context.tokens) parts.push(theme.fg("text", context.tokens));
  if (context.remaining) parts.push(theme.fg(color, context.remaining));
  return `${theme.fg("dim", "context ")}${parts.join(" ")}`;
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
  const modelFull = labeled(theme, "model", modelValue(snapshot), "accent");
  const contextFull = renderContext(theme, context, pressureColor);
  const gitFull = labeled(theme, "git", git.full);
  const activityFull = labeled(theme, "activity", activity);
  const fullLine = [modelFull, contextFull, gitFull, activityFull].join(separator);
  if (fits(fullLine, boundedWidth)) return [fullLine];

  if (boundedWidth >= 64) {
    const modelContext = [modelFull, contextFull].join(separator);
    const gitActivity = [gitFull, activityFull].join(separator);
    const firstLines = fits(modelContext, boundedWidth) ? [modelContext] : [modelFull, contextFull];
    const secondLines = fits(gitActivity, boundedWidth) ? [gitActivity] : [gitFull, activityFull];
    return [...firstLines, ...secondLines].map((line) => cleanTruncate(line, boundedWidth)).filter(Boolean);
  }

  const compactGroups = [
    labeled(theme, "m", modelValue(snapshot), "accent"),
    labeled(theme, "ctx", context.level, pressureColor),
    labeled(theme, "git", git.compact),
    labeled(theme, "act", activity),
  ];
  const narrowLines: string[] = [];
  for (let index = 0; index < compactGroups.length; index += 2) {
    const pair = compactGroups.slice(index, index + 2).join(separator);
    if (fits(pair, boundedWidth)) narrowLines.push(pair);
    else narrowLines.push(...compactGroups.slice(index, index + 2));
  }
  return narrowLines.map((line) => cleanTruncate(line, boundedWidth)).filter(Boolean);
}

/** Timer-free Pi component factory; refresh ownership stays with the runtime. */
export function createHudWidgetComponent(source: HudSnapshotSource) {
  return (_tui: unknown, theme: Theme) => ({
    dispose() {},
    invalidate() {},
    render(width: number): string[] {
      return renderHudWidgetLines(resolveSnapshot(source), theme, width);
    },
  });
}
