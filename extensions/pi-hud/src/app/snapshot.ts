import { createNativeContextSnapshot, createPiContextHudSnapshot } from "../../../pi-context/src/app/index.ts";
import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  type ContextPressurePolicy,
} from "../../../pi-context/src/domain/index.ts";
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
  capturedAt?: string,
) {
  return createPiContextHudSnapshot(createNativeContextSnapshot({
    getContextUsage: () => usage,
    getSystemPromptOptions: () => undefined,
    sessionManager: { getBranch: () => [] },
  } as never, { capturedAt, pressurePolicy, collectContributors: false }), { topContributors: 0 });
}

export function withLiveUsage(
  snapshot: HudSnapshot,
  ctx: SnapshotContext,
  pressurePolicy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
): HudSnapshot {
  const nativeUsage = readNativeUsage(ctx);
  return {
    ...snapshot,
    usage: readUsageSnapshot(nativeUsage),
    piContext: createPressureSnapshot(nativeUsage, pressurePolicy, snapshot.piContext?.capturedAt),
  };
}

export function createSnapshot(
  ctx: SnapshotContext,
  pressurePolicy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
): HudSnapshot {
  const gitState = gitSnapshotService.getState(ctx.cwd);
  const nativeUsage = readNativeUsage(ctx);
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: readUsageSnapshot(nativeUsage),
    piContext: createPressureSnapshot(nativeUsage, pressurePolicy),
    git: gitState.snapshot,
    gitState,
    activeTools: state.activeTools,
    activity: state.agent,
  };
}
