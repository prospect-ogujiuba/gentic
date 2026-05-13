import { getGitStatus } from "./git.ts";
import { state } from "./state.ts";
import type { HudSnapshot, SnapshotContext } from "./types.ts";

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createSnapshot(ctx: SnapshotContext): HudSnapshot {
  const usage = ctx.getContextUsage?.();
  const tokens = numberOrUndefined(usage?.tokens);
  const usageSnapshot = usage || state.usage ? {
    ...state.usage,
    totalTokens: tokens ?? state.usage?.totalTokens,
    contextTokens: tokens,
    contextWindow: usage?.contextWindow,
    contextPct: numberOrUndefined(usage?.percent),
  } : undefined;
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: usageSnapshot,
    git: getGitStatus(ctx.cwd),
    activeTools: state.activeTools,
    toolCounts: state.toolCounts,
    recentEvents: state.recentEvents,
    thinkingLevel: state.thinkingLevel,
  };
}
