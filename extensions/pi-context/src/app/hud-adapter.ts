import { sourceKindLabel, type ContextLedgerEntry, type ContextSnapshot, type ContextSourceKind, type TokenConfidence } from "../domain/index.ts";
import type { PiContextSessionState } from "./session-state.ts";
import { createPiContextReportSnapshot } from "./report.ts";

export type PiContextHudContributor = {
  kind: ContextSourceKind;
  label: string;
  tokenCount?: number;
  byteCount: number;
  tokenConfidence: TokenConfidence;
  pathCount?: number;
};

export type PiContextHudGroup = {
  kind: ContextSourceKind;
  label: string;
  tokenCount?: number;
  byteCount: number;
  entryCount: number;
  tokenConfidence: TokenConfidence;
};

export type PiContextHudCompaction = {
  beforeTokens?: number;
  afterTokens?: number;
  savedTokens?: number;
  tokenConfidence: TokenConfidence;
};

export type PiContextHudSnapshot = {
  schemaVersion: 1;
  available: boolean;
  capturedAt: string;
  totalTokens?: number;
  totalBytes: number;
  contextWindowTokens?: number;
  remainingTokens?: number;
  tokenConfidence: TokenConfidence;
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

const DEFAULT_TOP_CONTRIBUTORS = 3;
const MAX_TOP_CONTRIBUTORS = 5;
const MAX_WARNINGS = 3;

export function createPiContextHudSnapshot(state: PiContextSessionState | undefined, options: PiContextHudSnapshotOptions = {}): PiContextHudSnapshot {
  const snapshot = createPiContextReportSnapshot(state, { capturedAt: options.capturedAt });
  const topContributors = clampTopContributors(options.topContributors ?? DEFAULT_TOP_CONTRIBUTORS);
  const warnings = snapshot.warnings.slice(0, MAX_WARNINGS);

  return {
    schemaVersion: 1,
    available: Boolean(state?.active),
    capturedAt: snapshot.capturedAt,
    totalTokens: snapshot.totals.tokenCount,
    totalBytes: snapshot.totals.byteCount,
    contextWindowTokens: snapshot.remaining.totalTokens,
    remainingTokens: snapshot.remaining.remainingTokens,
    tokenConfidence: snapshot.totals.tokenConfidence,
    largestGroup: largestGroup(snapshot),
    recentCompaction: snapshot.compaction
      ? {
          beforeTokens: snapshot.compaction.beforeTokens,
          afterTokens: snapshot.compaction.afterTokens,
          savedTokens: snapshot.compaction.savedTokens,
          tokenConfidence: snapshot.compaction.tokenConfidence,
        }
      : undefined,
    contributors: topContributors === 0 ? [] : largestContributors(snapshot, topContributors),
    warnings,
    truncatedWarnings: Math.max(0, snapshot.warnings.length - warnings.length),
  };
}

function largestGroup(snapshot: ContextSnapshot): PiContextHudGroup | undefined {
  const group = [...snapshot.groups].sort((a, b) => compareSized(b.tokenCount, b.byteCount, a.tokenCount, a.byteCount))[0];
  if (!group) return undefined;
  return {
    kind: group.kind,
    label: group.label,
    tokenCount: group.tokenCount,
    byteCount: group.byteCount,
    entryCount: group.entries.length,
    tokenConfidence: group.tokenConfidence,
  };
}

function largestContributors(snapshot: ContextSnapshot, limit: number): PiContextHudContributor[] {
  return snapshot.groups
    .flatMap((group) => group.entries)
    .sort((a, b) => compareSized(b.tokenCount, b.byteCount, a.tokenCount, a.byteCount))
    .slice(0, limit)
    .map((entry) => ({
      kind: entry.kind,
      label: safeContributorLabel(entry),
      tokenCount: entry.tokenCount,
      byteCount: entry.byteCount,
      tokenConfidence: entry.tokenConfidence,
      pathCount: entry.sourceMetadata?.pathCount,
    }));
}

function safeContributorLabel(entry: ContextLedgerEntry): string {
  const metadata = entry.sourceMetadata;
  if (metadata?.toolName) return `tool:${metadata.toolName}`;
  if (metadata?.operation) return `${sourceKindLabel(entry.kind)} ${metadata.operation}`;
  if (entry.kind === "discovered" || entry.kind === "artifact" || metadata?.displayPath || entry.origin) return sourceKindLabel(entry.kind);
  if (entry.redaction?.redacted && /[/\\]|\b(prompt|args?|content|preview|path)\b/i.test(entry.label)) return sourceKindLabel(entry.kind);
  return entry.label.slice(0, 40);
}

function compareSized(leftTokens: number | undefined, leftBytes: number, rightTokens: number | undefined, rightBytes: number): number {
  return (leftTokens ?? -1) - (rightTokens ?? -1) || leftBytes - rightBytes;
}

function clampTopContributors(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TOP_CONTRIBUTORS;
  return Math.max(0, Math.min(MAX_TOP_CONTRIBUTORS, Math.floor(value)));
}
