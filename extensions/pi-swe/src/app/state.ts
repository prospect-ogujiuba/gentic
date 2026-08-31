import {
  createSweState,
  recordChangedPath,
  recordInspectedPath,
  recordVerification,
  resetTurnState,
  setActiveInitiative,
  setActivePlan,
  type ActiveInitiative,
  type ActivePlan,
  type CreateSweStateOptions,
  type SweState,
} from "../domain/state.ts";
import type { VerificationEvidence } from "./evidence.ts";

export * from "../domain/state.ts";

export type SweStateClock = () => string;

export type SweStateServiceDependencies = {
  now?: SweStateClock;
};

export type SweStateService = {
  createState(options?: CreateSweStateOptions): SweState;
  resetTurn(state: SweState, turnStartedAt?: string): SweState;
  setActivePlan(state: SweState, activePlan: ActivePlan | undefined): SweState;
  setActiveInitiative(state: SweState, activeInitiative: ActiveInitiative | undefined): SweState;
  recordInspectedPath(state: SweState, filePath: string): SweState;
  recordChangedPath(state: SweState, filePath: string): SweState;
  recordVerification(state: SweState, evidence: VerificationEvidence): SweState;
};

export function createSweStateService(dependencies: SweStateServiceDependencies = {}): SweStateService {
  const now = dependencies.now ?? (() => new Date(0).toISOString());

  return {
    createState(options = {}) {
      return createSweState(options);
    },
    resetTurn(state, turnStartedAt = now()) {
      return resetTurnState(state, turnStartedAt);
    },
    setActivePlan(state, activePlan) {
      return setActivePlan(state, activePlan);
    },
    setActiveInitiative(state, activeInitiative) {
      return setActiveInitiative(state, activeInitiative);
    },
    recordInspectedPath(state, filePath) {
      return recordInspectedPath(state, filePath);
    },
    recordChangedPath(state, filePath) {
      return recordChangedPath(state, filePath);
    },
    recordVerification(state, evidence) {
      return recordVerification(state, evidence);
    },
  };
}
