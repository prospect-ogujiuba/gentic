import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

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
  | "unknown-transition";

export type AutonomousRunnerEvent =
  | {
      kind: "stage-completed";
      from: PiSweLifecycleState;
      nextState: PiSweLifecycleState;
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
  "unknown-transition": "fix runner/workflow definition",
});

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

  if (event.kind === "stage-completed") {
    const transition = validateLifecycleTransition({ state: event.from, nextState: event.nextState });
    if (!transition.allowed) return blockedDecision("unknown-transition", artifactPathForBlockedDecision(request.state));
    if (event.nextState === "complete") {
      return {
        terminal: true,
        terminalState: "complete",
        state: "complete",
        humanRequest: "review completed handoff",
        artifactPath: artifactPathForCompleteDecision(request.state),
      };
    }
    return { terminal: false, state: event.from, nextState: event.nextState };
  }

  if (event.kind === "blocked") return blockedDecision(event.blockedCase, event.artifactPath);

  const transition = validateLifecycleTransition({ state: event.from, nextState: event.requestedNextState });
  if (!transition.allowed) return blockedDecision("unknown-transition", event.evidencePath);
  if (event.failedCheckMatchesActivePhase === false) return blockedDecision("scope-drift", event.evidencePath);

  const retryKey = `${event.from}->${event.requestedNextState}:${event.failureSignature}`;
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

export function reconstructAutonomousWorkState(request: ReconstructAutonomousWorkStateRequest): ReconstructedAutonomousWorkState {
  const statePath = normalizeArtifactPath(request.statePath);
  assertStableArtifactPath(statePath);
  assertReadableArtifact(request.cwd, statePath);

  const state = parseAutonomousState(readFileSync(join(request.cwd, statePath), "utf8"));
  const artifactPaths: Record<string, string> = { state: statePath };

  const activePhase = state.activePhase ? normalizeArtifactPath(state.activePhase) : undefined;
  if (activePhase) {
    assertStableArtifactPath(activePhase);
    assertReadableArtifact(request.cwd, activePhase);
    artifactPaths.activePhase = activePhase;
  }

  for (const [key, value] of Object.entries(state.artifacts ?? {}) as Array<[StableWorkDocumentKey, string | undefined]>) {
    if (!value) continue;
    const artifactPath = normalizeArtifactPath(value);
    assertStableArtifactPath(artifactPath);
    assertReadableArtifact(request.cwd, artifactPath);
    artifactPaths[key] = artifactPath;
  }

  return {
    topic: state.topic,
    state: state.state,
    artifactPaths,
    nextAction: buildNextAction(state.state, artifactPaths),
  };
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

function artifactPathForCompleteDecision(state: AutonomousWorkStateFile): string {
  return state.artifacts?.finalHandoff ?? artifactPathForBlockedDecision(state);
}

function parseAutonomousState(content: string): AutonomousWorkStateFile {
  const parsed = JSON.parse(content) as Partial<AutonomousWorkStateFile>;
  if (typeof parsed.topic !== "string" || parsed.topic.trim() === "") throw new Error("autonomous state requires topic");
  if (!isPiSweLifecycleState(parsed.state)) throw new Error(`unknown autonomous state: ${String(parsed.state)}`);
  return {
    topic: parsed.topic.trim(),
    state: parsed.state,
    activePhase: parsed.activePhase,
    retryCounts: parsed.retryCounts,
    artifacts: parsed.artifacts,
  };
}

function buildNextAction(stage: PiSweLifecycleState, artifactPaths: Record<string, string>): AutonomousNextAction {
  return {
    stage,
    prompt: promptForStage(stage),
    readPaths: readPathsForStage(stage, artifactPaths),
    writePath: writePathForStage(stage, artifactPaths),
    allowedNextStates: [...PI_SWE_LIFECYCLE_TRANSITIONS[stage]],
  };
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

function normalizeArtifactPath(filePath: string): string {
  const normalized = posix.normalize(filePath.trim().replace(/\\+/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) throw new Error(`artifact path must be repository-relative: ${filePath}`);
  return normalized;
}

function assertStableArtifactPath(filePath: string): void {
  if (!/^\.model-artifacts\/(todo|plans|findings|reports|logs|specs)\//.test(filePath)) throw new Error(`unsupported artifact path: ${filePath}`);
}

function assertReadableArtifact(cwd: string, filePath: string): void {
  if (!existsSync(join(cwd, filePath))) throw new Error(`missing artifact: ${filePath}`);
}

function isPiSweLifecycleState(value: unknown): value is PiSweLifecycleState {
  return typeof value === "string" && (PI_SWE_LIFECYCLE_STATES as readonly string[]).includes(value);
}
