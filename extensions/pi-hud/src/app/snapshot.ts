import { createNativeContextSnapshot, createPiContextHudSnapshot } from "../../../pi-context/src/app/index.ts";
import { gitSnapshotService } from "./git-snapshot-service.ts";
import { state } from "./state.ts";
import type { HudSnapshot, SnapshotContext, UsageSnapshot } from "../../types.ts";

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
  const contextTokens = promptTokens && promptTokens > (tokens ?? 0) ? promptTokens : tokens;
  const contextWindow = numberOrUndefined(usage?.contextWindow);
  const contextPct = contextTokens !== undefined && contextWindow && contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : numberOrUndefined(usage?.percent);
  return usage ? { contextTokens, contextWindow, contextPct } : undefined;
}

export function withLiveUsage(snapshot: HudSnapshot, ctx: SnapshotContext): HudSnapshot {
  const usage = readUsageSnapshot(ctx);
  return usage ? { ...snapshot, usage } : snapshot;
}

export function createSnapshot(ctx: SnapshotContext): HudSnapshot {
  const gitState = gitSnapshotService.getState(ctx.cwd);
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: readUsageSnapshot(ctx),
    piContext: createPiContextHudSnapshot(createNativeContextSnapshot({
      getContextUsage: () => ctx.getContextUsage?.(),
      getSystemPromptOptions: () => ({ cwd: ctx.cwd }),
      sessionManager: ctx.sessionManager ?? { getBranch: () => [] },
    } as never), { topContributors: 0 }),
    git: gitState.snapshot,
    gitState,
    activeTools: state.activeTools,
    activity: state.agent,
  };
}
