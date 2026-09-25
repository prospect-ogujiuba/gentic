import {
  piContextProvider,
  type ContextPressurePolicy,
  type HudContextProvider,
} from "./context-provider.ts";
import { gitSnapshotService } from "./git-snapshot-service.ts";
import { state } from "./state.ts";
import type { HudSnapshot, SnapshotContext, UsageSnapshot } from "../../types.ts";

type NativeUsage = ReturnType<SnapshotContext["getContextUsage"]>;

function readNativeUsage(ctx: SnapshotContext): NativeUsage | undefined {
  try {
    return ctx.getContextUsage?.();
  } catch {
    return undefined;
  }
}

function nonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function percentNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function readUsageSnapshot(usage: NativeUsage | undefined): UsageSnapshot | undefined {
  if (!usage) return undefined;
  const contextTokens = nonNegativeNumber(usage.tokens);
  const contextWindow = positiveNumber(usage.contextWindow);
  const contextPct = contextTokens !== undefined && contextWindow !== undefined
    ? Math.min(100, (contextTokens / contextWindow) * 100)
    : percentNumber(usage.percent);
  return { contextTokens, contextWindow, contextPct };
}

function createPressureSnapshot(
  usage: NativeUsage | undefined,
  pressurePolicy: ContextPressurePolicy,
  provider: HudContextProvider,
  capturedAt?: string,
) {
  return provider.createHudSnapshot(usage, pressurePolicy, capturedAt);
}

export function withLiveUsage(
  snapshot: HudSnapshot,
  ctx: SnapshotContext,
  pressurePolicy: ContextPressurePolicy = piContextProvider.defaultPressurePolicy,
  provider: HudContextProvider = piContextProvider,
): HudSnapshot {
  const nativeUsage = readNativeUsage(ctx);
  return {
    ...snapshot,
    usage: readUsageSnapshot(nativeUsage),
    piContext: createPressureSnapshot(nativeUsage, pressurePolicy, provider, snapshot.piContext?.capturedAt),
  };
}

export function createSnapshot(
  ctx: SnapshotContext,
  pressurePolicy: ContextPressurePolicy = piContextProvider.defaultPressurePolicy,
  provider: HudContextProvider = piContextProvider,
): HudSnapshot {
  const gitState = gitSnapshotService.getState(ctx.cwd);
  const nativeUsage = readNativeUsage(ctx);
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: readUsageSnapshot(nativeUsage),
    piContext: createPressureSnapshot(nativeUsage, pressurePolicy, provider),
    git: gitState.snapshot,
    gitState,
    activeTools: state.activeTools,
    activity: state.agent,
  };
}
