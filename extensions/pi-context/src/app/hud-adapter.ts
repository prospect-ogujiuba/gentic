import {
  NATIVE_SNAPSHOT_LIMITS,
  type NativeContextSnapshot,
  type NativeContributorKind,
  type NativeSnapshotPressure,
} from "./native-snapshot-contract.ts";
import { sanitizeNativeContextSnapshot } from "./native-snapshot.ts";

export type PiContextPressureStatus = NativeSnapshotPressure;
export type PiContextHudContributor = {
  kind: NativeContributorKind;
  label: string;
  tokenCount?: number;
  byteCount: number;
  tokenConfidence: "estimated";
  itemCount: number;
};
export type PiContextHudGroup = {
  kind: NativeContributorKind;
  label: string;
  tokenCount?: number;
  byteCount: number;
  entryCount: number;
  tokenConfidence: "estimated";
};
export type PiContextHudCompaction = {
  beforeTokens?: number;
  afterTokens?: number;
  savedTokens?: number;
  tokenConfidence: "unknown";
};
export type PiContextHudSnapshot = {
  schemaVersion: 1;
  available: boolean;
  capturedAt: string;
  totalTokens?: number;
  totalBytes: number;
  contextWindowTokens?: number;
  remainingTokens?: number;
  pressure: PiContextPressureStatus;
  /** Pi derives current usage from the last assistant usage plus estimated trailing messages. */
  tokenConfidence: "estimated" | "unknown";
  largestGroup?: PiContextHudGroup;
  recentCompaction?: PiContextHudCompaction;
  contributors: PiContextHudContributor[];
  warnings: string[];
  truncatedWarnings: number;
};
export type PiContextHudSnapshotOptions = {
  capturedAt?: string;
  topContributors?: number;
};

const LABELS: Record<NativeContributorKind, string> = {
  "system-prompt": "System prompt",
  "active-tools": "Active tools",
  "context-files": "Context files",
  skills: "Skills",
  "user-messages": "User messages",
  "assistant-messages": "Assistant messages",
  "tool-results": "Tool results",
  "other-session": "Other session",
};

export function createPiContextHudSnapshot(
  input: NativeContextSnapshot | undefined,
  options: PiContextHudSnapshotOptions = {},
): PiContextHudSnapshot {
  if (!input) return unavailableSnapshot(options.capturedAt);
  const snapshot = sanitizeNativeContextSnapshot(input);
  const limit = clamp(options.topContributors ?? 3, 0, 5);
  const ordered = [...snapshot.contributors].sort((left, right) =>
    (right.tokenCount ?? -1) - (left.tokenCount ?? -1) || right.byteCount - left.byteCount,
  );
  const contributors = ordered.slice(0, limit).map((value) => ({
    kind: value.kind,
    label: LABELS[value.kind],
    tokenCount: value.tokenCount,
    byteCount: value.byteCount,
    tokenConfidence: "estimated" as const,
    itemCount: value.itemCount,
  }));
  const largest = ordered[0];
  return {
    schemaVersion: 1,
    available: true,
    capturedAt: snapshot.capturedAt,
    totalTokens: snapshot.usage.usedTokens,
    totalBytes: snapshot.contributors.reduce((total, value) => total + value.byteCount, 0),
    contextWindowTokens: snapshot.usage.contextWindowTokens,
    remainingTokens: snapshot.usage.remainingTokens,
    pressure: snapshot.pressure,
    tokenConfidence: snapshot.usage.usedTokens === undefined && snapshot.usage.remainingPercent === undefined
      ? "unknown"
      : "estimated",
    largestGroup: largest
      ? {
          kind: largest.kind,
          label: LABELS[largest.kind],
          tokenCount: largest.tokenCount,
          byteCount: largest.byteCount,
          entryCount: largest.itemCount,
          tokenConfidence: "estimated",
        }
      : undefined,
    contributors,
    warnings: snapshot.diagnostics.slice(0, NATIVE_SNAPSHOT_LIMITS.maxDiagnostics),
    truncatedWarnings: Math.max(0, snapshot.diagnostics.length - NATIVE_SNAPSHOT_LIMITS.maxDiagnostics),
  };
}

function unavailableSnapshot(capturedAt: string | undefined): PiContextHudSnapshot {
  const timestamp = typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt))
    ? new Date(capturedAt).toISOString()
    : new Date().toISOString();
  return {
    schemaVersion: 1,
    available: false,
    capturedAt: timestamp,
    totalBytes: 0,
    pressure: { available: false, level: "unavailable" },
    tokenConfidence: "unknown",
    contributors: [],
    warnings: [],
    truncatedWarnings: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
