import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Command-only Pi APIs required to build a fresh snapshot. */
export type NativeSnapshotContext = Pick<
  ExtensionCommandContext,
  "getContextUsage" | "getSystemPromptOptions" | "sessionManager"
>;

export const NATIVE_SNAPSHOT_LIMITS = Object.freeze({
  maxBranchEntriesScanned: 512,
  maxContextFilesScanned: 64,
  maxSkillsScanned: 64,
  maxToolsScanned: 64,
  maxPromptGuidelinesScanned: 64,
  maxContentBlocksPerValue: 64,
  maxObjectPropertiesPerValue: 32,
  maxValueNodesScanned: 256,
  maxValueDepth: 4,
  maxMeasuredCharsPerValue: 65_536,
  maxContributors: 8,
  maxDiagnostics: 4,
} as const);

export const NATIVE_SNAPSHOT_SOURCES = Object.freeze([
  "ctx.getContextUsage()",
  "ctx.getSystemPromptOptions()",
  "ctx.sessionManager.getBranch()",
] as const);

/** These high-frequency observations are deliberately outside the native snapshot design. */
export const EXCLUDED_RUNTIME_LEDGER_EVENTS = Object.freeze([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result",
] as const);

export type NativeContributorKind =
  | "system-prompt"
  | "active-tools"
  | "context-files"
  | "skills"
  | "user-messages"
  | "assistant-messages"
  | "tool-results"
  | "other-session";

export type NativeSnapshotDiagnostic =
  | "usage-unavailable"
  | "prompt-options-unavailable"
  | "branch-unavailable"
  | "branch-truncated"
  | "prompt-options-truncated"
  | "content-truncated"
  | "contributors-truncated";

export type NativeSnapshotPressure = {
  available: boolean;
  level: "normal" | "warning" | "critical" | "unavailable";
  remainingPercent?: number;
};

export type NativeSnapshotContributor = {
  kind: NativeContributorKind;
  itemCount: number;
  byteCount: number;
  tokenCount?: number;
};

export type NativeContextSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  usage: {
    usedTokens?: number;
    contextWindowTokens?: number;
    remainingTokens?: number;
    remainingPercent?: number;
  };
  pressure: NativeSnapshotPressure;
  contributors: NativeSnapshotContributor[];
  branch: {
    totalEntries: number;
    scannedEntries: number;
    truncated: boolean;
  };
  diagnostics: NativeSnapshotDiagnostic[];
  bounds: typeof NATIVE_SNAPSHOT_LIMITS;
};
