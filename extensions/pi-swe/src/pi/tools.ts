import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { persistPiSweRunnerState, readPiSweRunnerState } from "../app/runner-persistence.ts";
import { resolveCanonicalCompletionRequest, type ResolveCanonicalCompletionResult } from "../completion-resolution.ts";
import { completeCanonicalContract, type CompleteCanonicalContractResult } from "../completion.ts";
import { reducePiSweRunner, type PiSweRunnerAction, type PiSweRunnerCanonicalView, type PiSweRunnerCheckpoint, type PiSweRunnerIdentity } from "../domain/runner.ts";
import { recommendGateAwareOrchestration } from "../orchestrate.ts";
import { resolveInitiative, type InitiativeResolution } from "../planning.ts";
import { formatCompletion } from "./commands.ts";
import { runnerFinalizationRecommendation } from "./work-runner.ts";

export type SweCompleteInput = {
  readonly topic?: string;
  readonly contractId?: string;
  readonly confirm: boolean;
  readonly next?: "clear" | "advance";
};

type SweCompleteDependencies = {
  readonly resolve: typeof resolveCanonicalCompletionRequest;
  readonly complete: typeof completeCanonicalContract;
};

type SweCompleteDetails = CompleteCanonicalContractResult & {
  readonly topic?: string;
  readonly contractPath?: string;
  readonly planRevision?: number;
};

const MAX_TOOL_TEXT = 2048;
const MAX_TOOL_MESSAGE = 512;
const MAX_TOOL_ITEMS = 8;

const dependencies: SweCompleteDependencies = {
  resolve: resolveCanonicalCompletionRequest,
  complete: completeCanonicalContract,
};

export function registerSweTools(pi: ExtensionAPI, deps: SweCompleteDependencies = dependencies): void {
  registerSweCheckpointTool(pi);
  pi.registerTool({
    name: "swe_complete",
    label: "SWE Complete",
    description: "Complete the active reviewed canonical pi-swe contract through the existing guarded transaction. Requires explicit confirm: true and fails closed on ambiguous or stale state/evidence.",
    promptSnippet: "Complete one reviewed canonical pi-swe contract with explicit confirmation",
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "Canonical initiative topic; inferred only when exactly one active initiative exists" })),
      contractId: Type.Optional(Type.String({ description: "Active executable contract ID; defaults to manifest.activeContract" })),
      confirm: Type.Boolean({ description: "Must be exactly true before any completion resolution or evidence I/O" }),
      next: Type.Optional(StringEnum(["clear", "advance"] as const, { description: "Clear or advance activeContract; defaults to advance" })),
    }),
    async execute(_toolCallId, params: SweCompleteInput, _signal, _onUpdate, ctx) {
      if (params.confirm !== true) {
        const result: ResolveCanonicalCompletionResult = {
          status: "rejected",
          message: "confirm must be true before canonical completion resolution",
          artifact: ".model-artifacts/initiatives",
        };
        return toolResult(result);
      }

      const resolved = deps.resolve({
        cwd: ctx.cwd,
        topic: params.topic,
        contractId: params.contractId,
        nextActiveContract: params.next ?? "advance",
      });
      if (resolved.status === "rejected") return toolResult(resolved);

      const result = deps.complete(resolved.request);
      return toolResult({
        ...result,
        topic: resolved.request.topic,
        contractPath: resolved.request.expectedContractPath,
        planRevision: resolved.request.expectedPlanRevision,
      });
    },
  });
}

const CHECKPOINT_STAGES = ["specify", "diagnose", "plan", "dsa-assess", "tdd-plan", "plan-review", "plan-revise", "implement", "verify", "implementation-review", "finalize"] as const;
const CHECKPOINT_OUTCOMES = ["completed", "retry", "return-to-plan", "contract-ready", "blocked"] as const;
const CHECKPOINT_BLOCKED_CASES = ["ambiguous-intent", "unsafe-operation", "scope-drift", "missing-capability", "unreproducible-failure", "no-verifier", "repeat-failure", "conflicting-changes", "stale-plan", "ambiguous-initiative", "invalid-manifest", "dependency-blocked", "final-handoff-missing", "contract-disposition-incomplete", "unknown-transition"] as const;
const MAX_CHECKPOINT_EVIDENCE_BYTES = 4 * 1024 * 1024;

type SweCheckpointInput = PiSweRunnerCheckpoint;

function registerSweCheckpointTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "swe_checkpoint",
    label: "SWE Stage Checkpoint",
    description: "Report one bounded stage outcome for the active pi-swe runner dispatch. Validates exact canonical and evidence identity; it never approves plans, external effects, or completion.",
    promptSnippet: "Checkpoint the active pi-swe runner stage using exact persisted identity",
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, maxLength: 256 }),
      dispatchToken: Type.String({ minLength: 1, maxLength: 256 }),
      topic: Type.String({ minLength: 1, maxLength: 128 }),
      planRevision: Type.Integer({ minimum: 1 }),
      contractId: Type.String({ minLength: 1, maxLength: 128 }),
      contractPath: Type.String({ minLength: 1, maxLength: 512 }),
      contractHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      stage: StringEnum(CHECKPOINT_STAGES),
      outcome: StringEnum(CHECKPOINT_OUTCOMES),
      failureSignature: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      blockedCase: Type.Optional(StringEnum(CHECKPOINT_BLOCKED_CASES)),
      evidence: Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512 }),
        sha256: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      }), { minItems: 1, maxItems: 16 }),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as SweCheckpointInput;
      const rejected = (message: string) => checkpointToolResult("rejected", message, params);
      const resolution = resolveInitiative({ cwd: ctx.cwd, explicitTopic: params.topic });
      if (resolution.sourceMode !== "canonical") return rejected("checkpoint topic does not resolve to one canonical initiative");
      const recommendation = runnerFinalizationRecommendation(resolution, recommendGateAwareOrchestration({ resolution }));
      const current = readPiSweRunnerState(ctx.cwd, params.topic);
      if (current.diagnostics.length || !current.snapshot) return rejected(current.diagnostics[0]?.message ?? "active runner state is unavailable");
      const identity = canonicalCheckpointIdentity(resolution, recommendation.activeContract)
        ?? (recommendation.stage === "finalize" ? current.snapshot.runner.identity : undefined);
      if (!identity || !sameCheckpointIdentity(identity, params)) return rejected("checkpoint canonical identity is stale or invalid");
      const evidenceError = validateCheckpointEvidence(ctx.cwd, params.topic, params.evidence);
      if (evidenceError) return rejected(evidenceError);

      const canonical: PiSweRunnerCanonicalView = {
        identity,
        recommendation: {
          stage: recommendation.stage,
          ...(recommendation.skill ? { skill: recommendation.skill } : {}),
          blockingReasons: recommendation.blockingReasons,
        },
      };
      const pendingSequence = current.snapshot.runner.pendingDispatch?.sequence;
      const reduced = reducePiSweRunner({ state: current.snapshot.runner, canonical, event: { kind: "checkpoint", checkpoint: params }, nowMs: Date.now() });
      const accepted = pendingSequence !== undefined
        && reduced.state.lastAcceptedDispatchSequence === pendingSequence
        && reduced.state.pendingDispatch === undefined;
      const duplicate = reduced.action.kind === "none" && reduced.action.reason === "duplicate-checkpoint";
      if (!duplicate && reduced.state !== current.snapshot.runner) {
        const diagnostics = persistPiSweRunnerState(ctx.cwd, { topic: params.topic, ownerToken: current.snapshot.ownerToken, runner: reduced.state });
        if (diagnostics.length) return checkpointToolResult("rejected", diagnostics[0]!.message, params, reduced.action);
      }
      if (!accepted) {
        return checkpointToolResult("rejected", duplicate ? "duplicate-checkpoint" : "checkpoint was rejected and the runner was blocked", params, reduced.action);
      }
      return checkpointToolResult("accepted", `checkpoint accepted; action ${reduced.action.kind} is surfaced for the controller`, params, reduced.action);
    },
  });
}

function canonicalCheckpointIdentity(
  resolution: Extract<InitiativeResolution, { sourceMode: "canonical" }>,
  selected?: { readonly id: string; readonly path: string },
): PiSweRunnerIdentity | undefined {
  const manifest = resolution.inspection.manifest;
  const manifestActive = manifest && "activeContract" in manifest ? manifest.activeContract : undefined;
  const active = selected ?? manifestActive;
  if (!manifest?.activePlan || !active) return undefined;
  const contract = resolution.inspection.contractIndex?.contracts.find((item) => item.id === active.id && item.path === active.path);
  if (!contract?.contentHash || !/^sha256:[a-f0-9]{64}$/.test(contract.contentHash)) return undefined;
  return { topic: resolution.topic, planRevision: manifest.activePlan.revision, contractId: active.id, contractPath: active.path, contractHash: contract.contentHash as `sha256:${string}` };
}

function sameCheckpointIdentity(left: PiSweRunnerIdentity, right: PiSweRunnerIdentity): boolean {
  return left.topic === right.topic && left.planRevision === right.planRevision && left.contractId === right.contractId
    && left.contractPath === right.contractPath && left.contractHash === right.contractHash;
}

function validateCheckpointEvidence(cwd: string, topic: string, evidence: readonly { path: string; sha256: `sha256:${string}` }[]): string | undefined {
  const repositoryRoot = resolve(cwd);
  const topicRoot = resolve(repositoryRoot, `.model-artifacts/initiatives/${topic}`);
  for (const item of evidence) {
    if (item.path.includes("\\") || isAbsolute(item.path) || item.path.split("/").some((part) => part === "" || part === "." || part === "..")) return `unsafe evidence path: ${item.path}`;
    const absolute = resolve(repositoryRoot, item.path);
    const within = relative(topicRoot, absolute);
    if (within === "" || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) return `evidence path is outside the canonical topic: ${item.path}`;
    try {
      let current = repositoryRoot;
      for (const segment of relative(repositoryRoot, absolute).split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) return `evidence path traverses a symlink: ${item.path}`;
      }
      if (!existsSync(absolute)) return `evidence file is missing: ${item.path}`;
      const metadata = statSync(absolute);
      if (!metadata.isFile()) return `evidence file is missing: ${item.path}`;
      if (metadata.size > MAX_CHECKPOINT_EVIDENCE_BYTES) return `evidence file exceeds ${MAX_CHECKPOINT_EVIDENCE_BYTES} bytes: ${item.path}`;
      const actual = `sha256:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`;
      if (actual !== item.sha256) return `evidence hash is stale: ${item.path}`;
    } catch {
      return `evidence file could not be validated: ${item.path}`;
    }
  }
  return undefined;
}

function checkpointToolResult(
  status: "accepted" | "rejected",
  message: string,
  params: Pick<SweCheckpointInput, "topic" | "runId" | "dispatchToken" | "stage">,
  action?: PiSweRunnerAction,
) {
  return {
    content: [{ type: "text" as const, text: boundedText(`pi-swe checkpoint\nstatus: ${status}\naction: ${action?.kind ?? "none"}\nreason: ${message}`, MAX_TOOL_TEXT) }],
    details: {
      status,
      topic: params.topic,
      runId: params.runId,
      dispatchToken: params.dispatchToken,
      stage: params.stage,
      ...(action ? { action } : {}),
      message: boundedText(message, MAX_TOOL_MESSAGE),
    },
  };
}

function toolResult(result: SweCompleteDetails) {
  return {
    content: [{ type: "text" as const, text: boundedText(formatCompletion(result), MAX_TOOL_TEXT) }],
    details: compactDetails(result),
  };
}

function compactDetails(result: SweCompleteDetails): Record<string, unknown> {
  const identity = {
    ...(result.topic ? { topic: result.topic } : {}),
    ...(result.contractId ? { contractId: result.contractId } : {}),
    ...(result.contractPath ? { contractPath: result.contractPath } : {}),
    ...(result.planRevision ? { planRevision: result.planRevision } : {}),
  };
  if (result.status === "completed") {
    return {
      status: result.status,
      ...identity,
      requestId: result.requestId,
      phaseProgress: result.phaseProgress,
      activeContractId: result.activeContractId,
      readyContractIds: result.readyContractIds.slice(0, MAX_TOOL_ITEMS),
    };
  }
  if (result.status === "already-complete") {
    return {
      status: result.status,
      ...identity,
      requestId: result.requestId,
      recordedNextState: {
        ...result.recordedNextState,
        readyContractIds: result.recordedNextState.readyContractIds.slice(0, MAX_TOOL_ITEMS),
      },
      currentActiveContractId: result.currentActiveContractId,
      currentReadyContractIds: result.currentReadyContractIds.slice(0, MAX_TOOL_ITEMS),
    };
  }
  return {
    status: result.status,
    ...identity,
    message: boundedText(result.message, MAX_TOOL_MESSAGE),
    ...(result.artifact ? { artifact: boundedText(result.artifact, MAX_TOOL_MESSAGE) } : {}),
  };
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
