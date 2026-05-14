import { createPiContextHudSnapshot, getSessionState } from "../pi-context/src/app/index.ts";
import { getGitStatus } from "./git.ts";
import { state } from "./state.ts";
import type { HudSnapshot, SnapshotContext, UsageSnapshot } from "./types.ts";

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function estimateSystemPromptTokens(ctx: SnapshotContext): number | undefined {
  const prompt = ctx.getSystemPrompt?.();
  return prompt ? Math.ceil(prompt.length / 4) : undefined;
}

function readUsageSnapshot(ctx: SnapshotContext): UsageSnapshot | undefined {
  const usage = ctx.getContextUsage?.();
  const tokens = numberOrUndefined(usage?.tokens);
  const promptTokens = tokens === 0 ? estimateSystemPromptTokens(ctx) : undefined;
  const contextTokens = promptTokens && promptTokens > tokens ? promptTokens : tokens;
  const contextWindow = usage?.contextWindow;
  const contextPct = contextTokens !== undefined && contextWindow && contextWindow > 0 ? (contextTokens / contextWindow) * 100 : numberOrUndefined(usage?.percent);
  return usage || state.usage ? {
    ...state.usage,
    totalTokens: contextTokens ?? state.usage?.totalTokens,
    contextTokens,
    contextWindow,
    contextPct,
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
