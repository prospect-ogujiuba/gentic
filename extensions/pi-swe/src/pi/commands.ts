import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refreshPeerContext, type PiSweRuntime } from "../app/runtime.ts";
import { completeCanonicalContract, type CompleteCanonicalContractRequest, type CompleteCanonicalContractResult } from "../completion.ts";
import { recommendGateAwareOrchestration, type GateAwareOrchestrationRecommendation } from "../orchestrate.ts";
import { resolveInitiative, type InitiativeResolution } from "../planning.ts";

const SUBCOMMANDS = ["status", "config", "orchestrate", "complete"] as const;
const ORCHESTRATE_ACTIONS = ["status", "start", "resume", "handoff"] as const;
const STATUS_USAGE = "Usage: /swe status [topic]";
const ORCHESTRATE_USAGE = "Usage: /swe orchestrate <status|start|resume|handoff> [topic]";
const COMPLETE_USAGE = "Usage: /swe complete <topic> <contract-id> <plan-revision> <contract-path> <contract-hash> <verification-path> <verification-hash> <review-path> <review-hash> approve [clear|advance]";
const MAX_SUMMARY_ITEMS = 8;

type OrchestrateAction = (typeof ORCHESTRATE_ACTIONS)[number];

export function registerSweCommands(pi: ExtensionAPI, runtime: PiSweRuntime): void {
  pi.registerCommand("swe", {
    description: "Inspect pi-swe status/guidance or explicitly complete an evidenced canonical contract",
    getArgumentCompletions: completeSweArgument,
    handler: async (args, ctx) => {
      const parsed = parseSweArguments(args);
      if (parsed.subcommand === "status") {
        refreshPeerContext(runtime);
        const resolution = resolveForCommand(runtime, typeof ctx.cwd === "string" ? ctx.cwd : undefined, parsed.topic);
        ctx.ui.notify(formatStatus(runtime, resolution), statusNotificationType(runtime, resolution));
        return;
      }
      if (parsed.subcommand === "config") {
        if (parsed.topic) {
          ctx.ui.notify(`${STATUS_USAGE}\n${ORCHESTRATE_USAGE}`, "warning");
          return;
        }
        ctx.ui.notify(formatConfig(runtime), runtime.configDiagnostics.length ? "warning" : "info");
        return;
      }
      if (parsed.subcommand === "orchestrate") {
        if (!parsed.action) {
          ctx.ui.notify(ORCHESTRATE_USAGE, "warning");
          return;
        }
        const resolution = resolveForCommand(runtime, typeof ctx.cwd === "string" ? ctx.cwd : undefined, parsed.topic);
        const recommendation = recommendGateAwareOrchestration({ resolution });
        ctx.ui.notify(formatOrchestrate(parsed.action, resolution, recommendation), orchestrationNotificationType(resolution, recommendation));
        return;
      }
      if (parsed.subcommand === "complete") {
        const cwd = typeof ctx.cwd === "string" ? ctx.cwd : undefined;
        const request = cwd ? parseCompleteRequest(cwd, parsed.completeTokens ?? []) : undefined;
        if (!request) {
          ctx.ui.notify(COMPLETE_USAGE, "warning");
          return;
        }
        const result = completeCanonicalContract(request);
        ctx.ui.notify(formatCompletion(result), result.status === "completed" || result.status === "already-complete" ? "info" : "warning");
        return;
      }
      ctx.ui.notify(`${STATUS_USAGE}\nUsage: /swe config\n${ORCHESTRATE_USAGE}\n${COMPLETE_USAGE}`, "warning");
    },
  });
}

export function formatStatus(runtime: PiSweRuntime, resolution?: InitiativeResolution): string {
  const state = runtime.state;
  const warnings = runtime.warnings.length ? runtime.warnings.map((warning) => `${warning.code}: ${warning.message}`).join("; ") : "none";
  const capabilityWarnings = runtime.capabilityWarnings.length ? runtime.capabilityWarnings.map((warning) => `${warning.source}: ${warning.message}`).join("; ") : "none";
  const canonical = resolution?.sourceMode === "canonical" ? resolution : undefined;
  const manifest = canonical?.inspection.manifest;
  const resolutionLines = resolution ? formatResolutionSummary(resolution) : ["source mode: unavailable", "initiative/topic: none", "next command: run from a repository cwd"];
  return [
    "pi-swe status",
    STATUS_USAGE,
    ...resolutionLines,
    `schema: ${manifest?.schemaVersion ?? "none"}`,
    `initiative state: ${manifest?.initiativeState ?? resolution?.status ?? "none"}`,
    `active spec: ${manifest ? `r${manifest.activeSpec.revision} ${manifest.activeSpec.path}` : "none"}`,
    `active plan: ${manifest?.activePlan ? `r${manifest.activePlan.revision} ${manifest.activePlan.path}` : state.activePlan ? `${state.activePlan.source}:${state.activePlan.marker}` : "none"}`,
    `approval decision: ${manifest && "approval" in manifest && manifest.approval ? manifest.approval.decision : "none"}`,
    `specialists: ${manifest ? summarizeSpecialists(manifest.specialists) : "none"}`,
    `gates: ${canonical ? bounded(canonical.inspection.gates.map((gate) => `${gate.id}:${gate.ready ? "ready" : "blocked"}`)) : "none"}`,
    `active contract: ${manifest && "activeContract" in manifest && manifest.activeContract ? `${manifest.activeContract.id} ${manifest.activeContract.path}` : "none"}`,
    `contract progress: ${canonical ? `${canonical.inspection.contracts.filter((contract) => contract.status === "complete").length}/${canonical.inspection.contracts.length} complete` : "none"}`,
    `ready contracts: ${canonical ? bounded(canonical.inspection.readyIds) : "none"}`,
    `blockers: ${canonical ? bounded(canonical.inspection.blockers.map((blocker) => `${blocker.code}: ${blocker.remediation}`)) : "none"}`,
    `todo linkage: ${canonical?.todoLink ? summarizeRecord(canonical.todoLink) : "none"}`,
    `enabled: ${runtime.config.enabled && runtime.config.mode !== "off"}`,
    `mode: ${runtime.config.mode}`,
    `config source: ${runtime.configSource}`,
    `detected peers: ${runtime.detectedPeers.length ? runtime.detectedPeers.join(", ") : "none"}`,
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

export function formatOrchestrate(action: OrchestrateAction, resolution: InitiativeResolution, recommendation: GateAwareOrchestrationRecommendation): string {
  const readiness = resolution.sourceMode === "canonical"
    ? resolution.inspection.diagnostics.length ? "invalid" : resolution.inspection.blockers.length ? "blocked" : "ready"
    : resolution.status;
  const next = recommendation.skill ? `/skill:${recommendation.skill} (${recommendation.stage})` : recommendation.stage;
  return [
    "pi-swe orchestrate",
    ORCHESTRATE_USAGE,
    `action: ${action}`,
    "mode: guidance-only",
    ...formatResolutionSummary(resolution),
    `readiness: ${readiness}`,
    `artifact readiness: ${readiness}`,
    `next skill/stage: ${next}`,
    `next recommended lifecycle step: ${next}`,
    `reason: ${recommendation.reason}`,
    `required read paths: ${bounded(recommendation.requiredReadPaths)}`,
    `intended write path: ${recommendation.intendedWriteArtifact ?? "none"}`,
    `active contract: ${recommendation.activeContract ? `${recommendation.activeContract.id} ${recommendation.activeContract.path}` : "none"}`,
    `ready contracts: ${recommendation.readyContracts ? bounded([recommendation.readyContracts.selected, ...recommendation.readyContracts.others]) : "none"}`,
    `blockers: ${bounded(recommendation.blockingReasons)}`,
    ...(action === "resume" ? ["resume from model artifacts: read required paths before trusting chat memory."] : []),
    ...(action === "handoff" ? ["handoff guidance: stop hidden work and report the bounded exception evidence."] : []),
    `exception handoff: ${recommendation.stage === "blocked-handoff" || action === "handoff" ? bounded(recommendation.blockingReasons) : "none"}`,
  ].join("\n");
}

function completeSweArgument(prefix: string): Array<{ value: string; label: string }> {
  const normalized = prefix.trimStart();
  const actionMatch = normalized.match(/^orchestrate\s+(\S*)$/);
  if (actionMatch) {
    return ORCHESTRATE_ACTIONS.filter((action) => action.startsWith(actionMatch[1] ?? "")).map((action) => ({ value: `orchestrate ${action}`, label: action }));
  }
  if (/^orchestrate\s+\S+\s+/.test(normalized) || /^status\s+/.test(normalized) || /^complete\s+/.test(normalized)) return [];
  return SUBCOMMANDS.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
}

function parseSweArguments(args: string): { subcommand?: string; action?: OrchestrateAction; topic?: string; completeTokens?: string[] } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0] ?? "status";
  if (subcommand === "status") return { subcommand, topic: tokens.slice(1).join(" ") || undefined };
  if (subcommand === "config") return { subcommand, topic: tokens.slice(1).join(" ") || undefined };
  if (subcommand === "complete") return { subcommand, completeTokens: tokens.slice(1) };
  if (subcommand !== "orchestrate") return { subcommand };
  const actionToken = tokens[1];
  const action = actionToken === undefined ? "status" : ORCHESTRATE_ACTIONS.find((candidate) => candidate === actionToken);
  return { subcommand, action, topic: action ? tokens.slice(actionToken === undefined ? 1 : 2).join(" ") || undefined : undefined };
}

function parseCompleteRequest(cwd: string, tokens: readonly string[]): CompleteCanonicalContractRequest | undefined {
  if (tokens.length < 10 || tokens.length > 11) return undefined;
  const [topic, contractId, revisionText, contractPath, contractHash, verificationPath, verificationHash, reviewPath, reviewHash, decision, next = "advance"] = tokens;
  const expectedPlanRevision = Number(revisionText);
  if (!topic || !contractId || !contractPath || !contractHash || !verificationPath || !verificationHash || !reviewPath || !reviewHash
    || decision !== "approve" || (next !== "clear" && next !== "advance") || !Number.isSafeInteger(expectedPlanRevision)) return undefined;
  return {
    cwd,
    topic,
    contractId,
    expectedPlanRevision,
    expectedContractPath: contractPath,
    expectedPreCompletionContentHash: contractHash,
    verification: { path: verificationPath, contentHash: verificationHash },
    review: { path: reviewPath, contentHash: reviewHash, decision },
    nextActiveContract: next,
  };
}

export function formatCompletion(result: CompleteCanonicalContractResult): string {
  if (result.status === "completed") {
    return [
      "pi-swe completion",
      `status: ${result.status}`,
      `contract: ${result.contractId}`,
      `request: ${result.requestId}`,
      `phase progress: ${result.phaseProgress}`,
      `active contract: ${result.activeContractId ?? "none"}`,
      `ready contracts: ${bounded(result.readyContractIds)}`,
      "next skill/stage: /skill:swe-orchestrate",
    ].join("\n");
  }
  if (result.status === "already-complete") {
    return [
      "pi-swe completion",
      `status: ${result.status}`,
      `contract: ${result.contractId}`,
      `request: ${result.requestId}`,
      `recorded next contracts: ${bounded(result.recordedNextState.readyContractIds)}`,
      `current active contract: ${result.currentActiveContractId ?? "none"}`,
      `current ready contracts: ${bounded(result.currentReadyContractIds)}`,
    ].join("\n");
  }
  return [
    "pi-swe completion",
    `status: ${result.status}`,
    `contract: ${result.contractId ?? "none"}`,
    `reason: ${result.message}`,
    `recovery artifact: ${result.artifact ?? "none"}`,
  ].join("\n");
}

function resolveForCommand(runtime: PiSweRuntime, cwd: string | undefined, explicitTopic: string | undefined): InitiativeResolution {
  if (!cwd) return { sourceMode: "resolution", status: "not-found", candidateTopics: [], remediation: "run the command from a repository cwd", warnings: [] };
  return resolveInitiative({
    cwd,
    explicitTopic,
    persistedTopic: explicitTopic ? undefined : runtime.state.activeInitiative?.topic,
    activeTodo: runtime.externalCapabilities.getActiveTodo?.(),
  });
}

function formatResolutionSummary(resolution: InitiativeResolution): string[] {
  if (resolution.sourceMode === "canonical") {
    return [
      "source mode: canonical",
      `initiative/topic: ${resolution.topic}`,
      `selection: ${resolution.selectionSource}`,
      `candidates: ${bounded(resolution.candidateTopics)}`,
      ...(resolution.warnings.length ? [`resolution warnings: ${bounded(resolution.warnings)}`] : []),
    ];
  }
  if (resolution.sourceMode === "legacy") {
    return [
      "source mode: legacy",
      `initiative/topic: ${resolution.topic}`,
      `candidates: ${bounded(resolution.candidateTopics)}`,
      `legacy plan: ${resolution.status === "legacy-unverified" ? resolution.planPath : "none"}`,
      `next command: /swe orchestrate resume ${resolution.topic} after canonical adoption`,
    ];
  }
  return [
    `source mode: ${resolution.status}`,
    "initiative/topic: none",
    `candidates: ${bounded(resolution.candidateTopics)}`,
    `reason: ${resolution.remediation}`,
    `next command: ${resolution.status === "ambiguous" ? "/swe status <topic>" : "/skill:swe-plan"}`,
  ];
}

function statusNotificationType(runtime: PiSweRuntime, resolution: InitiativeResolution | undefined): "info" | "warning" {
  if (!resolution || resolution.sourceMode !== "canonical") return "warning";
  const isBlocking = resolution.inspection.manifest?.initiativeState === "blocked"
    || (resolution.inspection.readyIds.length === 0 && resolution.inspection.blockers.length > 0);
  if (resolution.inspection.diagnostics.length || isBlocking || runtime.warnings.length) return "warning";
  return "info";
}

function orchestrationNotificationType(resolution: InitiativeResolution, recommendation: GateAwareOrchestrationRecommendation): "info" | "warning" {
  return resolution.sourceMode === "canonical" && recommendation.stage !== "blocked-handoff" ? "info" : "warning";
}

function summarizeSpecialists(specialists: Readonly<Record<string, { status: string }>>): string {
  return bounded(Object.entries(specialists).sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => `${id}:${entry.status}`));
}

function bounded(items: readonly string[]): string {
  if (!items.length) return "none";
  const visible = items.slice(0, MAX_SUMMARY_ITEMS);
  return `${visible.join(", ")}${items.length > visible.length ? `, +${items.length - visible.length} more` : ""}`;
}

function summarizeRecord(value: Record<string, unknown>): string {
  return bounded(Object.entries(value).map(([key, item]) => `${key}:${Array.isArray(item) ? item.join(",") : String(item)}`));
}

function summarizeTodoScope(scope: PiSweRuntime["todoScope"]): string {
  if (!scope) return "none";
  const entries = Object.entries(scope).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0));
  if (entries.length === 0) return "empty";
  return bounded(entries.map(([key, value]) => `${key}:${Array.isArray(value) ? value.join(",") : String(value)}`));
}
