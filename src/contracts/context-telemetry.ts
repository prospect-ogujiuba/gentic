export const CONTEXT_TELEMETRY_LIMITS = Object.freeze({
  maxBranchEntriesScanned: 512,
  maxContextFilesScanned: 64,
  maxSkillsScanned: 64,
  maxToolsScanned: 64,
  maxPromptGuidelinesScanned: 64,
  maxContentBlocksPerValue: 64,
  maxMeasuredCharsPerValue: 65_536,
  maxNumericValue: Number.MAX_SAFE_INTEGER,
  maxContributors: 8,
  maxDiagnostics: 4,
} as const);

export type ContextTelemetryContributorKind =
  | "system-prompt"
  | "active-tools"
  | "context-files"
  | "skills"
  | "user-messages"
  | "assistant-messages"
  | "tool-results"
  | "other-session";

/** Contributor values are compatibility estimates until Pi exposes authoritative aggregates. */
export type ContextTelemetryContributorDetail = "degraded" | "unavailable";

export type ContextTelemetryDiagnostic =
  | "usage-unavailable"
  | "prompt-options-unavailable"
  | "branch-unavailable"
  | "branch-truncated"
  | "prompt-options-truncated"
  | "content-truncated"
  | "contributors-degraded"
  | "contributors-truncated";

export type ContextTelemetryUsage = {
  usedTokens?: number;
  contextWindowTokens?: number;
  remainingTokens?: number;
  remainingPercent?: number;
};

export type ContextTelemetryPressure = {
  available: boolean;
  level: "normal" | "warning" | "critical" | "unavailable";
  remainingPercent?: number;
};

export type ContextTelemetryContributor = {
  kind: ContextTelemetryContributorKind;
  itemCount: number;
  byteCount: number;
  tokenCount?: number;
};

export type ContextTelemetryBranch = {
  totalEntries: number;
  scannedEntries: number;
  truncated: boolean;
};

export type ContextTelemetrySnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  usage: ContextTelemetryUsage;
  pressure: ContextTelemetryPressure;
  contributorDetail: ContextTelemetryContributorDetail;
  contributors: ContextTelemetryContributor[];
  branch: ContextTelemetryBranch;
  diagnostics: ContextTelemetryDiagnostic[];
  bounds: typeof CONTEXT_TELEMETRY_LIMITS;
};

/** Registration-free, content-free input accepted by the bounded snapshot service. */
export type ContextTelemetrySnapshotInput = {
  capturedAt?: string;
  usage?: ContextTelemetryUsage;
  pressure?: ContextTelemetryPressure;
  contributorDetail?: ContextTelemetryContributorDetail;
  contributors?: readonly ContextTelemetryContributor[];
  branch?: ContextTelemetryBranch;
  diagnostics?: readonly ContextTelemetryDiagnostic[];
};
