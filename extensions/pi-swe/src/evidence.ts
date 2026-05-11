export type VerificationScope = "focused" | "nearby" | "broad" | "manual";

export type VerificationEvidence = {
  kind: "command" | "note";
  command?: string;
  note?: string;
  exitCode?: number;
  scope: VerificationScope;
  timestamp: string;
};

export type PiSweEvidenceRef = {
  type: string;
  summary?: string;
};

export const NO_PI_SWE_EVIDENCE: readonly PiSweEvidenceRef[] = [];

export function createVerificationEvidence(evidence: Omit<VerificationEvidence, "timestamp"> & { timestamp?: string }): VerificationEvidence {
  return {
    ...evidence,
    timestamp: evidence.timestamp ?? new Date(0).toISOString(),
  };
}
