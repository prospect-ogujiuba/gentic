export type PiSweStage =
  | "plan"
  | "diagnose"
  | "implement"
  | "verify"
  | "review"
  | "finalize"
  | "tdd"
  | "dsa";

export type PiSweState = {
  activeStage?: PiSweStage;
};

export const EMPTY_PI_SWE_STATE: Readonly<PiSweState> = {};
