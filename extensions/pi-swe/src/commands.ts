import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { inspectOrchestrationArtifacts, recommendOrchestrationTransition } from "./orchestrate.ts";
import { refreshPeerContext, type PiSweRuntime } from "./runtime.ts";

export function registerSweCommands(pi: ExtensionAPI, runtime: PiSweRuntime): void {
  pi.registerCommand("swe", {
    description: "Inspect pi-swe runtime status, config, or orchestration guidance: /swe status | /swe config | /swe orchestrate",
    getArgumentCompletions: (prefix) => ["status", "config", "orchestrate"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
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
      if (subcommand === "orchestrate") {
        const action = args.trim().split(/\s+/, 2)[1] || "usage";
        ctx.ui.notify(formatOrchestrate(action, typeof ctx.cwd === "string" ? ctx.cwd : undefined), "info");
        return;
      }
      ctx.ui.notify("Usage: /swe status | /swe config | /swe orchestrate [status|start|resume|handoff]", "warning");
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

export function formatOrchestrate(action: string, cwd?: string): string {
  const normalizedAction = ["status", "start", "resume", "handoff"].includes(action) ? action : "usage";
  const topic = "autonomous-pi-swe-lifecycle";
  const inspection = cwd ? inspectOrchestrationArtifacts({ cwd, topic }) : undefined;
  const recommendation = recommendOrchestrationTransition({ path: normalizedAction === "handoff" ? "finalize" : "feature", artifacts: inspection?.artifacts ?? {} });
  const header = ["pi-swe orchestrate", "Usage: /swe orchestrate [status|start|resume|handoff]", `action: ${normalizedAction}`, "mode: guidance-only"];
  const readiness = inspection ? `${inspection.readiness}; missing: ${inspection.missingRequired.length ? inspection.missingRequired.join(", ") : "none"}` : "unknown; no cwd available";

  if (normalizedAction === "status" || normalizedAction === "usage") {
    return [
      ...header,
      `artifact readiness: ${readiness}`,
      `next recommended lifecycle step: ${recommendation.prompt ?? recommendation.stage} (${recommendation.reason}).`,
    ].join("\n");
  }

  if (normalizedAction === "start") {
    return [
      ...header,
      `next recommended lifecycle step: ${recommendation.prompt ?? recommendation.stage}`,
      `required artifact contract: ${recommendation.requiredArtifacts.length ? recommendation.requiredArtifacts.join(", ") : "none"}`,
      "allowed stages: swe-plan, swe-diagnose, swe-tdd, swe-dsa, swe-implement, swe-verify, swe-review, swe-finalize.",
    ].join("\n");
  }

  if (normalizedAction === "resume") {
    return [
      ...header,
      "resume from model artifacts: read stable artifacts under .model-artifacts before trusting chat memory.",
      `artifact readiness: ${readiness}`,
      `next recommended lifecycle step: ${recommendation.prompt ?? recommendation.stage}`,
    ].join("\n");
  }

  return [
    ...header,
    "exception handoff: stop hidden work and produce a deterministic handoff when orchestration cannot safely continue.",
    "next recommended lifecycle step: use swe-finalize only after verification/review gates pass; otherwise hand off the blocked reason and artifact path.",
  ].join("\n");
}

function summarizeTodoScope(scope: PiSweRuntime["todoScope"]): string {
  if (!scope) return "none";
  const entries = Object.entries(scope).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0));
  if (entries.length === 0) return "empty";
  return entries.map(([key, value]) => `${key}:${Array.isArray(value) ? value.join(",") : String(value)}`).join("; ");
}
