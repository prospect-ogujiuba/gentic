import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSweExternalCapabilities } from "../capabilities.ts";
import type { SweCapabilityAdapter, SweCapabilityWarning, SweExternalTodo, SweTodoEvidence, SweTodoScope } from "../domain/capabilities.ts";
import type { PiSweFact } from "../domain/classify.ts";
import { loadEffectiveSweConfig, type EffectivePiSweConfig, type PiSweConfigDiagnostic } from "../config/index.ts";
import { evaluateSwePolicy, type SwePolicyResult } from "../domain/policy.ts";
import { createSweEvidenceService } from "./evidence.ts";
import { createSweStateService, type PiSweState } from "./state.ts";

export type PiSweRuntime = {
  capabilityWarnings: SweCapabilityWarning[];
  config: EffectivePiSweConfig;
  configDiagnostics: PiSweConfigDiagnostic[];
  configSource: string;
  detectedPeers: string[];
  externalCapabilities: SweCapabilityAdapter;
  state: PiSweState;
  todoEvidence: SweTodoEvidence[];
  todoScope?: SweTodoScope;
  warnings: SwePolicyResult[];
};

export const SWE_ADVISORY_WIDGET_KEY = "pi-swe-advisories";
export const PI_SWE_STATE_CUSTOM_TYPE = "gentic.swe.state";
export const PI_SWE_STATE_VERSION = 1 as const;

type PersistedSweState = Pick<PiSweState, "activePlan" | "activeStage">;
export type PiSweStateEnvelope = { version: typeof PI_SWE_STATE_VERSION; state: PersistedSweState };

const stateService = createSweStateService();
const evidenceService = createSweEvidenceService();

export function createRuntime(ctx?: ExtensionContext): PiSweRuntime {
  const loaded = loadEffectiveSweConfig({ cwd: ctx?.cwd });
  return {
    capabilityWarnings: [],
    config: loaded.config,
    configDiagnostics: loaded.diagnostics,
    configSource: describeConfigSource(loaded.paths),
    detectedPeers: [],
    externalCapabilities: createSweExternalCapabilities({ getCommands: () => [] } as unknown as ExtensionAPI),
    state: { ...stateService.createState() },
    todoEvidence: [],
    warnings: [],
  };
}

export function loadSessionRuntime(runtime: PiSweRuntime, pi: ExtensionAPI, ctx: ExtensionContext): void {
  const loaded = loadEffectiveSweConfig({ cwd: ctx.cwd });
  runtime.config = loaded.config;
  runtime.configDiagnostics = loaded.diagnostics;
  runtime.configSource = describeConfigSource(loaded.paths);
  runtime.externalCapabilities = createSweExternalCapabilities(pi);
  runtime.state = {
    ...stateService.createState({ turnStartedAt: new Date().toISOString() }),
    ...reconstructPersistedSweState(readActiveBranch(ctx)),
  };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function reloadBranchRuntime(runtime: PiSweRuntime, ctx: ExtensionContext): void {
  runtime.state = {
    ...stateService.createState({ turnStartedAt: new Date().toISOString() }),
    ...reconstructPersistedSweState(readActiveBranch(ctx)),
  };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function persistSessionRuntime(runtime: PiSweRuntime, pi: ExtensionAPI): void {
  const state: PersistedSweState = {};
  if (runtime.state.activePlan) state.activePlan = { ...runtime.state.activePlan };
  if (runtime.state.activeStage) state.activeStage = runtime.state.activeStage;
  if (!state.activePlan && !state.activeStage) return;
  const envelope: PiSweStateEnvelope = { version: PI_SWE_STATE_VERSION, state };
  pi.appendEntry(PI_SWE_STATE_CUSTOM_TYPE, envelope);
}

export function resetSessionRuntime(runtime: PiSweRuntime, ctx?: ExtensionContext): void {
  runtime.state = { ...stateService.createState() };
  runtime.todoEvidence = [];
  runtime.todoScope = undefined;
  runtime.warnings = [];
  runtime.capabilityWarnings = [];
  runtime.detectedPeers = [];
  renderAdvisoryWidget(ctx, []);
}

export function reconstructPersistedSweState(entries: readonly unknown[]): PersistedSweState {
  let reconstructed: PersistedSweState = {};
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PI_SWE_STATE_CUSTOM_TYPE) continue;
    const decoded = decodeSweStateEnvelope(entry.data);
    if (decoded) reconstructed = decoded;
  }
  return reconstructed;
}

export function decodeSweStateEnvelope(data: unknown): PersistedSweState | undefined {
  if (!isRecord(data) || data.version !== PI_SWE_STATE_VERSION || !isRecord(data.state)) return undefined;
  const state: PersistedSweState = {};
  if (isRecord(data.state.activePlan)) {
    const source = data.state.activePlan.source;
    const marker = data.state.activePlan.marker;
    if ((source === "todo" || source === "artifact" || source === "prompt") && typeof marker === "string" && marker.trim()) {
      state.activePlan = { source, marker: marker.trim() };
    }
  }
  const stage = data.state.activeStage;
  if (stage === "plan" || stage === "diagnose" || stage === "implement" || stage === "verify" || stage === "review" || stage === "finalize" || stage === "tdd" || stage === "dsa") state.activeStage = stage;
  return state;
}

export function resetTurnRuntime(runtime: PiSweRuntime, ctx?: ExtensionContext): void {
  runtime.state = { ...stateService.resetTurn(runtime.state, new Date().toISOString()) };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function applyFacts(runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  for (const fact of facts) {
    if (fact.kind === "inspection") runtime.state = { ...stateService.recordInspectedPath(runtime.state, fact.path) };
    else if (fact.kind === "code_change" && fact.path) runtime.state = { ...stateService.recordChangedPath(runtime.state, fact.path) };
    else if (fact.kind === "verification" && fact.exitCode !== undefined) runtime.state = { ...stateService.recordVerification(runtime.state, evidenceService.createCommandEvidence({ command: fact.command, exitCode: fact.exitCode, scope: fact.scope, timestamp: new Date().toISOString() })) };
  }
}

export function emitWarnings(ctx: ExtensionContext, runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  const result = evaluateSwePolicy({ config: runtime.config, state: policyState(runtime), facts });
  runtime.warnings = dedupeWarnings([...runtime.warnings, ...result.warnings]);
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function refreshPeerContext(runtime: PiSweRuntime): void {
  runtime.detectedPeers = runtime.externalCapabilities.listDetectedExtensions?.() ?? [];
  runtime.todoScope = runtime.externalCapabilities.getTodoScope?.();
  runtime.todoEvidence = runtime.externalCapabilities.getTodoEvidence?.() ?? [];

  const activeTodo = runtime.externalCapabilities.getActiveTodo?.();
  if (activeTodo) runtime.state = { ...stateService.setActivePlan(runtime.state, { source: "todo", marker: todoPlanMarker(activeTodo) }) };

  runtime.capabilityWarnings = runtime.externalCapabilities.getWarnings();
}

function policyState(runtime: PiSweRuntime): PiSweState {
  // Todo evidence remains visible evidence, but only a successful focused/broad
  // verification command can satisfy the verification policy.
  return runtime.state;
}

function todoPlanMarker(todo: SweExternalTodo): string {
  const label = [todo.id, todo.title].filter(Boolean).join(" ") || "active todo";
  const markers = [
    todo.acceptanceCriteria?.length ? `AC:${todo.acceptanceCriteria.length}` : undefined,
    todo.definitionOfDone?.length ? `DoD:${todo.definitionOfDone.length}` : undefined,
  ].filter(Boolean);
  return markers.length ? `${label} (${markers.join(", ")})` : label;
}

export function describeConfigSource(paths: { global: string; project: string }): string {
  return `${paths.project} (project), ${paths.global} (global), defaults`;
}

export function formatAdvisoryChips(ctx: ExtensionContext, warnings: readonly SwePolicyResult[]): string[] | undefined {
  if (warnings.length === 0) return undefined;

  const label = chip(ctx, ctx.ui.theme.fg("muted", "pi-swe"));
  const chips = warnings.map((warning) => chip(ctx, ctx.ui.theme.fg("warning", warning.code)));
  const hint = ctx.ui.theme.fg("dim", warnings.length === 1 ? warnings[0].nextAction : `${warnings.length} advisories`);
  return [[label, ...chips, hint].join(" ")];
}

function renderAdvisoryWidget(ctx: ExtensionContext | undefined, warnings: readonly SwePolicyResult[]): void {
  if (!ctx || typeof ctx.ui.setWidget !== "function") return;
  ctx.ui.setWidget(SWE_ADVISORY_WIDGET_KEY, formatAdvisoryChips(ctx, warnings), { placement: "belowEditor" });
}

function chip(ctx: ExtensionContext, text: string): string {
  return ctx.ui.theme.bg("customMessageBg", ` ${text} `);
}

function readActiveBranch(ctx: ExtensionContext): readonly unknown[] {
  const manager = ctx.sessionManager as unknown as { getBranch?: () => readonly unknown[] } | undefined;
  return manager?.getBranch?.() ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dedupeWarnings(warnings: SwePolicyResult[]): SwePolicyResult[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
