import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  reduceContextPressure,
  type ContextPressurePolicy,
  type ContextPressureState,
} from "../domain/index.ts";
import type { NativeContextSnapshot, NativeSnapshotPressure } from "./native-snapshot-contract.ts";

export type NativeContextPressureTransition = {
  snapshot: NativeContextSnapshot;
  state: ContextPressureState;
  notification?: "warning" | "critical";
};

export function advanceNativeContextPressure(
  snapshot: NativeContextSnapshot,
  state: ContextPressureState,
  policy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
  nowMs = Date.now(),
): NativeContextPressureTransition {
  const usage = snapshot.usage;
  const transition = reduceContextPressure(
    state,
    usage.usedTokens === undefined && usage.remainingPercent === undefined
      ? undefined
      : {
          tokens: usage.usedTokens,
          contextWindow: usage.contextWindowTokens,
          percent: usage.remainingPercent === undefined ? undefined : 100 - usage.remainingPercent,
          tokenConfidence: "exact",
        },
    policy,
    nowMs,
  );
  const pressure: NativeSnapshotPressure = transition.evaluation.available
    ? {
        available: true,
        level: transition.evaluation.level,
        remainingPercent: transition.evaluation.remainingPercent,
      }
    : { available: false, level: "unavailable" };

  return {
    snapshot: { ...snapshot, pressure },
    state: transition.state,
    notification: transition.evaluation.notification,
  };
}
