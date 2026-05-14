import { createPiContextHudSnapshot, getSessionState } from "../pi-context/src/app/index.ts";
import { getGitStatus } from "./git.ts";
import { state } from "./state.ts";
import type { HudSnapshot, SnapshotContext, UsageSnapshot } from "./types.ts";

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageSnapshot(ctx: SnapshotContext): UsageSnapshot | undefined {
  const usage = ctx.getContextUsage?.();
  const tokens = numberOrUndefined(usage?.tokens);
  return usage || state.usage ? {
    ...state.usage,
    totalTokens: tokens ?? state.usage?.totalTokens,
    contextTokens: tokens,
    contextWindow: usage?.contextWindow,
    contextPct: numberOrUndefined(usage?.percent),
  } : undefined;
}

export function withLiveUsage(snapshot: HudSnapshot, ctx: SnapshotContext): HudSnapshot {
  const usage = readUsageSnapshot(ctx);
  return usage ? { ...snapshot, usage } : snapshot;
}

export function createSnapshot(ctx: SnapshotContext): HudSnapshot {
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: readUsageSnapshot(ctx),
    piContext: createPiContextHudSnapshot(getSessionState(), { topContributors: 3 }),
    git: getGitStatus(ctx.cwd),
    activeTools: state.activeTools,
    toolCounts: state.toolCounts,
    recentEvents: state.recentEvents,
    thinkingLevel: state.thinkingLevel,
  };
}
