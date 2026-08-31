import { posix } from "node:path";

import type { PiSweInitiativeState } from "./initiative.ts";

export const PI_SWE_LIFECYCLE_STATES = [
  "intake",
  "classify",
  "diagnose",
  "plan",
  "dsa-assess",
  "tdd",
  "implement",
  "verify",
  "review",
  "finalize",
  "complete",
  "blocked",
] as const;

export type PiSweLifecycleState = (typeof PI_SWE_LIFECYCLE_STATES)[number];

export const PI_SWE_CONTRACT_STATES = [
  "pending",
  "implementing",
  "verifying",
  "reviewing",
  "blocked",
  "deferred",
  "complete",
] as const;

export type PiSweContractState = (typeof PI_SWE_CONTRACT_STATES)[number];
export type LifecycleGateOutcome = { ready: boolean; reason: string };

export const PI_SWE_INITIATIVE_TRANSITIONS: Readonly<Record<PiSweInitiativeState, readonly PiSweInitiativeState[]>> = Object.freeze({
  intake: ["intake", "specifying", "blocked"],
  specifying: ["specifying", "planning", "blocked"],
  planning: ["planning", "reviewing", "blocked"],
  reviewing: ["reviewing", "approved", "planning", "blocked"],
  approved: ["approved", "executing", "planning", "blocked"],
  executing: ["executing", "finalizing", "planning", "blocked"],
  finalizing: ["finalizing", "complete", "executing", "planning", "blocked"],
  complete: [],
  blocked: ["blocked", "planning", "executing"],
});

export const PI_SWE_CONTRACT_TRANSITIONS: Readonly<Record<PiSweContractState, readonly PiSweContractState[]>> = Object.freeze({
  pending: ["pending", "implementing", "blocked", "deferred"],
  implementing: ["implementing", "verifying", "blocked", "deferred"],
  verifying: ["verifying", "reviewing", "implementing", "blocked", "deferred"],
  reviewing: ["reviewing", "complete", "implementing", "blocked", "deferred"],
  blocked: ["blocked", "implementing", "deferred"],
  deferred: [],
  complete: [],
});

export type TwoLevelTransitionResult<State extends string> =
  | { allowed: true; state: State; nextState: State }
  | { allowed: false; state: State; reason: "unknown-transition" | "gate-blocked"; gateReason: string; allowedNextStates: State[] };

export type InitiativeTransitionRequest = { state: PiSweInitiativeState; nextState: PiSweInitiativeState; gate?: LifecycleGateOutcome };
export type ContractTransitionRequest = { state: PiSweContractState; nextState: PiSweContractState; gate?: LifecycleGateOutcome };

export type OrchestrationAction =
  | "specify"
  | "plan"
  | "review-plan"
  | "approve-plan"
  | "revise-plan"
  | "start-initiative"
  | "start-next-contract"
  | "implement-contract"
  | "verify-contract"
  | "review-contract"
  | "return-to-implement"
  | "complete-contract"
  | "resolve-contract-block"
  | "defer-contract"
  | "finalize-initiative"
  | "finalize-handoff"
  | "complete-initiative";

export type OrchestrationContract = { id: string; planRevision: number; state: PiSweContractState };
export type OrchestrationLifecycleGates = {
  manifestValid: boolean;
  initiativeUnambiguous: boolean;
  planReviewReady?: boolean;
  planApproved?: boolean;
  readyContractIds?: readonly string[];
  activeContractCompletion?: LifecycleGateOutcome;
  activeContractDeferral?: LifecycleGateOutcome;
  finalizeReady?: boolean;
  finalHandoffReady?: boolean;
};
export type OrchestrationLifecycleRequest = {
  initiativeState: PiSweInitiativeState;
  planRevision: number;
  activeContract?: OrchestrationContract;
  contracts: readonly OrchestrationContract[];
  gates: OrchestrationLifecycleGates;
};
export type OrchestrationLifecycleResult = {
  initiativeState: PiSweInitiativeState;
  activeContract?: OrchestrationContract;
  invalidatedActiveContract: boolean;
  nextContractId?: string;
  allowedActions: OrchestrationAction[];
  blockedCases: PiSweBlockedCase[];
};

export type FlatLifecycleCompatibility = {
  initiativeState: PiSweInitiativeState;
  contractState?: PiSweContractState;
  compatibilityOnly: true;
  planApproved: false;
  contractReady: false;
};

export type LegacyOrchestrationPath = "feature" | "bug" | "dsa";
export type LegacyOrchestrationPathCompatibility = Omit<FlatLifecycleCompatibility, "contractState"> & {
  flatState: Extract<PiSweLifecycleState, "plan" | "diagnose" | "dsa-assess">;
};

export type LifecycleTransitionRequest = {
  state: PiSweLifecycleState;
  nextState: PiSweLifecycleState;
  outputs?: Record<string, string>;
};

export type LifecycleTransitionResult =
  | {
      allowed: true;
      state: PiSweLifecycleState;
      nextState: PiSweLifecycleState;
    }
  | {
      allowed: false;
      state: "blocked";
      reason: "unknown-transition";
      allowedNextStates: PiSweLifecycleState[];
    };

export type StableWorkDocumentKey =
  | "workOrder"
  | "phaseIndex"
  | "diagnosisFinding"
  | "dsaDecision"
  | "implementationNote"
  | "verificationReport"
  | "reviewReport"
  | "finalHandoff";

export type AutonomousWorkStateFile = {
  topic: string;
  state: PiSweLifecycleState;
  activePhase?: string;
  planRevision?: number;
  activeContractId?: string;
  retryCounts?: Record<string, number>;
  artifacts?: Partial<Record<StableWorkDocumentKey, string>>;
};

export type ReconstructAutonomousWorkStateRequest = {
  cwd: string;
  statePath: string;
};

export type AutonomousNextAction = {
  stage: PiSweLifecycleState;
  prompt?: string;
  readPaths: string[];
  writePath?: string;
  allowedNextStates: PiSweLifecycleState[];
};

export type ReconstructedAutonomousWorkState = {
  topic: string;
  state: PiSweLifecycleState;
  artifactPaths: Record<string, string>;
  nextAction: AutonomousNextAction;
};

export type PiSweBlockedCase =
  | "ambiguous-intent"
  | "unsafe-operation"
  | "scope-drift"
  | "missing-capability"
  | "unreproducible-failure"
  | "no-verifier"
  | "repeat-failure"
  | "conflicting-changes"
  | "stale-plan"
  | "ambiguous-initiative"
  | "invalid-manifest"
  | "dependency-blocked"
  | "final-handoff-missing"
  | "contract-disposition-incomplete"
  | "unknown-transition";

export type AutonomousRunnerEvent =
  | {
      kind: "stage-completed";
      from: PiSweLifecycleState;
      nextState: PiSweLifecycleState;
      /** Canonical gate result; legacy flat state alone never grants readiness. */
      gate?: LifecycleGateOutcome;
      allRequiredContractsDisposed?: boolean;
    }
  | {
      kind: "stage-failed";
      from: PiSweLifecycleState;
      requestedNextState: PiSweLifecycleState;
      failureSignature: string;
      evidencePath: string;
      failedCheckMatchesActivePhase?: boolean;
    }
  | {
      kind: "blocked";
      blockedCase: PiSweBlockedCase;
      artifactPath: string;
    };

export type AutonomousRunnerPolicy = {
  verifyImplementRetries?: number;
  reviewImplementRetries?: number;
};

export type AutonomousRunnerStepRequest = {
  state: AutonomousWorkStateFile;
  event: AutonomousRunnerEvent;
  policy?: AutonomousRunnerPolicy;
};

export type AutonomousRunnerStepDecision =
  | {
      terminal: false;
      state: PiSweLifecycleState;
      nextState: PiSweLifecycleState;
      retryKey?: string;
      retryCount?: number;
      retryBudget?: number;
    }
  | {
      terminal: true;
      terminalState: "complete";
      state: "complete";
      humanRequest: string;
      artifactPath: string;
    }
  | {
      terminal: true;
      terminalState: `blocked:${PiSweBlockedCase}`;
      state: "blocked";
      blockedCase: PiSweBlockedCase;
      humanRequest: string;
      artifactPath: string;
      retryKey?: string;
      retryCount?: number;
      retryBudget?: number;
    };

export const PI_SWE_LIFECYCLE_TRANSITIONS: Readonly<Record<PiSweLifecycleState, readonly PiSweLifecycleState[]>> = Object.freeze({
  intake: ["classify"],
  classify: ["diagnose", "plan", "dsa-assess"],
  diagnose: ["plan", "tdd"],
  plan: ["dsa-assess", "tdd", "implement"],
  "dsa-assess": ["implement"],
  tdd: ["verify"],
  implement: ["verify"],
  verify: ["review", "implement"],
  review: ["finalize", "implement", "plan"],
  finalize: ["complete"],
  complete: [],
  blocked: [],
});

export const PI_SWE_STABLE_WORK_DOCUMENTS: Readonly<Record<StableWorkDocumentKey, { ownerState: PiSweLifecycleState; pathShape: string }>> = Object.freeze({
  workOrder: { ownerState: "intake", pathShape: ".model-artifacts/specs/<topic>/<timestamp>-work-order.md" },
  phaseIndex: { ownerState: "plan", pathShape: ".model-artifacts/todo/<topic>/phases/00-phase-index.md" },
  diagnosisFinding: { ownerState: "diagnose", pathShape: ".model-artifacts/findings/<topic>/<timestamp>-diagnosis.md" },
  dsaDecision: { ownerState: "dsa-assess", pathShape: ".model-artifacts/findings/<topic>/<timestamp>-dsa-decision.md" },
  implementationNote: { ownerState: "implement", pathShape: ".model-artifacts/logs/<topic>/<timestamp>-implementation.md" },
  verificationReport: { ownerState: "verify", pathShape: ".model-artifacts/reports/<topic>/<timestamp>-verification.md" },
  reviewReport: { ownerState: "review", pathShape: ".model-artifacts/reports/<topic>/<timestamp>-review.md" },
  finalHandoff: { ownerState: "finalize", pathShape: ".model-artifacts/reports/<topic>/<timestamp>-handoff.md" },
});

const BASE_STAGE_READ_KEYS = ["workOrder", "phaseIndex", "activePhase"] as const;
const REVIEW_STAGE_READ_KEYS = ["implementationNote", "verificationReport"] as const;
const OUTPUT_KEY_BY_STAGE: Partial<Record<PiSweLifecycleState, StableWorkDocumentKey>> = Object.freeze({
  intake: "workOrder",
  diagnose: "diagnosisFinding",
  plan: "phaseIndex",
  "dsa-assess": "dsaDecision",
  implement: "implementationNote",
  tdd: "implementationNote",
  verify: "verificationReport",
  review: "reviewReport",
  finalize: "finalHandoff",
});

const DEFAULT_RUNNER_POLICY: Required<AutonomousRunnerPolicy> = Object.freeze({
  verifyImplementRetries: 2,
  reviewImplementRetries: 1,
});

export const PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS: Readonly<Record<PiSweBlockedCase, string>> = Object.freeze({
  "ambiguous-intent": "clarify intent",
  "unsafe-operation": "approve/deny risk",
  "scope-drift": "approve updated plan",
  "missing-capability": "provide capability or alter plan",
  "unreproducible-failure": "provide repro or accept diagnostic gap",
  "no-verifier": "choose acceptable verification",
  "repeat-failure": "inspect failure and decide",
  "conflicting-changes": "resolve or authorize handling",
  "stale-plan": "revise and reapprove the active plan",
  "ambiguous-initiative": "select one canonical initiative",
  "invalid-manifest": "repair the canonical initiative manifest",
  "dependency-blocked": "complete or dispose blocking dependencies",
  "final-handoff-missing": "create and verify the final handoff",
  "contract-disposition-incomplete": "complete or approve deferral for every required contract",
  "unknown-transition": "fix runner/workflow definition",
});

export function validateInitiativeTransition(request: InitiativeTransitionRequest): TwoLevelTransitionResult<PiSweInitiativeState> {
  return validateTwoLevelTransition(request.state, request.nextState, PI_SWE_INITIATIVE_TRANSITIONS, request.gate, initiativeTransitionNeedsGate(request.state, request.nextState));
}

export function validateContractTransition(request: ContractTransitionRequest): TwoLevelTransitionResult<PiSweContractState> {
  return validateTwoLevelTransition(request.state, request.nextState, PI_SWE_CONTRACT_TRANSITIONS, request.gate, contractTransitionNeedsGate(request.state, request.nextState));
}

export function deriveOrchestrationLifecycle(request: OrchestrationLifecycleRequest): OrchestrationLifecycleResult {
  const base = { initiativeState: request.initiativeState, activeContract: request.activeContract, invalidatedActiveContract: false, allowedActions: [] as OrchestrationAction[], blockedCases: [] as PiSweBlockedCase[] };
  if (!request.gates.manifestValid) return { ...base, activeContract: undefined, blockedCases: ["invalid-manifest"] };
  if (!request.gates.initiativeUnambiguous) return { ...base, activeContract: undefined, blockedCases: ["ambiguous-initiative"] };

  const lifecycleContracts = request.activeContract ? [...request.contracts, request.activeContract] : request.contracts;
  if (
    !Number.isSafeInteger(request.planRevision)
    || request.planRevision <= 0
    || lifecycleContracts.some((contract) => !contract.id.trim() || contract.id !== contract.id.trim() || !Number.isSafeInteger(contract.planRevision) || contract.planRevision <= 0)
  ) {
    return { ...base, activeContract: undefined, allowedActions: [], blockedCases: ["invalid-manifest"] };
  }

  if (
    (request.activeContract && request.activeContract.planRevision !== request.planRevision)
    || request.contracts.some((contract) => contract.planRevision !== request.planRevision)
  ) {
    return {
      initiativeState: "planning",
      invalidatedActiveContract: request.activeContract !== undefined,
      allowedActions: ["revise-plan"],
      blockedCases: ["stale-plan"],
    };
  }

  const contractIds = request.contracts.map((contract) => contract.id);
  const activeMatches = request.activeContract
    ? request.contracts.filter((contract) => contract.id === request.activeContract!.id)
    : [];
  if (
    new Set(contractIds).size !== contractIds.length
    || (request.activeContract && (
      activeMatches.length !== 1
      || activeMatches[0]!.state !== request.activeContract.state
      || activeMatches[0]!.planRevision !== request.activeContract.planRevision
    ))
  ) {
    return { ...base, activeContract: undefined, allowedActions: [], blockedCases: ["invalid-manifest"] };
  }

  if (request.initiativeState === "intake" || request.initiativeState === "specifying") return { ...base, allowedActions: ["specify"] };
  if (request.initiativeState === "planning") return { ...base, allowedActions: request.gates.planReviewReady ? ["review-plan"] : ["plan"] };
  if (request.initiativeState === "reviewing") return { ...base, allowedActions: request.gates.planApproved ? ["approve-plan"] : ["revise-plan"] };
  if (request.initiativeState === "approved") return { ...base, allowedActions: request.gates.planApproved ? ["start-initiative"] : ["revise-plan"], ...(!request.gates.planApproved ? { blockedCases: ["stale-plan"] as PiSweBlockedCase[] } : {}) };
  if (request.initiativeState === "complete") return base;

  if (request.initiativeState === "finalizing") {
    if (!allContractsDisposed(request.contracts)) return { ...base, blockedCases: ["contract-disposition-incomplete"] };
    if (!request.gates.finalizeReady) return { ...base, allowedActions: ["finalize-handoff"], blockedCases: ["contract-disposition-incomplete"] };
    if (!request.gates.finalHandoffReady) return { ...base, allowedActions: ["finalize-handoff"], blockedCases: ["final-handoff-missing"] };
    return { ...base, allowedActions: ["complete-initiative"] };
  }

  if (request.initiativeState === "blocked") return { ...base, allowedActions: ["revise-plan"] };
  const readyIds = new Set(request.gates.readyContractIds ?? []);
  const activeDisposed = request.activeContract?.state === "complete" || request.activeContract?.state === "deferred";
  const progressBase = activeDisposed ? { ...base, activeContract: undefined } : base;
  if (request.activeContract && !activeDisposed) {
    if (request.activeContract.state === "pending" && !readyIds.has(request.activeContract.id)) {
      return { ...base, blockedCases: ["dependency-blocked"] };
    }
    return { ...base, allowedActions: actionsForActiveContract(request.activeContract.state, request.gates) };
  }

  const nextContract = request.contracts
    .filter((contract) => contract.planRevision === request.planRevision && contract.state === "pending" && readyIds.has(contract.id))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (nextContract) return { ...progressBase, nextContractId: nextContract.id, allowedActions: ["start-next-contract"] };
  if (allContractsDisposed(request.contracts) && request.gates.finalizeReady) return { ...progressBase, allowedActions: ["finalize-initiative"] };
  return { ...progressBase, blockedCases: ["dependency-blocked"] };
}

export function mapLegacyOrchestrationPath(path: LegacyOrchestrationPath): LegacyOrchestrationPathCompatibility {
  const flatState = { feature: "plan", bug: "diagnose", dsa: "dsa-assess" }[path] as LegacyOrchestrationPathCompatibility["flatState"];
  return { flatState, initiativeState: "planning", compatibilityOnly: true, planApproved: false, contractReady: false };
}

export function mapFlatLifecycleState(state: PiSweLifecycleState): FlatLifecycleCompatibility {
  const mapped: Record<PiSweLifecycleState, Pick<FlatLifecycleCompatibility, "initiativeState" | "contractState">> = {
    intake: { initiativeState: "intake" },
    classify: { initiativeState: "specifying" },
    diagnose: { initiativeState: "planning" },
    plan: { initiativeState: "planning" },
    "dsa-assess": { initiativeState: "planning" },
    tdd: { initiativeState: "executing", contractState: "implementing" },
    implement: { initiativeState: "executing", contractState: "implementing" },
    verify: { initiativeState: "executing", contractState: "verifying" },
    review: { initiativeState: "executing", contractState: "reviewing" },
    finalize: { initiativeState: "finalizing" },
    complete: { initiativeState: "complete" },
    blocked: { initiativeState: "blocked", contractState: "blocked" },
  };
  return { ...mapped[state], compatibilityOnly: true, planApproved: false, contractReady: false };
}

export function validateLifecycleTransition(request: LifecycleTransitionRequest): LifecycleTransitionResult {
  const allowedNextStates = [...PI_SWE_LIFECYCLE_TRANSITIONS[request.state]];
  if (!allowedNextStates.includes(request.nextState)) {
    return {
      allowed: false,
      state: "blocked",
      reason: "unknown-transition",
      allowedNextStates,
    };
  }

  return {
    allowed: true,
    state: request.state,
    nextState: request.nextState,
  };
}

export function evaluateAutonomousRunnerStep(request: AutonomousRunnerStepRequest): AutonomousRunnerStepDecision {
  const event = request.event;

  if (event.kind !== "blocked" && event.from !== request.state.state) {
    return blockedDecision("unknown-transition", event.kind === "stage-failed" ? event.evidencePath : artifactPathForBlockedDecision(request.state));
  }

  if (event.kind === "stage-completed") {
    const transition = validateLifecycleTransition({ state: event.from, nextState: event.nextState });
    if (!transition.allowed) return blockedDecision("unknown-transition", artifactPathForBlockedDecision(request.state));
    if (event.nextState === "complete") {
      if (event.allRequiredContractsDisposed !== true) return blockedDecision("contract-disposition-incomplete", artifactPathForBlockedDecision(request.state));
      if (event.gate?.ready !== true || !request.state.artifacts?.finalHandoff) return blockedDecision("final-handoff-missing", artifactPathForBlockedDecision(request.state));
      return {
        terminal: true,
        terminalState: "complete",
        state: "complete",
        humanRequest: "review completed handoff",
        artifactPath: request.state.artifacts.finalHandoff,
      };
    }
    return { terminal: false, state: event.from, nextState: event.nextState };
  }

  if (event.kind === "blocked") return blockedDecision(event.blockedCase, event.artifactPath);

  const transition = validateLifecycleTransition({ state: event.from, nextState: event.requestedNextState });
  if (!transition.allowed) return blockedDecision("unknown-transition", event.evidencePath);
  if (event.failedCheckMatchesActivePhase === false) return blockedDecision("scope-drift", event.evidencePath);

  const hasPlanRevision = request.state.planRevision !== undefined;
  const hasContractId = request.state.activeContractId !== undefined;
  if (
    hasPlanRevision !== hasContractId
    || (hasPlanRevision && (!Number.isSafeInteger(request.state.planRevision) || request.state.planRevision! <= 0))
    || (hasContractId && !request.state.activeContractId?.trim())
  ) {
    return blockedDecision("invalid-manifest", event.evidencePath);
  }

  const retryScope = `r${request.state.planRevision ?? "legacy"}/${request.state.activeContractId ?? request.state.activePhase ?? "unscoped"}:`;
  const retryKey = `${retryScope}${event.from}->${event.requestedNextState}:${event.failureSignature}`;
  const retryCount = request.state.retryCounts?.[retryKey] ?? 0;
  const retryBudget = retryBudgetFor(event.from, event.requestedNextState, request.policy);
  if (retryBudget !== undefined && retryCount >= retryBudget) {
    return {
      terminal: true,
      terminalState: "blocked:repeat-failure",
      state: "blocked",
      blockedCase: "repeat-failure",
      humanRequest: PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS["repeat-failure"],
      artifactPath: event.evidencePath,
      retryKey,
      retryCount,
      retryBudget,
    };
  }

  return {
    terminal: false,
    state: event.from,
    nextState: event.requestedNextState,
    retryKey,
    retryCount,
    retryBudget,
  };
}

export function parseAutonomousState(content: string): AutonomousWorkStateFile {
  const parsed = JSON.parse(content) as Partial<AutonomousWorkStateFile>;
  if (typeof parsed.topic !== "string" || parsed.topic.trim() === "") throw new Error("autonomous state requires topic");
  if (!isPiSweLifecycleState(parsed.state)) throw new Error(`unknown autonomous state: ${String(parsed.state)}`);
  const hasPlanRevision = parsed.planRevision !== undefined;
  const hasContractId = parsed.activeContractId !== undefined;
  if (hasPlanRevision !== hasContractId) throw new Error("canonical autonomous state requires planRevision and activeContractId together");
  if (hasPlanRevision && (!Number.isSafeInteger(parsed.planRevision) || parsed.planRevision! <= 0)) throw new Error("autonomous state planRevision must be a positive integer");
  if (hasContractId && (typeof parsed.activeContractId !== "string" || !parsed.activeContractId.trim())) throw new Error("autonomous state activeContractId must be non-empty");
  return {
    topic: parsed.topic.trim(),
    state: parsed.state,
    activePhase: parsed.activePhase,
    planRevision: parsed.planRevision,
    activeContractId: parsed.activeContractId,
    retryCounts: parsed.retryCounts,
    artifacts: parsed.artifacts,
  };
}

export function buildNextAction(stage: PiSweLifecycleState, artifactPaths: Record<string, string>): AutonomousNextAction {
  return {
    stage,
    prompt: promptForStage(stage),
    readPaths: readPathsForStage(stage, artifactPaths),
    writePath: writePathForStage(stage, artifactPaths),
    allowedNextStates: [...PI_SWE_LIFECYCLE_TRANSITIONS[stage]],
  };
}

export function normalizeArtifactPath(filePath: string): string {
  const normalized = posix.normalize(filePath.trim().replace(/\\+/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) throw new Error(`artifact path must be repository-relative: ${filePath}`);
  return normalized;
}

export function assertStableArtifactPath(filePath: string): void {
  if (!/^\.model-artifacts\/(todo|plans|findings|reports|logs|specs)\//.test(filePath)) throw new Error(`unsupported artifact path: ${filePath}`);
}

export function isPiSweLifecycleState(value: unknown): value is PiSweLifecycleState {
  return typeof value === "string" && (PI_SWE_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function validateTwoLevelTransition<State extends string>(
  state: State,
  nextState: State,
  transitions: Readonly<Record<State, readonly State[]>>,
  gate: LifecycleGateOutcome | undefined,
  gateRequired: boolean,
): TwoLevelTransitionResult<State> {
  const allowedNextStates = [...transitions[state]];
  if (!allowedNextStates.includes(nextState)) {
    return { allowed: false, state, reason: "unknown-transition", gateReason: "transition is not defined", allowedNextStates };
  }
  if (gateRequired && gate?.ready !== true) {
    return { allowed: false, state, reason: "gate-blocked", gateReason: gate?.reason ?? "required readiness outcome is missing", allowedNextStates };
  }
  return { allowed: true, state, nextState };
}

function initiativeTransitionNeedsGate(state: PiSweInitiativeState, nextState: PiSweInitiativeState): boolean {
  return (state === "reviewing" && nextState === "approved")
    || (state === "approved" && nextState === "executing")
    || (state === "executing" && nextState === "finalizing")
    || (state === "finalizing" && (nextState === "complete" || nextState === "executing"))
    || (state === "blocked" && nextState === "executing");
}

function contractTransitionNeedsGate(state: PiSweContractState, nextState: PiSweContractState): boolean {
  return (nextState === "implementing" && state !== "verifying" && state !== "reviewing" && state !== "implementing")
    || nextState === "deferred"
    || (state === "reviewing" && nextState === "complete");
}

function actionsForActiveContract(state: PiSweContractState, gates: OrchestrationLifecycleGates): OrchestrationAction[] {
  const deferral = gates.activeContractDeferral?.ready === true ? ["defer-contract" as const] : [];
  switch (state) {
    case "pending": return ["implement-contract", ...deferral];
    case "implementing": return ["implement-contract", ...deferral];
    case "verifying": return ["verify-contract", "return-to-implement", ...deferral];
    case "reviewing": return [
      "review-contract",
      ...(gates.activeContractCompletion?.ready === true ? ["complete-contract" as const] : []),
      "return-to-implement",
      ...deferral,
    ];
    case "blocked": return ["resolve-contract-block", ...deferral];
    case "deferred":
    case "complete": return [];
  }
}

function allContractsDisposed(contracts: readonly OrchestrationContract[]): boolean {
  return contracts.every((contract) => contract.state === "complete" || contract.state === "deferred");
}

function blockedDecision(blockedCase: PiSweBlockedCase, artifactPath: string): AutonomousRunnerStepDecision {
  return {
    terminal: true,
    terminalState: `blocked:${blockedCase}`,
    state: "blocked",
    blockedCase,
    humanRequest: PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS[blockedCase],
    artifactPath,
  };
}

function retryBudgetFor(from: PiSweLifecycleState, to: PiSweLifecycleState, policy: AutonomousRunnerPolicy = {}): number | undefined {
  if (from === "verify" && to === "implement") return policy.verifyImplementRetries ?? DEFAULT_RUNNER_POLICY.verifyImplementRetries;
  if (from === "review" && to === "implement") return policy.reviewImplementRetries ?? DEFAULT_RUNNER_POLICY.reviewImplementRetries;
  return undefined;
}

function artifactPathForBlockedDecision(state: AutonomousWorkStateFile): string {
  return state.artifacts?.verificationReport ?? state.artifacts?.reviewReport ?? state.artifacts?.finalHandoff ?? state.artifacts?.workOrder ?? state.activePhase ?? ".model-artifacts/reports/unknown/blocked.md";
}

function readPathsForStage(stage: PiSweLifecycleState, artifactPaths: Record<string, string>): string[] {
  const readKeys = new Set<string>(["state"]);
  addExistingKeys(readKeys, artifactPaths, BASE_STAGE_READ_KEYS);

  if (stage === "review" || stage === "finalize") addExistingKeys(readKeys, artifactPaths, REVIEW_STAGE_READ_KEYS);
  if (stage === "finalize" && artifactPaths.reviewReport) readKeys.add("reviewReport");

  return [...readKeys].map((key) => artifactPaths[key]).filter((value): value is string => Boolean(value));
}

function writePathForStage(stage: PiSweLifecycleState, artifactPaths: Record<string, string>): string | undefined {
  const key = OUTPUT_KEY_BY_STAGE[stage];
  return key ? artifactPaths[key] : undefined;
}

function addExistingKeys(readKeys: Set<string>, artifactPaths: Record<string, string>, keys: readonly string[]): void {
  for (const key of keys) if (artifactPaths[key]) readKeys.add(key);
}

function promptForStage(stage: PiSweLifecycleState): string | undefined {
  if (stage === "complete" || stage === "blocked" || stage === "intake" || stage === "classify") return undefined;
  if (stage === "dsa-assess") return "swe-dsa";
  return `swe-${stage}`;
}
