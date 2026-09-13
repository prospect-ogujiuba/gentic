import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  pausePersistedPiSweRunner,
  persistPiSweRunnerState,
  readPiSweRunnerState,
  replaceResumablePiSweRunnerState,
  replaceTerminalPiSweRunnerState,
  stopPersistedPiSweRunner,
} from "../app/runner-persistence.ts";
import { refreshPeerContext, type PiSweRuntime } from "../app/runtime.ts";
import { completeCanonicalContract, type CompleteCanonicalContractRequest, type CompleteCanonicalContractResult } from "../completion.ts";
import { createPiSweRunner, type PiSweRunnerIdentity, type PiSweRunnerMode, type PiSweRunnerPolicy, type PiSweRunnerUntil } from "../domain/runner.ts";
import { recommendGateAwareOrchestration, type GateAwareOrchestrationRecommendation } from "../orchestrate.ts";
import { resolveInitiative, type InitiativeResolution } from "../planning.ts";
import { settleOwnedPiSweRunners } from "./work-runner.ts";

const ORCHESTRATE_ACTIONS = ["status", "start", "resume", "handoff"] as const;
const WORK_ACTIONS = ["status", "start", "resume", "pause", "stop"] as const;
const SUBCOMMAND_COMPLETIONS = [
  { value: "status", label: "status", description: "Show canonical initiative, contract, gate, and runtime status · /swe status [topic]" },
  { value: "config", label: "config", description: "Show effective pi-swe configuration and diagnostics · /swe config" },
  { value: "orchestrate", label: "orchestrate", description: "Recommend one lifecycle stage without hidden execution · /swe orchestrate <action> [topic]" },
  { value: "work", label: "work", description: "Control the owner-bound guided work runner · /swe work <action> [topic] [options]" },
  { value: "complete", label: "complete", description: "Low-level guarded canonical disposition/recovery · /swe complete <exact evidence identity...>" },
] as const;
const ORCHESTRATE_COMPLETIONS = [
  { value: "status", label: "status", description: "Report the next lifecycle recommendation · /swe orchestrate status [topic]" },
  { value: "start", label: "start", description: "Recommend the first approved dependency-ready stage · /swe orchestrate start [topic]" },
  { value: "resume", label: "resume", description: "Recommend a durable artifact-based resume stage · /swe orchestrate resume [topic]" },
  { value: "handoff", label: "handoff", description: "Emit a bounded exception handoff · /swe orchestrate handoff [topic]" },
] as const;
const WORK_COMPLETIONS = [
  { value: "status", label: "status", description: "Inspect persisted runner state without mutation · /swe work status [topic]" },
  { value: "start", label: "start", description: "Start an approved owner-bound run · /swe work start [topic] [options]" },
  { value: "resume", label: "resume", description: "Resume or take over a resumable run · /swe work resume [topic]" },
  { value: "pause", label: "pause", description: "Pause before the next continuation · /swe work pause [topic]" },
  { value: "stop", label: "stop", description: "Stop the run; a stopped run cannot resume · /swe work stop [topic]" },
] as const;
const STATUS_USAGE = "Usage: /swe status [topic]";
const ORCHESTRATE_USAGE = "Usage: /swe orchestrate <status|start|resume|handoff> [topic]";
const WORK_USAGE = "Usage: /swe work <status|start|resume|pause|stop> [topic] [--mode guided|autonomous] [--until contract|context|initiative] [--max-turns 1..100] [--max-minutes 1..1440]";
const COMPLETE_USAGE = "Usage: /swe complete <topic> <contract-id> <plan-revision> <contract-path> <contract-hash> <verification-path> <verification-hash> <review-path> <review-hash> approve [clear|advance]";
const MAX_SUMMARY_ITEMS = 8;

type OrchestrateAction = (typeof ORCHESTRATE_ACTIONS)[number];

export function registerSweCommands(pi: ExtensionAPI, runtime: PiSweRuntime): void {
  pi.registerCommand("swe", {
    description: "/swe <status [topic]|config|orchestrate <status|start|resume|handoff> [topic]|work <status|start|resume|pause|stop> [topic] ...|complete ...> — manage canonical SWE workflows",
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
      if (parsed.subcommand === "work") {
        const workTokens = parsed.workTokens ?? [];
        const result = handleSweWork(runtime, workTokens, ctx);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        if (result.ok && (workTokens[0] === "start" || workTokens[0] === "resume")
          && typeof (ctx as { sessionManager?: { getSessionId?: unknown } }).sessionManager?.getSessionId === "function"
          && typeof pi.sendUserMessage === "function") {
          await settleOwnedPiSweRunners(pi, ctx);
        }
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
      ctx.ui.notify(`${STATUS_USAGE}\nUsage: /swe config\n${ORCHESTRATE_USAGE}\n${WORK_USAGE}\n${COMPLETE_USAGE}`, "warning");
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

type SweCompletion = { value: string; label: string; description: string };

function completeWithPrefix(base: readonly string[], value: string, label: string, description: string): SweCompletion {
  return { value: [...base, value].join(" "), label, description };
}

export function completeSweArgument(prefix: string): SweCompletion[] {
  const normalized = prefix.trimStart();
  const trailingSpace = /\s$/.test(normalized);
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const query = tokens[0] ?? "";
    return SUBCOMMAND_COMPLETIONS.filter((item) => item.value.startsWith(query)).map((item) => ({ ...item }));
  }

  const subcommand = tokens[0];
  if (subcommand === "orchestrate") {
    if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
      const query = trailingSpace ? "" : tokens[1] ?? "";
      return ORCHESTRATE_COMPLETIONS.filter((item) => item.value.startsWith(query)).map((item) =>
        completeWithPrefix(["orchestrate"], item.value, item.label, item.description));
    }
    return [];
  }

  if (subcommand === "work") {
    if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
      const query = trailingSpace ? "" : tokens[1] ?? "";
      return WORK_COMPLETIONS.filter((item) => item.value.startsWith(query)).map((item) =>
        completeWithPrefix(["work"], item.value, item.label, item.description));
    }
    if (tokens[1] !== "start") return [];
    const current = trailingSpace ? "" : tokens.at(-1) ?? "";
    const completed = trailingSpace ? tokens : tokens.slice(0, -1);
    const previous = completed.at(-1);
    const valueSuggestions = previous === "--mode"
      ? [
          { value: "guided", description: "Checkpoint-driven mode with operator control (default)" },
          { value: "autonomous", description: "Explicit autonomous opt-in; all safety and evidence gates remain" },
        ]
      : previous === "--until"
        ? [
            { value: "contract", description: "Stop after the selected contract is disposed" },
            { value: "context", description: "Continue through contracts until context pressure is critical (default)" },
            { value: "initiative", description: "Continue serially through ready contracts and finalization" },
          ]
        : previous === "--max-turns"
          ? [{ value: "12", description: "Maximum runner turns; valid range 1..100" }]
          : previous === "--max-minutes"
            ? [{ value: "30", description: "Maximum elapsed minutes; valid range 1..1440" }]
            : undefined;
    if (valueSuggestions) {
      return valueSuggestions.filter((item) => item.value.startsWith(current)).map((item) =>
        completeWithPrefix(completed, item.value, item.value, item.description));
    }
    if (current && !current.startsWith("-")) return [];
    const options = [
      { value: "--mode", description: "Execution mode · --mode <guided|autonomous>" },
      { value: "--until", description: "Stopping scope · --until <contract|context|initiative>" },
      { value: "--max-turns", description: "Turn budget · --max-turns <1..100>" },
      { value: "--max-minutes", description: "Elapsed-time budget · --max-minutes <1..1440>" },
    ];
    return options
      .filter((item) => !completed.includes(item.value) && item.value.startsWith(current))
      .map((item) => completeWithPrefix(completed, item.value, item.value, item.description));
  }

  if (subcommand === "complete") {
    const current = trailingSpace ? "" : tokens.at(-1) ?? "";
    const completed = trailingSpace ? tokens : tokens.slice(0, -1);
    if (completed.length === 10) {
      return "approve".startsWith(current)
        ? [completeWithPrefix(completed, "approve", "approve", "Confirm the review decision required by guarded completion")]
        : [];
    }
    if (completed.length === 11 && completed.at(-1) === "approve") {
      return [
        { value: "clear", description: "Clear activeContract after completion" },
        { value: "advance", description: "Advance to the next dependency-ready contract (default)" },
      ].filter((item) => item.value.startsWith(current)).map((item) => completeWithPrefix(completed, item.value, item.value, item.description));
    }
  }

  return [];
}

function parseSweArguments(args: string): { subcommand?: string; action?: OrchestrateAction; topic?: string; completeTokens?: string[]; workTokens?: string[] } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0] ?? "status";
  if (subcommand === "status") return { subcommand, topic: tokens.slice(1).join(" ") || undefined };
  if (subcommand === "config") return { subcommand, topic: tokens.slice(1).join(" ") || undefined };
  if (subcommand === "complete") return { subcommand, completeTokens: tokens.slice(1) };
  if (subcommand === "work") return { subcommand, workTokens: tokens.slice(1) };
  if (subcommand !== "orchestrate") return { subcommand };
  const actionToken = tokens[1];
  const action = actionToken === undefined ? "status" : ORCHESTRATE_ACTIONS.find((candidate) => candidate === actionToken);
  return { subcommand, action, topic: action ? tokens.slice(actionToken === undefined ? 1 : 2).join(" ") || undefined : undefined };
}

type SweWorkAction = (typeof WORK_ACTIONS)[number];
type SweWorkRequest = {
  action: SweWorkAction;
  topic?: string;
  mode: PiSweRunnerMode;
  until: PiSweRunnerUntil;
  policy: PiSweRunnerPolicy;
};
type SweWorkContext = { cwd?: string; sessionId?: string; sessionManager?: { getSessionId(): string }; isIdle?: () => boolean };

function handleSweWork(runtime: PiSweRuntime, tokens: readonly string[], ctx: SweWorkContext): { ok: boolean; message: string } {
  const parsed = parseSweWorkArguments(tokens, runtime.config.runner);
  if ("error" in parsed) return { ok: false, message: `${WORK_USAGE}\nreason: ${parsed.error}` };
  if (!ctx.cwd) return { ok: false, message: `${WORK_USAGE}\nreason: run from a repository cwd` };

  const operatorOnly = parsed.action === "status" || parsed.action === "pause" || parsed.action === "stop";
  let resolution: InitiativeResolution | undefined;
  let topic = operatorOnly ? parsed.topic : undefined;
  if (!topic) {
    resolution = resolveForCommand(runtime, ctx.cwd, parsed.topic);
    if (resolution.sourceMode !== "canonical") {
      return { ok: false, message: `${WORK_USAGE}\n${formatResolutionSummary(resolution).join("\n")}` };
    }
    topic = resolution.topic;
  }
  if (parsed.action === "status") return formatSweWorkState(ctx.cwd, topic);

  const sessionId = ctx.sessionManager?.getSessionId() ?? ctx.sessionId;
  const ownerToken = typeof sessionId === "string" && sessionId.trim() === sessionId && sessionId.length <= 256 ? sessionId : undefined;
  if (!ownerToken) return { ok: false, message: `${WORK_USAGE}\nreason: a bounded session owner identity is required` };
  if ((parsed.action === "start" || parsed.action === "resume") && ctx.isIdle?.() !== true) {
    return { ok: false, message: `${WORK_USAGE}\nreason: start and resume require an idle Pi session` };
  }

  const current = readPiSweRunnerState(ctx.cwd, topic);
  if (current.diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, current.diagnostics) };
  if (parsed.action === "pause" || parsed.action === "stop") {
    if (!current.snapshot) return { ok: false, message: `pi-swe work\ntopic: ${topic}\nstatus: inactive\nreason: no persisted runner exists` };
    if (current.snapshot.ownerToken !== ownerToken) return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: runner is owned by ${current.snapshot.ownerToken}` };
    const diagnostics = parsed.action === "pause"
      ? pausePersistedPiSweRunner(ctx.cwd, topic, ownerToken)
      : stopPersistedPiSweRunner(ctx.cwd, topic, ownerToken);
    if (diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, diagnostics) };
    return formatSweWorkState(ctx.cwd, topic);
  }

  if (!resolution || resolution.sourceMode !== "canonical") {
    return { ok: false, message: `${WORK_USAGE}\nreason: start and resume require fresh canonical authority` };
  }
  const recommendation = recommendGateAwareOrchestration({ resolution });
  if (recommendation.stage === "blocked-handoff") {
    return { ok: false, message: `pi-swe work\ntopic: ${topic}\nstatus: blocked\nreason: ${recommendation.reason}\nblockers: ${bounded(recommendation.blockingReasons)}` };
  }
  const identity = canonicalRunnerIdentity(resolution, recommendation.activeContract);
  if (!identity) return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: exact approved selected contract identity is unavailable` };

  if (parsed.action === "start") {
    if (current.snapshot && current.snapshot.runner.status !== "stopped" && current.snapshot.runner.status !== "complete") {
      return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: runner ${current.snapshot.runner.runId} is already ${current.snapshot.runner.status}` };
    }
    const runner = createPiSweRunner({
      runId: `${ownerToken}:${Date.now()}`,
      mode: parsed.mode,
      until: parsed.until,
      identity,
      policy: parsed.policy,
      startedAtMs: Date.now(),
    });
    const diagnostics = replaceTerminalPiSweRunnerState(ctx.cwd, { topic, ownerToken, runner });
    if (diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, diagnostics) };
    return formatSweWorkState(ctx.cwd, topic);
  }

  if (!current.snapshot) return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: no persisted runner exists to resume` };
  const previous = current.snapshot.runner;
  if (previous.status === "stopped" || previous.status === "complete") {
    return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: ${previous.status} runner cannot resume; start a new run` };
  }
  const exhaustedLegacyBudget = previous.terminalReason === "turn-budget-exhausted"
    || previous.terminalReason === "time-budget-exhausted";
  if (!exhaustedLegacyBudget && !sameRunnerIdentity(previous.identity, identity)) {
    return { ok: false, message: `pi-swe work\ntopic: ${topic}\nreason: persisted runner identity is stale` };
  }
  if (current.snapshot.ownerToken !== ownerToken || exhaustedLegacyBudget) {
    const startedAtMs = Date.now();
    const runner = createPiSweRunner({
      runId: `${ownerToken}:${startedAtMs}`,
      mode: previous.mode,
      until: exhaustedLegacyBudget ? parsed.until : previous.until,
      identity,
      policy: exhaustedLegacyBudget ? parsed.policy : previous.policy,
      startedAtMs,
    });
    const diagnostics = replaceResumablePiSweRunnerState(ctx.cwd, { topic, ownerToken, runner });
    if (diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, diagnostics) };
    return formatSweWorkState(ctx.cwd, topic);
  }
  if (previous.status === "running") return formatSweWorkState(ctx.cwd, topic);
  const runner = { ...previous, status: "running" as const, terminalReason: undefined };
  const diagnostics = persistPiSweRunnerState(ctx.cwd, { topic, ownerToken, runner });
  if (diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, diagnostics) };
  return formatSweWorkState(ctx.cwd, topic);
}

function parseSweWorkArguments(
  tokens: readonly string[],
  defaults: PiSweRuntime["config"]["runner"],
): SweWorkRequest | { error: string } {
  const action = WORK_ACTIONS.find((candidate) => candidate === tokens[0]);
  if (!action) return { error: "a valid work action is required" };
  let topic: string | undefined;
  let mode: PiSweRunnerMode = "guided";
  let until: PiSweRunnerUntil = "context";
  let maxTurns = defaults.maxTurns;
  let maxMinutes = defaults.maxMinutes;
  const seen = new Set<string>();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      if (topic) return { error: "only one exact topic may be selected" };
      topic = token;
      continue;
    }
    if (!["--mode", "--until", "--max-turns", "--max-minutes"].includes(token)) return { error: `unknown option ${token}` };
    if (seen.has(token)) return { error: `duplicate option ${token}` };
    seen.add(token);
    const value = tokens[++index];
    if (!value || value.startsWith("--")) return { error: `missing value for ${token}` };
    if (token === "--mode") {
      if (value !== "guided" && value !== "autonomous") return { error: "mode must be guided or autonomous" };
      mode = value;
    } else if (token === "--until") {
      if (value !== "contract" && value !== "context" && value !== "initiative") return { error: "until must be contract, context, or initiative" };
      until = value;
    } else {
      const number = Number(value);
      const maximum = token === "--max-turns" ? 100 : 1_440;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > maximum) return { error: `${token} must be between 1 and ${maximum}` };
      if (token === "--max-turns") maxTurns = number;
      else maxMinutes = number;
    }
  }
  if (action !== "start" && seen.size) return { error: "policy options are accepted only when starting a new run" };
  return {
    action,
    topic,
    mode,
    until,
    policy: {
      ...(maxTurns === undefined ? {} : { maxTurns }),
      maxRetries: defaults.maxRetries,
      ...(maxMinutes === undefined ? {} : { maxElapsedMs: maxMinutes * 60_000 }),
    },
  };
}

function canonicalRunnerIdentity(
  resolution: Extract<InitiativeResolution, { sourceMode: "canonical" }>,
  selected?: GateAwareOrchestrationRecommendation["activeContract"],
): PiSweRunnerIdentity | undefined {
  const manifest = resolution.inspection.manifest;
  const manifestActive = manifest && "activeContract" in manifest ? manifest.activeContract : undefined;
  const contract = selected ?? manifestActive;
  if (!manifest?.activePlan || !contract) return undefined;
  const indexed = resolution.inspection.contractIndex?.contracts.find((candidate) => candidate.id === contract.id && candidate.path === contract.path);
  if (!indexed?.contentHash || !/^sha256:[a-f0-9]{64}$/.test(indexed.contentHash)) return undefined;
  return {
    topic: resolution.topic,
    planRevision: manifest.activePlan.revision,
    contractId: contract.id,
    contractPath: contract.path,
    contractHash: indexed.contentHash as `sha256:${string}`,
  };
}

function sameRunnerIdentity(left: PiSweRunnerIdentity, right: PiSweRunnerIdentity): boolean {
  return left.topic === right.topic && left.planRevision === right.planRevision && left.contractId === right.contractId
    && left.contractPath === right.contractPath && left.contractHash === right.contractHash;
}

function formatSweWorkState(cwd: string, topic: string): { ok: boolean; message: string } {
  const current = readPiSweRunnerState(cwd, topic);
  if (current.diagnostics.length) return { ok: false, message: formatRunnerDiagnostics(topic, current.diagnostics) };
  const snapshot = current.snapshot;
  if (!snapshot) return { ok: true, message: `pi-swe work\ntopic: ${topic}\nstatus: inactive\nstage: none\nstop reason: none` };
  const runner = snapshot.runner;
  return {
    ok: true,
    message: [
      "pi-swe work",
      `topic: ${topic}`,
      `status: ${runner.status}`,
      `owner: ${snapshot.ownerToken}`,
      `run: ${runner.runId}`,
      `mode: ${runner.mode}`,
      `until: ${runner.until}`,
      `stage: ${runner.pendingDispatch?.stage ?? "await-evaluation"}`,
      `identity: plan r${runner.identity.planRevision}, contract ${runner.identity.contractId}, ${runner.identity.contractPath}, ${runner.identity.contractHash}`,
      `policy: max-turns=${runner.policy.maxTurns ?? "unlimited"}, max-retries=${runner.policy.maxRetries}, max-elapsed-ms=${runner.policy.maxElapsedMs ?? "unlimited"}${runner.policy.maxProviderUnits === undefined ? "" : `, max-provider-units=${runner.policy.maxProviderUnits}`}`,
      `counters: turns=${runner.turnCount}, retries=${runner.retryCount}, next-dispatch=${runner.nextDispatchSequence}, accepted-dispatch=${runner.lastAcceptedDispatchSequence}`,
      `recovery: ${current.recovery ?? "inactive"}`,
      `stop reason: ${runner.terminalReason ?? "none"}`,
    ].join("\n"),
  };
}

function formatRunnerDiagnostics(topic: string, diagnostics: readonly { code: string; message: string; path: string }[]): string {
  return `pi-swe work\ntopic: ${topic}\nstatus: blocked\ndiagnostics: ${diagnostics.map((item) => `${item.code}: ${item.message} (${item.path})`).join("; ")}`;
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
      `legacy authority: ${resolution.status === "legacy-unverified" ? resolution.planPath : resolution.status === "migration-required" ? resolution.manifestPath : "none"}`,
      `next command: migrate layout-v1 authority before /swe orchestrate resume ${resolution.topic}`,
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
