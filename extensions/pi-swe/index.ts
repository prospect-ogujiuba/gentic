import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { classifyToolCall, classifyToolResult, type PiSweFact } from "./src/classify.ts";
import { loadEffectiveSweConfig, type EffectivePiSweConfig, type PiSweConfigDiagnostic } from "./src/config.ts";
import { createVerificationEvidence } from "./src/evidence.ts";
import { evaluateSwePolicy, type SwePolicyResult } from "./src/policy.ts";
import { createSweState, recordChangedPath, recordInspectedPath, recordVerification, resetTurnState, type PiSweState } from "./src/state.ts";

export const PI_SWE_EXTENSION_ID = "pi-swe";
export const PI_SWE_EXTENSION_NAME = "Pi SWE";

export type PiSweExtensionMetadata = {
  id: typeof PI_SWE_EXTENSION_ID;
  name: typeof PI_SWE_EXTENSION_NAME;
  description: string;
};

export const metadata: PiSweExtensionMetadata = {
  id: PI_SWE_EXTENSION_ID,
  name: PI_SWE_EXTENSION_NAME,
  description: "Runtime SWE workflow guidance for planning, inspection, scope, and verification.",
};

type PiSweRuntime = {
  config: EffectivePiSweConfig;
  configDiagnostics: PiSweConfigDiagnostic[];
  configSource: string;
  detectedPeers: string[];
  state: PiSweState;
  warnings: SwePolicyResult[];
};

export default function piSwe(pi: ExtensionAPI, initialCtx?: ExtensionContext): void {
  const runtime = createRuntime(initialCtx);

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadEffectiveSweConfig({ cwd: ctx.cwd });
    runtime.config = loaded.config;
    runtime.configDiagnostics = loaded.diagnostics;
    runtime.configSource = describeConfigSource(loaded.paths);
    runtime.detectedPeers = detectPeers(pi);
    runtime.state = { ...createSweState({ turnStartedAt: new Date().toISOString() }) };
    runtime.warnings = [];
  });

  pi.on("turn_start", () => {
    runtime.state = { ...resetTurnState(runtime.state, new Date().toISOString()) };
    runtime.warnings = [];
  });

  pi.on("tool_call", (event, ctx) => {
    const facts = classifyToolCall({ toolName: event.toolName, input: event.input });
    applyFacts(runtime, facts);
    emitWarnings(ctx, runtime, facts);
  });

  pi.on("tool_result", (event, ctx) => {
    const facts = classifyToolResult({ toolName: event.toolName, input: event.input, result: { exitCode: detailNumber(event.details, "exitCode") ?? detailNumber(event.details, "code") ?? (event.isError ? 1 : 0) } });
    applyFacts(runtime, facts);
    emitWarnings(ctx, runtime, facts);
  });

  pi.registerCommand("swe", {
    description: "Inspect pi-swe runtime status or config: /swe status | /swe config",
    getArgumentCompletions: (prefix) => ["status", "config"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] || "status";
      if (subcommand === "status") {
        ctx.ui.notify(formatStatus(runtime), runtime.warnings.length ? "warning" : "info");
        return;
      }
      if (subcommand === "config") {
        ctx.ui.notify(formatConfig(runtime), runtime.configDiagnostics.length ? "warning" : "info");
        return;
      }
      ctx.ui.notify("Usage: /swe status | /swe config", "warning");
    },
  });
}

function createRuntime(ctx?: ExtensionContext): PiSweRuntime {
  const loaded = loadEffectiveSweConfig({ cwd: ctx?.cwd });
  return {
    config: loaded.config,
    configDiagnostics: loaded.diagnostics,
    configSource: describeConfigSource(loaded.paths),
    detectedPeers: [],
    state: { ...createSweState() },
    warnings: [],
  };
}

function applyFacts(runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  for (const fact of facts) {
    if (fact.kind === "inspection") runtime.state = { ...recordInspectedPath(runtime.state, fact.path) };
    else if (fact.kind === "code_change" && fact.path) runtime.state = { ...recordChangedPath(runtime.state, fact.path) };
    else if (fact.kind === "verification") runtime.state = { ...recordVerification(runtime.state, createVerificationEvidence({ kind: "command", command: fact.command, exitCode: fact.exitCode, scope: fact.scope, timestamp: new Date().toISOString() })) };
  }
}

function emitWarnings(ctx: ExtensionContext, runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  const result = evaluateSwePolicy({ config: runtime.config, state: runtime.state, facts });
  runtime.warnings = dedupeWarnings([...runtime.warnings, ...result.warnings]);
  for (const warning of result.warnings) ctx.ui.notify(`[pi-swe:${warning.code}] ${warning.message} ${warning.nextAction}`, "warning");
}

function formatStatus(runtime: PiSweRuntime): string {
  const state = runtime.state;
  const warnings = runtime.warnings.length ? runtime.warnings.map((warning) => `${warning.code}: ${warning.message}`).join("; ") : "none";
  return [
    `pi-swe status`,
    `enabled: ${runtime.config.enabled && runtime.config.mode !== "off"}`,
    `mode: ${runtime.config.mode}`,
    `config source: ${runtime.configSource}`,
    `detected peers: ${runtime.detectedPeers.length ? runtime.detectedPeers.join(", ") : "none"}`,
    `active plan: ${state.activePlan ? `${state.activePlan.source}:${state.activePlan.marker}` : "none"}`,
    `inspected paths: ${state.inspectedPaths.length}`,
    `changed paths: ${state.changedPaths.length}`,
    `verification count: ${state.verification.length}`,
    `current warnings: ${warnings}`,
  ].join("\n");
}

function formatConfig(runtime: PiSweRuntime): string {
  const diagnostics = runtime.configDiagnostics.length ? `\ndiagnostics:\n${runtime.configDiagnostics.map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`).join("\n")}` : "";
  return `pi-swe config\nsource: ${runtime.configSource}\n${JSON.stringify(runtime.config, null, 2)}${diagnostics}`;
}

function detectPeers(pi: ExtensionAPI): string[] {
  const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
  const names = new Set(commands.map((command) => command.name));
  return [names.has("todo") ? "pi-todo" : undefined, names.has("gate") ? "pi-gate" : undefined].filter((value): value is string => !!value);
}

function describeConfigSource(paths: { global: string; project: string }): string {
  return `${paths.project} (project), ${paths.global} (global), defaults`;
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

function detailNumber(details: unknown, key: string): number | undefined {
  return details && typeof details === "object" && typeof (details as Record<string, unknown>)[key] === "number" ? (details as Record<string, number>)[key] : undefined;
}
