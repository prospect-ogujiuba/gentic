import { posix } from "node:path";

import type { ContractStatus } from "./contract-graph.ts";
import type { VerificationEvidence } from "./evidence.ts";
import type { PiSweInitiativeState } from "./initiative.ts";

export type PiSweStage =
  | "plan"
  | "diagnose"
  | "implement"
  | "verify"
  | "review"
  | "finalize"
  | "tdd"
  | "dsa";

export type ActivePlanSource = "todo" | "artifact" | "prompt";

export type ActivePlan = {
  source: ActivePlanSource;
  marker: string;
};

export type ActiveInitiative = {
  topic: string;
  manifestPath: string;
  manifestSchemaVersion: number;
  planRevision: number;
  planPath: string;
  contractId?: string;
  contractPath?: string;
  lifecycle: {
    initiativeState: PiSweInitiativeState;
    contractStatus?: ContractStatus;
  };
  gates: {
    readyIds: string[];
    blockerCodes: string[];
  };
};

export type SweState = {
  turnStartedAt: string;
  /** Legacy/advisory marker. This never represents canonical approval. */
  activePlan?: ActivePlan;
  activeInitiative?: ActiveInitiative;
  inspectedPaths: string[];
  changedPaths: string[];
  verification: VerificationEvidence[];
};

export type PiSweState = SweState & {
  activeStage?: PiSweStage;
};

export type CreateSweStateOptions = {
  turnStartedAt?: string;
  activePlan?: ActivePlan;
  activeInitiative?: ActiveInitiative;
};

export const EMPTY_PI_SWE_STATE: Readonly<PiSweState> = Object.freeze(createSweState());

export function createSweState(options: CreateSweStateOptions = {}): SweState {
  return {
    turnStartedAt: options.turnStartedAt ?? new Date(0).toISOString(),
    activePlan: options.activePlan ? normalizeActivePlan(options.activePlan) : undefined,
    activeInitiative: options.activeInitiative ? normalizeActiveInitiative(options.activeInitiative) : undefined,
    inspectedPaths: [],
    changedPaths: [],
    verification: [],
  };
}

export function resetTurnState(state: SweState, turnStartedAt = new Date(0).toISOString()): SweState {
  return {
    ...state,
    turnStartedAt,
    inspectedPaths: [],
    changedPaths: [],
    verification: [],
  };
}

export function setActivePlan(state: SweState, activePlan: ActivePlan | undefined): SweState {
  return {
    ...state,
    activePlan: activePlan ? normalizeActivePlan(activePlan) : undefined,
  };
}

export function setActiveInitiative(state: SweState, activeInitiative: ActiveInitiative | undefined): SweState {
  return {
    ...state,
    activeInitiative: activeInitiative ? normalizeActiveInitiative(activeInitiative) : undefined,
  };
}

export function recordInspectedPath(state: SweState, filePath: string): SweState {
  return {
    ...state,
    inspectedPaths: addNormalizedPath(state.inspectedPaths, filePath),
  };
}

export function recordChangedPath(state: SweState, filePath: string): SweState {
  return {
    ...state,
    changedPaths: addNormalizedPath(state.changedPaths, filePath),
  };
}

export function recordVerification(state: SweState, evidence: VerificationEvidence): SweState {
  return {
    ...state,
    verification: [...state.verification, { ...evidence }],
  };
}

export function normalizeSwePath(filePath: string): string {
  const normalizedSeparators = filePath.trim().replace(/\\+/g, "/");
  if (normalizedSeparators === "") return ".";
  const normalized = posix.normalize(normalizedSeparators);
  if (normalized === ".") return ".";
  return normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
}

function addNormalizedPath(paths: readonly string[], filePath: string): string[] {
  const normalized = normalizeSwePath(filePath);
  return paths.includes(normalized) ? [...paths] : [...paths, normalized];
}

function normalizeActivePlan(activePlan: ActivePlan): ActivePlan {
  return {
    source: activePlan.source,
    marker: activePlan.marker.trim(),
  };
}

function normalizeActiveInitiative(active: ActiveInitiative): ActiveInitiative {
  return {
    topic: active.topic.trim(),
    manifestPath: normalizeSwePath(active.manifestPath),
    manifestSchemaVersion: active.manifestSchemaVersion,
    planRevision: active.planRevision,
    planPath: normalizeSwePath(active.planPath),
    ...(active.contractId?.trim() && active.contractPath ? { contractId: active.contractId.trim(), contractPath: normalizeSwePath(active.contractPath) } : {}),
    lifecycle: { ...active.lifecycle },
    gates: {
      readyIds: [...new Set(active.gates.readyIds.map((id) => id.trim()).filter(Boolean))],
      blockerCodes: [...new Set(active.gates.blockerCodes.map((code) => code.trim()).filter(Boolean))],
    },
  };
}
