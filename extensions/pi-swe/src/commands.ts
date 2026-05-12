import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refreshPeerContext, type PiSweRuntime } from "./runtime.ts";

export function registerSweCommands(pi: ExtensionAPI, runtime: PiSweRuntime): void {
  pi.registerCommand("swe", {
    description: "Inspect pi-swe runtime status or config: /swe status | /swe config",
    getArgumentCompletions: (prefix) => ["status", "config"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] || "status";
      if (subcommand === "status") {
        refreshPeerContext(runtime);
        ctx.ui.notify(formatStatus(runtime), runtime.warnings.length || runtime.capabilityWarnings.length ? "warning" : "info");
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

export function formatStatus(runtime: PiSweRuntime): string {
  const state = runtime.state;
  const warnings = runtime.warnings.length ? runtime.warnings.map((warning) => `${warning.code}: ${warning.message}`).join("; ") : "none";
  const capabilityWarnings = runtime.capabilityWarnings.length ? runtime.capabilityWarnings.map((warning) => `${warning.source}: ${warning.message}`).join("; ") : "none";
  return [
    `pi-swe status`,
    `enabled: ${runtime.config.enabled && runtime.config.mode !== "off"}`,
    `mode: ${runtime.config.mode}`,
    `config source: ${runtime.configSource}`,
    `detected peers: ${runtime.detectedPeers.length ? runtime.detectedPeers.join(", ") : "none"}`,
    `active plan: ${state.activePlan ? `${state.activePlan.source}:${state.activePlan.marker}` : "none"}`,
    `todo scope: ${summarizeTodoScope(runtime.todoScope)}`,
    `inspected paths: ${state.inspectedPaths.length}`,
    `changed paths: ${state.changedPaths.length}`,
    `verification count: ${state.verification.length}`,
    `todo evidence count: ${runtime.todoEvidence.length}`,
    `current warnings: ${warnings}`,
    `capability warnings: ${capabilityWarnings}`,
  ].join("\n");
}

export function formatConfig(runtime: PiSweRuntime): string {
  const diagnostics = runtime.configDiagnostics.length ? `\ndiagnostics:\n${runtime.configDiagnostics.map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`).join("\n")}` : "";
  return `pi-swe config\nsource: ${runtime.configSource}\n${JSON.stringify(runtime.config, null, 2)}${diagnostics}`;
}

function summarizeTodoScope(scope: PiSweRuntime["todoScope"]): string {
  if (!scope) return "none";
  const entries = Object.entries(scope).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0));
  if (entries.length === 0) return "empty";
  return entries.map(([key, value]) => `${key}:${Array.isArray(value) ? value.join(",") : String(value)}`).join("; ");
}
