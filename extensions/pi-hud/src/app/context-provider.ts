import {
  createNativeContextSnapshot,
  createPiContextHudSnapshot,
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  loadEffectiveContextConfig,
  type ContextPressurePolicy,
  type PiContextHudSnapshot,
} from "../../../pi-context/index.ts";

export type HudNativeUsage = {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
} | undefined;

export interface HudContextProvider {
  readonly defaultPressurePolicy: ContextPressurePolicy;
  loadPressurePolicy(cwd: string): ContextPressurePolicy;
  createHudSnapshot(
    usage: HudNativeUsage,
    pressurePolicy: ContextPressurePolicy,
    capturedAt?: string,
  ): PiContextHudSnapshot;
}

/** Stable public pi-context boundary adapted to the aggregate-only data needed by the HUD. */
export const piContextProvider: HudContextProvider = Object.freeze({
  defaultPressurePolicy: DEFAULT_CONTEXT_PRESSURE_POLICY,
  loadPressurePolicy(cwd: string) {
    return loadEffectiveContextConfig({ cwd }).config.pressure;
  },
  createHudSnapshot(usage: HudNativeUsage, pressurePolicy: ContextPressurePolicy, capturedAt?: string) {
    const native = createNativeContextSnapshot({
      getContextUsage: () => usage,
      getSystemPromptOptions: () => undefined,
      sessionManager: { getBranch: () => [] },
    } as never, { capturedAt, pressurePolicy, collectContributors: false });
    return createPiContextHudSnapshot(native, { topContributors: 0 });
  },
});

export type { ContextPressurePolicy, PiContextHudSnapshot };
