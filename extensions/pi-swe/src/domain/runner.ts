import {
  evaluateAutonomousRunnerStep,
  validateLifecycleTransition,
  type PiSweBlockedCase,
  type PiSweLifecycleState,
} from "./lifecycle.ts";

export const PI_SWE_RUNNER_STATE_VERSION = 1 as const;

export type PiSweRunnerMode = "guided" | "autonomous";
export type PiSweRunnerUntil = "contract" | "initiative";
export type PiSweRunnerStage = "specify" | "diagnose" | "plan" | "dsa-assess" | "tdd-plan" | "plan-review" | "plan-revise" | "implement" | "verify" | "implementation-review" | "finalize";
export type PiSweRunnerHardStop =
  | "ambiguous-initiative"
  | "stale-plan"
  | "dependency-blocked"
  | "missing-verifier"
  | "missing-capability"
  | "scope-drift"
  | "conflicting-changes"
  | "unsafe-operation"
  | "external-side-effect"
  | "human-only-decision";
export type PiSweRunnerTerminalReason = PiSweRunnerHardStop
  | "invalid-canonical-identity"
  | "invalid-checkpoint"
  | "invalid-checkpoint-identity"
  | "missing-checkpoint"
  | "uncertain-dispatch"
  | "completion-failed"
  | "retry-budget-exhausted"
  | "turn-budget-exhausted"
  | "time-budget-exhausted"
  | "provider-budget-exhausted"
  | "human-plan-revision-required"
  | "operator-paused"
  | "operator-stopped"
  | "contract-dispositioned"
  | "initiative-complete";

export type PiSweRunnerPolicy = {
  readonly maxTurns: number;
  readonly maxRetries: number;
  readonly maxElapsedMs: number;
  readonly maxProviderUnits?: number;
};

export type PiSweRunnerIdentity = {
  readonly topic: string;
  readonly planRevision: number;
  readonly contractId: string;
  readonly contractPath: string;
  readonly contractHash: `sha256:${string}`;
};

export type PiSweRunnerDispatch = {
  readonly sequence: number;
  readonly token: string;
  readonly stage: PiSweRunnerStage;
  readonly skill: `swe-${string}`;
  readonly identity: PiSweRunnerIdentity;
  readonly deliveryStatus: "prepared" | "sent";
};

export type PiSweRunnerRecord = {
  readonly version: typeof PI_SWE_RUNNER_STATE_VERSION;
  readonly runId: string;
  readonly mode: PiSweRunnerMode;
  readonly until: PiSweRunnerUntil;
  readonly identity: PiSweRunnerIdentity;
  readonly policy: PiSweRunnerPolicy;
  readonly startedAtMs: number;
  readonly status: "running" | "paused" | "stopped" | "blocked" | "complete";
  readonly turnCount: number;
  readonly retryCount: number;
  readonly retryCounts: Readonly<Record<string, number>>;
  readonly nextDispatchSequence: number;
  readonly lastAcceptedDispatchSequence: number;
  readonly lastAcceptedCheckpointKey?: string;
  readonly pendingDispatch?: PiSweRunnerDispatch;
  readonly terminalReason?: PiSweRunnerTerminalReason;
};

export type PiSweRunnerRecommendation = {
  readonly stage: PiSweRunnerStage | "complete" | "blocked-handoff";
  readonly skill?: `swe-${string}`;
  readonly blockingReasons: readonly string[];
};

export type PiSweRunnerCanonicalView = {
  readonly identity?: PiSweRunnerIdentity;
  readonly recommendation: PiSweRunnerRecommendation;
  readonly hardStop?: PiSweRunnerHardStop;
  readonly providerUnitsUsed?: number;
};

export type PiSweRunnerEvidence = {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
};

export type PiSweRunnerCheckpoint = PiSweRunnerIdentity & {
  readonly runId: string;
  readonly dispatchToken: string;
  readonly stage: PiSweRunnerStage;
  readonly outcome: "completed" | "retry" | "return-to-plan" | "contract-ready" | "blocked";
  readonly failureSignature?: string;
  readonly blockedCase?: PiSweBlockedCase;
  readonly evidence: readonly PiSweRunnerEvidence[];
};

export type PiSweRunnerEvent =
  | { readonly kind: "evaluate" }
  | { readonly kind: "checkpoint"; readonly checkpoint: PiSweRunnerCheckpoint }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" };

export type PiSweRunnerAction =
  | { readonly kind: "none"; readonly reason: "awaiting-checkpoint" | "checkpoint-accepted" | "duplicate-checkpoint" | "runner-not-active" }
  | { readonly kind: "dispatch-stage"; readonly stage: PiSweRunnerStage; readonly skill: `swe-${string}`; readonly dispatchToken: string; readonly identity: PiSweRunnerIdentity }
  | { readonly kind: "complete-contract" }
  | { readonly kind: "finalize" }
  | { readonly kind: "pause"; readonly reason: PiSweRunnerTerminalReason }
  | { readonly kind: "stop"; readonly reason: PiSweRunnerTerminalReason }
  | { readonly kind: "blocked-handoff"; readonly reason: PiSweRunnerTerminalReason; readonly details: readonly string[] };

export type CreatePiSweRunnerRequest = {
  readonly runId: string;
  readonly mode: PiSweRunnerMode;
  readonly until: PiSweRunnerUntil;
  readonly identity: PiSweRunnerIdentity;
  readonly policy: PiSweRunnerPolicy;
  readonly startedAtMs: number;
};

export type ReducePiSweRunnerRequest = {
  readonly state: PiSweRunnerRecord;
  readonly canonical: PiSweRunnerCanonicalView;
  readonly event: PiSweRunnerEvent;
  readonly nowMs: number;
};

export type PiSweRunnerReduction = { readonly state: PiSweRunnerRecord; readonly action: PiSweRunnerAction };

export function createPiSweRunner(request: CreatePiSweRunnerRequest): PiSweRunnerRecord {
  if (!isNonEmptyToken(request.runId)) throw new Error("runner runId must be non-empty and bounded");
  if (!validIdentity(request.identity)) throw new Error("runner requires a valid canonical identity");
  if (!Number.isSafeInteger(request.startedAtMs) || request.startedAtMs < 0) throw new Error("runner startedAtMs must be a non-negative integer");
  validatePolicy(request.policy);
  return {
    version: PI_SWE_RUNNER_STATE_VERSION,
    runId: request.runId,
    mode: request.mode,
    until: request.until,
    identity: { ...request.identity },
    policy: { ...request.policy },
    startedAtMs: request.startedAtMs,
    status: "running",
    turnCount: 0,
    retryCount: 0,
    retryCounts: {},
    nextDispatchSequence: 1,
    lastAcceptedDispatchSequence: 0,
  };
}

export function reducePiSweRunner(request: ReducePiSweRunnerRequest): PiSweRunnerReduction {
  const { state, canonical, event, nowMs } = request;
  if (event.kind === "pause") return pause(state, "operator-paused");
  if (event.kind === "stop") return stop(state, "operator-stopped");
  if (event.kind === "checkpoint") {
    if (state.status === "running") return acceptCheckpoint(state, canonical, event.checkpoint);
    if (state.status === "paused" && state.terminalReason === "missing-checkpoint" && state.pendingDispatch) {
      return acceptCheckpoint({ ...state, status: "running", terminalReason: undefined }, canonical, event.checkpoint);
    }
  }
  if (state.status !== "running") return { state, action: { kind: "none", reason: "runner-not-active" } };

  const budgetReason = exhaustedBudget(state, canonical, nowMs);
  if (budgetReason) return pause(state, budgetReason);
  if (canonical.hardStop) return block(state, canonical.hardStop, canonical.recommendation.blockingReasons);
  if (canonical.recommendation.stage === "blocked-handoff") {
    return block(state, "human-only-decision", canonical.recommendation.blockingReasons);
  }
  if (canonical.recommendation.stage === "complete") return stop({ ...state, status: "complete" }, "initiative-complete");

  if (!canonical.identity) {
    if (state.until === "contract") return stop(state, "contract-dispositioned");
    if (canonical.recommendation.stage === "finalize") return { state, action: { kind: "finalize" } };
    return block(state, "invalid-canonical-identity", ["fresh canonical inspection did not select an executable contract"]);
  }
  if (!sameIdentity(state.identity, canonical.identity)) {
    if (state.until === "contract" && canonical.identity.contractId !== state.identity.contractId) return stop(state, "contract-dispositioned");
    return block(state, "invalid-canonical-identity", ["fresh canonical identity differs from the authorized run"]);
  }
  if (state.pendingDispatch) return { state, action: { kind: "none", reason: "awaiting-checkpoint" } };

  const skill = canonical.recommendation.skill;
  const stage = canonical.recommendation.stage;
  if (!skill) {
    return block(state, "human-only-decision", ["canonical recommendation is not a dispatchable skill stage"]);
  }
  const sequence = state.nextDispatchSequence;
  const token = `${state.runId}:${sequence}`;
  const dispatch: PiSweRunnerDispatch = {
    sequence,
    token,
    stage,
    skill,
    identity: { ...canonical.identity },
    deliveryStatus: "prepared",
  };
  return {
    state: { ...state, pendingDispatch: dispatch, nextDispatchSequence: sequence + 1 },
    action: { kind: "dispatch-stage", stage: dispatch.stage, skill, dispatchToken: token, identity: dispatch.identity },
  };
}

function acceptCheckpoint(state: PiSweRunnerRecord, canonical: PiSweRunnerCanonicalView, checkpoint: PiSweRunnerCheckpoint): PiSweRunnerReduction {
  const sequence = parseDispatchSequence(state.runId, checkpoint.dispatchToken);
  if (sequence !== undefined && sequence <= state.lastAcceptedDispatchSequence) {
    if (sequence === state.lastAcceptedDispatchSequence && checkpointKey(checkpoint) === state.lastAcceptedCheckpointKey) {
      return { state, action: { kind: "none", reason: "duplicate-checkpoint" } };
    }
    return block(state, "invalid-checkpoint", ["checkpoint contradicts the accepted dispatch result"]);
  }
  const pending = state.pendingDispatch;
  if (!pending || sequence !== pending.sequence) return block(state, "invalid-checkpoint-identity", ["checkpoint does not match the pending dispatch token"]);
  if (
    checkpoint.runId !== state.runId
    || checkpoint.stage !== pending.stage
    || !sameIdentity(checkpoint, pending.identity)
    || !canonical.identity
    || !sameIdentity(checkpoint, canonical.identity)
  ) {
    return block(state, "invalid-checkpoint-identity", ["checkpoint run, stage, or canonical identity is stale"]);
  }
  if (!validCheckpointPayload(checkpoint, state.identity.topic)) return block(state, "invalid-checkpoint", ["checkpoint evidence or outcome is malformed"]);

  const acceptedState: PiSweRunnerRecord = {
    ...state,
    pendingDispatch: undefined,
    turnCount: state.turnCount + 1,
    lastAcceptedDispatchSequence: pending.sequence,
    lastAcceptedCheckpointKey: checkpointKey(checkpoint),
  };
  if (checkpoint.outcome === "completed") return { state: acceptedState, action: { kind: "none", reason: "checkpoint-accepted" } };
  if (checkpoint.outcome === "contract-ready") {
    if (checkpoint.stage !== "implementation-review") return block(state, "invalid-checkpoint", ["only implementation review may declare a contract ready"]);
    return { state: acceptedState, action: { kind: "complete-contract" } };
  }
  if (checkpoint.outcome === "return-to-plan") {
    const transition = validateLifecycleTransition({ state: stageToLifecycle(checkpoint.stage), nextState: "plan" });
    if (!transition.allowed) return block(state, "invalid-checkpoint", ["stage cannot return to plan"]);
    return pause(acceptedState, "human-plan-revision-required");
  }
  if (checkpoint.outcome === "blocked") {
    return block(acceptedState, mapBlockedCase(checkpoint.blockedCase), checkpoint.blockedCase ? [checkpoint.blockedCase] : []);
  }

  const from = stageToLifecycle(checkpoint.stage);
  const retryKey = `r${state.identity.planRevision}/${state.identity.contractId}:${from}->implement:${checkpoint.failureSignature}`;
  const decision = evaluateAutonomousRunnerStep({
    state: {
      topic: state.identity.topic,
      state: from,
      planRevision: state.identity.planRevision,
      activeContractId: state.identity.contractId,
      retryCounts: state.retryCounts,
    },
    event: {
      kind: "stage-failed",
      from,
      requestedNextState: "implement",
      failureSignature: checkpoint.failureSignature!,
      evidencePath: checkpoint.evidence[0]!.path,
      failedCheckMatchesActivePhase: true,
    },
    policy: { verifyImplementRetries: state.policy.maxRetries, reviewImplementRetries: state.policy.maxRetries },
  });
  if (decision.terminal) return block(acceptedState, "retry-budget-exhausted", [decision.humanRequest]);
  return {
    state: {
      ...acceptedState,
      retryCount: state.retryCount + 1,
      retryCounts: { ...state.retryCounts, [retryKey]: (state.retryCounts[retryKey] ?? 0) + 1 },
    },
    action: { kind: "none", reason: "checkpoint-accepted" },
  };
}

function exhaustedBudget(state: PiSweRunnerRecord, canonical: PiSweRunnerCanonicalView, nowMs: number): PiSweRunnerTerminalReason | undefined {
  if (state.turnCount >= state.policy.maxTurns) return "turn-budget-exhausted";
  if (!Number.isSafeInteger(nowMs) || nowMs - state.startedAtMs >= state.policy.maxElapsedMs) return "time-budget-exhausted";
  if (state.policy.maxProviderUnits !== undefined && (canonical.providerUnitsUsed ?? 0) >= state.policy.maxProviderUnits) return "provider-budget-exhausted";
  return undefined;
}

function validatePolicy(policy: PiSweRunnerPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`runner policy ${name} must be a non-negative integer`);
  }
  if (policy.maxTurns === 0 || policy.maxElapsedMs === 0) throw new Error("runner turn and elapsed budgets must be positive");
}

function validIdentity(identity: PiSweRunnerIdentity): boolean {
  return isNonEmptyToken(identity.topic)
    && Number.isSafeInteger(identity.planRevision) && identity.planRevision > 0
    && isNonEmptyToken(identity.contractId)
    && isTopicPath(identity.contractPath, identity.topic)
    && isSha256(identity.contractHash);
}

function validCheckpointPayload(checkpoint: PiSweRunnerCheckpoint, topic: string): boolean {
  if (!checkpoint.evidence.length || checkpoint.evidence.length > 16) return false;
  if (checkpoint.outcome === "retry" && (!checkpoint.failureSignature || !isNonEmptyToken(checkpoint.failureSignature))) return false;
  if (checkpoint.outcome === "blocked" && !checkpoint.blockedCase) return false;
  return checkpoint.evidence.every((item) => isTopicPath(item.path, topic) && isSha256(item.sha256));
}

function sameIdentity(left: PiSweRunnerIdentity, right: PiSweRunnerIdentity): boolean {
  return left.topic === right.topic
    && left.planRevision === right.planRevision
    && left.contractId === right.contractId
    && left.contractPath === right.contractPath
    && left.contractHash === right.contractHash;
}

function checkpointKey(checkpoint: PiSweRunnerCheckpoint): string {
  return JSON.stringify({
    runId: checkpoint.runId,
    dispatchToken: checkpoint.dispatchToken,
    topic: checkpoint.topic,
    planRevision: checkpoint.planRevision,
    contractId: checkpoint.contractId,
    contractPath: checkpoint.contractPath,
    contractHash: checkpoint.contractHash,
    stage: checkpoint.stage,
    outcome: checkpoint.outcome,
    failureSignature: checkpoint.failureSignature,
    blockedCase: checkpoint.blockedCase,
    evidence: checkpoint.evidence,
  });
}

function parseDispatchSequence(runId: string, token: string): number | undefined {
  if (!token.startsWith(`${runId}:`)) return undefined;
  const value = Number(token.slice(runId.length + 1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stageToLifecycle(stage: PiSweRunnerStage): PiSweLifecycleState {
  if (stage === "implementation-review" || stage === "plan-review") return "review";
  if (stage === "tdd-plan") return "tdd";
  if (stage === "plan-revise" || stage === "specify") return "plan";
  return stage;
}

function mapBlockedCase(blockedCase: PiSweBlockedCase | undefined): PiSweRunnerTerminalReason {
  if (blockedCase === "ambiguous-initiative" || blockedCase === "stale-plan" || blockedCase === "dependency-blocked" || blockedCase === "missing-capability" || blockedCase === "scope-drift" || blockedCase === "conflicting-changes" || blockedCase === "unsafe-operation") return blockedCase;
  if (blockedCase === "no-verifier") return "missing-verifier";
  return "human-only-decision";
}

function pause(state: PiSweRunnerRecord, reason: PiSweRunnerTerminalReason): PiSweRunnerReduction {
  return { state: { ...state, status: "paused", terminalReason: reason }, action: { kind: "pause", reason } };
}

function stop(state: PiSweRunnerRecord, reason: PiSweRunnerTerminalReason): PiSweRunnerReduction {
  return { state: { ...state, status: state.status === "complete" ? "complete" : "stopped", terminalReason: reason }, action: { kind: "stop", reason } };
}

function block(state: PiSweRunnerRecord, reason: PiSweRunnerTerminalReason, details: readonly string[]): PiSweRunnerReduction {
  return { state: { ...state, status: "blocked", terminalReason: reason }, action: { kind: "blocked-handoff", reason, details: [...details] } };
}

function isNonEmptyToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSha256(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function isTopicPath(path: string, topic: string): boolean {
  if (path.length > 2_048 || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return path.startsWith(`.model-artifacts/initiatives/${topic}/`) || path.startsWith(`.model-artifacts/system/logs/pi-swe/${topic}/`);
}
