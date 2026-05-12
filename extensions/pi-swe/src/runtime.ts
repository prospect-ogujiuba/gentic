import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSweExternalCapabilities, type SweCapabilityAdapter, type SweCapabilityWarning, type SweExternalTodo, type SweTodoEvidence, type SweTodoScope } from "./capabilities.ts";
import type { PiSweFact } from "./classify.ts";
import { loadEffectiveSweConfig, type EffectivePiSweConfig, type PiSweConfigDiagnostic } from "./config.ts";
import { createVerificationEvidence } from "./evidence.ts";
import { evaluateSwePolicy, type SwePolicyResult } from "./policy.ts";
import { createSweState, recordChangedPath, recordInspectedPath, recordVerification, resetTurnState, setActivePlan, type PiSweState } from "./state.ts";

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

export function createRuntime(ctx?: ExtensionContext): PiSweRuntime {
  const loaded = loadEffectiveSweConfig({ cwd: ctx?.cwd });
  return {
    capabilityWarnings: [],
    config: loaded.config,
    configDiagnostics: loaded.diagnostics,
    configSource: describeConfigSource(loaded.paths),
    detectedPeers: [],
    externalCapabilities: createSweExternalCapabilities({ getCommands: () => [] } as unknown as ExtensionAPI),
    state: { ...createSweState() },
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
  runtime.state = { ...createSweState({ turnStartedAt: new Date().toISOString() }) };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function resetTurnRuntime(runtime: PiSweRuntime, ctx?: ExtensionContext): void {
  runtime.state = { ...resetTurnState(runtime.state, new Date().toISOString()) };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function applyFacts(runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  for (const fact of facts) {
    if (fact.kind === "inspection") runtime.state = { ...recordInspectedPath(runtime.state, fact.path) };
    else if (fact.kind === "code_change" && fact.path) runtime.state = { ...recordChangedPath(runtime.state, fact.path) };
    else if (fact.kind === "verification") runtime.state = { ...recordVerification(runtime.state, createVerificationEvidence({ kind: "command", command: fact.command, exitCode: fact.exitCode, scope: fact.scope, timestamp: new Date().toISOString() })) };
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
  if (activeTodo) runtime.state = { ...setActivePlan(runtime.state, { source: "todo", marker: todoPlanMarker(activeTodo) }) };

  runtime.capabilityWarnings = runtime.externalCapabilities.getWarnings();
}

function policyState(runtime: PiSweRuntime): PiSweState {
  if (runtime.state.verification.length || runtime.todoEvidence.length === 0) return runtime.state;
  return {
    ...runtime.state,
    verification: [createVerificationEvidence({ kind: "note", note: `todo evidence available (${runtime.todoEvidence.length})`, scope: "manual" })],
  };
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

function dedupeWarnings(warnings: SwePolicyResult[]): SwePolicyResult[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
