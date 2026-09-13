import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  markPiSweRunnerDispatchSent,
  persistPiSweRunnerState,
  readPiSweRunnerState,
  type PiSweRunnerSnapshot,
} from "../app/runner-persistence.ts";
import { completeCanonicalContract } from "../completion.ts";
import { resolveCanonicalCompletionRequest } from "../completion-resolution.ts";
import {
  reducePiSweRunner,
  type PiSweRunnerCanonicalView,
  type PiSweRunnerCheckpoint,
  type PiSweRunnerIdentity,
  type PiSweRunnerRecord,
  type PiSweRunnerTerminalReason,
} from "../domain/runner.ts";
import { recommendGateAwareOrchestration, type ContractExecutionView, type GateAwareOrchestrationRecommendation } from "../orchestrate.ts";
import { resolveInitiative, type InitiativeResolution } from "../planning.ts";

const MAX_RUNNER_CANDIDATES = 100;
const MAX_PROMPT_LENGTH = 8_192;
const settlingTopics = new Set<string>();

export async function settleOwnedPiSweRunners(pi: ExtensionAPI, ctx: ExtensionContext, nowMs = Date.now()): Promise<void> {
  const compatible = ctx as ExtensionContext & { readonly sessionId?: string; readonly sessionManager?: { getSessionId(): string } };
  const ownerToken = compatible.sessionManager?.getSessionId() ?? compatible.sessionId;
  if (!ctx.cwd || !ownerToken || !ctx.isIdle()) return;
  const topics = findOwnedRunnerTopics(ctx.cwd, ownerToken);
  if (topics.length !== 1) {
    if (topics.length > 1) ctx.ui.notify("pi-swe runner paused: multiple active runner leases are owned by this session", "warning");
    return;
  }
  await settlePiSweRunner(pi, ctx, topics[0]!, nowMs);
}

export async function settlePiSweRunner(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: Pick<ExtensionContext, "cwd" | "isIdle" | "ui"> & { readonly sessionId?: string; readonly sessionManager?: { getSessionId(): string } },
  topic: string,
  nowMs = Date.now(),
): Promise<void> {
  const ownerToken = ctx.sessionManager?.getSessionId() ?? ctx.sessionId;
  if (!ctx.cwd || !ownerToken || !ctx.isIdle() || settlingTopics.has(topic)) return;
  settlingTopics.add(topic);
  let continueRun = false;
  try {
    const current = readPiSweRunnerState(ctx.cwd, topic, ownerToken);
    if (current.diagnostics.length || !current.snapshot || current.snapshot.runner.status !== "running") return;
    const snapshot = current.snapshot;
    const pending = snapshot.runner.pendingDispatch;
    if (pending) {
      const reason: PiSweRunnerTerminalReason = pending.deliveryStatus === "prepared" ? "uncertain-dispatch" : "missing-checkpoint";
      persistTerminal(ctx.cwd, snapshot, "paused", reason);
      ctx.ui.notify(`pi-swe runner paused: ${reason === "missing-checkpoint" ? "the settled skill turn did not provide its required checkpoint" : "dispatch delivery is uncertain; explicit recovery is required"}`, "warning");
      return;
    }

    const resolution = resolveInitiative({ cwd: ctx.cwd, explicitTopic: topic });
    if (resolution.sourceMode !== "canonical") {
      persistTerminal(ctx.cwd, snapshot, "blocked", "invalid-canonical-identity");
      return;
    }
    const checkpoint = readAcceptedCheckpoint(snapshot.runner);
    if (checkpoint?.outcome === "contract-ready") {
      continueRun = completeReadyContract(ctx, snapshot, checkpoint);
      return;
    }
    if (checkpoint?.stage === "finalize" && checkpoint.outcome === "completed") {
      persistTerminal(ctx.cwd, snapshot, "complete", "initiative-complete");
      return;
    }

    const execution = checkpointExecution(snapshot.runner, checkpoint);
    let recommendation = recommendGateAwareOrchestration({
      resolution,
      ...(execution ? { contractExecution: { [snapshot.runner.identity.contractId]: execution } } : {}),
    });
    recommendation = runnerFinalizationRecommendation(resolution, recommendation);
    const identity = canonicalIdentity(resolution, recommendation.activeContract);
    const evaluationIdentity = identity ?? (recommendation.stage === "finalize" ? snapshot.runner.identity : undefined);
    const canonical: PiSweRunnerCanonicalView = {
      ...(evaluationIdentity ? { identity: evaluationIdentity } : {}),
      recommendation: {
        stage: recommendation.stage,
        ...(recommendation.skill ? { skill: recommendation.skill } : {}),
        blockingReasons: recommendation.blockingReasons,
      },
      ...(recommendation.stage === "blocked-handoff" ? { hardStop: "human-only-decision" } : {}),
    };
    const reduced = reducePiSweRunner({ state: snapshot.runner, canonical, event: { kind: "evaluate" }, nowMs });
    const diagnostics = persistPiSweRunnerState(ctx.cwd, { topic, ownerToken: snapshot.ownerToken, runner: reduced.state });
    if (diagnostics.length) return;
    if (reduced.action.kind !== "dispatch-stage") {
      if (reduced.action.kind === "blocked-handoff" || reduced.action.kind === "pause" || reduced.action.kind === "stop") {
        const details = reduced.action.kind === "blocked-handoff" && reduced.action.details.length ? `: ${reduced.action.details.join("; ")}` : "";
        ctx.ui.notify(`pi-swe runner ${reduced.state.status}: ${reduced.state.terminalReason ?? reduced.action.kind}${details}`, "warning");
      }
      return;
    }

    try {
      const prompt = dispatchPrompt(reduced.action.skill, reduced.action.stage, reduced.action.dispatchToken, reduced.action.identity, reduced.state, recommendation.requiredReadPaths);
      if (typeof pi.sendUserMessage !== "function") throw new Error("sendUserMessage is unavailable");
      pi.sendUserMessage(prompt, { expandPromptTemplates: true });
    } catch {
      persistTerminal(ctx.cwd, { ...snapshot, runner: reduced.state }, "blocked", "uncertain-dispatch");
      ctx.ui.notify("pi-swe runner blocked: skill dispatch failed after intent was persisted", "warning");
      return;
    }
    const sentDiagnostics = markPiSweRunnerDispatchSent(ctx.cwd, topic, snapshot.ownerToken, reduced.action.dispatchToken);
    if (sentDiagnostics.length) ctx.ui.notify(`pi-swe runner blocked: ${sentDiagnostics[0]!.message}`, "warning");
  } finally {
    settlingTopics.delete(topic);
    if (continueRun) await settlePiSweRunner(pi, ctx, topic, nowMs);
  }
}

function completeReadyContract(ctx: Pick<ExtensionContext, "cwd" | "ui">, snapshot: PiSweRunnerSnapshot, checkpoint: PiSweRunnerCheckpoint): boolean {
  const cwd = ctx.cwd!;
  const resolved = resolveCanonicalCompletionRequest({ cwd, topic: snapshot.topic, contractId: checkpoint.contractId, nextActiveContract: "advance" });
  if (resolved.status !== "resolved") {
    persistTerminal(cwd, snapshot, "blocked", "completion-failed");
    ctx.ui.notify(`pi-swe runner blocked: completion rejected: ${resolved.message}`, "warning");
    return false;
  }
  const result = completeCanonicalContract(resolved.request);
  if (result.status !== "completed" && result.status !== "already-complete") {
    persistTerminal(cwd, snapshot, "blocked", "completion-failed");
    ctx.ui.notify(`pi-swe runner blocked: completion failed: ${result.message}`, "warning");
    return false;
  }
  if (snapshot.runner.until === "contract") {
    persistTerminal(cwd, snapshot, "stopped", "contract-dispositioned");
    return false;
  }
  const refreshed = resolveInitiative({ cwd, explicitTopic: snapshot.topic });
  const nextIdentity = refreshed.sourceMode === "canonical" ? canonicalIdentity(refreshed, refreshed.inspection.manifest?.activeContract) : undefined;
  const runner: PiSweRunnerRecord = {
    ...snapshot.runner,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    lastAcceptedCheckpointKey: undefined,
  };
  const diagnostics = persistPiSweRunnerState(cwd, { topic: snapshot.topic, ownerToken: snapshot.ownerToken, runner });
  return diagnostics.length === 0;
}

export function runnerFinalizationRecommendation(
  resolution: Extract<InitiativeResolution, { sourceMode: "canonical" }>,
  recommendation: GateAwareOrchestrationRecommendation,
): GateAwareOrchestrationRecommendation {
  if (resolution.inspection.manifest?.initiativeState !== "finalizing"
    || resolution.inspection.manifest.activeContract
    || recommendation.reason !== "validated final-handoff evidence is required before completion") return recommendation;
  return {
    ...recommendation,
    stage: "finalize",
    skill: "swe-finalize",
    reason: "the finalizing initiative requires its canonical final-handoff stage",
    blockingReasons: [],
  };
}

function checkpointExecution(runner: PiSweRunnerRecord, checkpoint: PiSweRunnerCheckpoint | undefined): ContractExecutionView | undefined {
  if (!checkpoint || !sameIdentity(checkpoint, runner.identity)) return undefined;
  const evidencePath = checkpoint.evidence[0]?.path;
  if (checkpoint.outcome === "retry") return { state: "implementing", statePath: evidencePath! };
  if (checkpoint.outcome !== "completed") return undefined;
  if (checkpoint.stage === "implement") return { state: "verifying", statePath: evidencePath!, implementationPath: evidencePath };
  if (checkpoint.stage === "verify") return { state: "reviewing", statePath: evidencePath!, verificationPath: evidencePath };
  if (checkpoint.stage === "implementation-review") return { state: "reviewing", statePath: evidencePath!, reviewPath: evidencePath };
  return undefined;
}

function readAcceptedCheckpoint(runner: PiSweRunnerRecord): PiSweRunnerCheckpoint | undefined {
  if (!runner.lastAcceptedCheckpointKey) return undefined;
  try {
    const value: unknown = JSON.parse(runner.lastAcceptedCheckpointKey);
    return value && typeof value === "object" && "runId" in value && "dispatchToken" in value && "outcome" in value
      ? value as PiSweRunnerCheckpoint
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalIdentity(
  resolution: Extract<InitiativeResolution, { sourceMode: "canonical" }>,
  selected?: { readonly id: string; readonly path: string },
): PiSweRunnerIdentity | undefined {
  const manifest = resolution.inspection.manifest;
  const active = selected ?? manifest?.activeContract;
  if (!manifest?.activePlan || !active) return undefined;
  const contract = resolution.inspection.contractIndex?.contracts.find((item) => item.id === active.id && item.path === active.path);
  if (!contract?.contentHash || !/^sha256:[a-f0-9]{64}$/.test(contract.contentHash)) return undefined;
  return { topic: resolution.topic, planRevision: manifest.activePlan.revision, contractId: active.id, contractPath: active.path, contractHash: contract.contentHash as `sha256:${string}` };
}

function dispatchPrompt(
  skill: string,
  stage: string,
  token: string,
  identity: PiSweRunnerIdentity,
  runner: Pick<PiSweRunnerRecord, "mode" | "until" | "policy">,
  reads: readonly string[],
): string {
  const providerBudget = runner.policy.maxProviderUnits === undefined ? "" : `, maxProviderUnits=${runner.policy.maxProviderUnits}`;
  const prompt = `/skill:${skill} Execute only canonical ${identity.topic} plan r${identity.planRevision} contract ${identity.contractId} at ${identity.contractPath} (${identity.contractHash}); stage ${stage}; mode ${runner.mode}; until ${runner.until}; policy maxTurns=${runner.policy.maxTurns}, maxRetries=${runner.policy.maxRetries}, maxElapsedMs=${runner.policy.maxElapsedMs}${providerBudget}; first re-read ${[`.model-artifacts/initiatives/${identity.topic}/specs/manifest.json`, ...reads].filter((value, index, all) => all.indexOf(value) === index).join(", ")}; before ending call swe_checkpoint exactly once with runId ${token.slice(0, token.lastIndexOf(":"))} and dispatchToken ${token}, this exact canonical identity and bounded evidence; evidence paths must be under .model-artifacts/initiatives/${identity.topic}/ and match their sha256 hashes. Stop for any human gate, unsafe/external action, stale state, missing capability, or scope drift.`;
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error("runner dispatch prompt exceeds its bound");
  return prompt;
}

function persistTerminal(cwd: string, snapshot: PiSweRunnerSnapshot, status: "paused" | "blocked" | "stopped" | "complete", terminalReason: PiSweRunnerTerminalReason): void {
  persistPiSweRunnerState(cwd, { topic: snapshot.topic, ownerToken: snapshot.ownerToken, runner: { ...snapshot.runner, status, terminalReason } });
}

function findOwnedRunnerTopics(cwd: string, ownerToken: string): string[] {
  const root = join(cwd, ".model-artifacts/system/logs/pi-swe");
  const topics: string[] = [];
  let inspectedEntries = 0;
  function walk(directory: string, segments: string[]): void {
    if (inspectedEntries >= MAX_RUNNER_CANDIDATES || segments.length > 16) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_RUNNER_CANDIDATES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), [...segments, entry.name]);
      else if (entry.isFile() && entry.name === "runner.json") {
        const topic = segments.join("/");
        const current = readPiSweRunnerState(cwd, topic, ownerToken);
        if (!current.diagnostics.length && current.snapshot?.runner.status === "running") topics.push(topic);
      }
      if (inspectedEntries >= MAX_RUNNER_CANDIDATES) return;
    }
  }
  walk(root, []);
  return topics.sort();
}

function sameIdentity(left: PiSweRunnerIdentity, right: PiSweRunnerIdentity): boolean {
  return left.topic === right.topic && left.planRevision === right.planRevision && left.contractId === right.contractId
    && left.contractPath === right.contractPath && left.contractHash === right.contractHash;
}
