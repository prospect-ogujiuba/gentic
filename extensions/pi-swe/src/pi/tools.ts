import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveCanonicalCompletionRequest, type ResolveCanonicalCompletionResult } from "../completion-resolution.ts";
import { completeCanonicalContract, type CompleteCanonicalContractResult } from "../completion.ts";
import { formatCompletion } from "./commands.ts";

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
