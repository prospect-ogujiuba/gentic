import type {
  CompactionStats,
  ContextGroup,
  ContextLedgerEntry,
  ContextLedgerEntryInput,
  ContextSnapshot,
  ContextSourceKind,
  ContextTotals,
  ContextWindow,
  TokenConfidence,
} from "./types.ts";

const SOURCE_ORDER: ContextSourceKind[] = ["system", "user", "project", "extension", "session", "tool", "artifact", "discovered", "compaction", "unknown"];
const SOURCE_LABELS: Record<ContextSourceKind, string> = {
  system: "System",
  user: "User",
  project: "Project",
  extension: "Extensions",
  session: "Session",
  tool: "Tools",
  artifact: "Discovered/Artifacts",
  discovered: "Discovered/Artifacts",
  compaction: "Compaction",
  unknown: "Unknown",
};

export function sourceKindLabel(kind: ContextSourceKind): string {
  return SOURCE_LABELS[kind] ?? SOURCE_LABELS.unknown;
}

export function estimateTokens(input: string | number): number {
  const bytes = typeof input === "number" ? Math.max(0, input) : byteLength(input);
  return Math.ceil(bytes / 4);
}

export function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function normalizeLedgerEntry(input: ContextLedgerEntryInput): ContextLedgerEntry {
  const seenAt = input.seenAt ?? input.lastSeenAt ?? input.firstSeenAt ?? new Date(0).toISOString();
  const byteCount = Math.max(0, input.byteCount ?? (input.content === undefined ? 0 : byteLength(input.content)));
  const tokenConfidence = input.tokenConfidence ?? (input.tokenCount === undefined ? "estimated" : "exact");
  const tokenCount = input.tokenCount ?? (tokenConfidence === "unknown" ? undefined : estimateTokens(byteCount));
  return {
    id: input.id,
    kind: input.kind ?? "unknown",
    label: input.label ?? input.id,
    origin: input.origin,
    byteCount,
    tokenCount,
    tokenConfidence,
    firstSeenAt: input.firstSeenAt ?? seenAt,
    lastSeenAt: input.lastSeenAt ?? seenAt,
    turnIds: uniqueStrings([...(input.turnIds ?? []), input.turnId]),
    messageIds: uniqueStrings([...(input.messageIds ?? []), input.messageId]),
    toolCallIds: uniqueStrings([...(input.toolCallIds ?? []), input.toolCallId]),
    redaction: input.redaction,
    sourceMetadata: input.sourceMetadata,
  };
}

export function upsertLedgerEntry(entries: ContextLedgerEntry[], input: ContextLedgerEntryInput): ContextLedgerEntry[] {
  const next = normalizeLedgerEntry(input);
  const existingIndex = entries.findIndex((entry) => entry.id === next.id);
  if (existingIndex === -1) return stableSortEntries([...entries, next]);

  const merged = mergeLedgerEntries(entries[existingIndex]!, next);
  return stableSortEntries(entries.map((entry, index) => (index === existingIndex ? merged : entry)));
}

export function mergeLedgerEntries(previous: ContextLedgerEntry, next: ContextLedgerEntry): ContextLedgerEntry {
  const tokenConfidence = mergeTokenConfidence(previous.tokenConfidence, next.tokenConfidence);
  const tokenCount = mergeTokenCount(previous, next, tokenConfidence);
  return {
    ...previous,
    ...next,
    kind: next.kind === "unknown" ? previous.kind : next.kind,
    label: next.label || previous.label,
    origin: next.origin ?? previous.origin,
    byteCount: next.byteCount,
    tokenCount,
    tokenConfidence,
    firstSeenAt: minIso(previous.firstSeenAt, next.firstSeenAt),
    lastSeenAt: maxIso(previous.lastSeenAt, next.lastSeenAt),
    turnIds: uniqueStrings([...previous.turnIds, ...next.turnIds]),
    messageIds: uniqueStrings([...previous.messageIds, ...next.messageIds]),
    toolCallIds: uniqueStrings([...previous.toolCallIds, ...next.toolCallIds]),
    redaction: next.redaction ?? previous.redaction,
    sourceMetadata: { ...previous.sourceMetadata, ...next.sourceMetadata },
  };
}

export function stableSortEntries(entries: ContextLedgerEntry[]): ContextLedgerEntry[] {
  return [...entries].sort((a, b) => {
    const byKind = SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind);
    if (byKind) return byKind;
    const byLabel = a.label.localeCompare(b.label);
    if (byLabel) return byLabel;
    const byOrigin = (a.origin ?? "").localeCompare(b.origin ?? "");
    if (byOrigin) return byOrigin;
    return a.id.localeCompare(b.id);
  });
}

export function groupLedgerEntries(entries: ContextLedgerEntry[]): ContextGroup[] {
  const groups = new Map<string, ContextLedgerEntry[]>();
  for (const entry of stableSortEntries(entries)) {
    const groupKind = entry.kind === "artifact" ? "discovered" : entry.kind;
    const key = groupKind;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([kind, groupEntries]) => {
      const totals = calculateTotals(groupEntries);
      const groupKind = kind as ContextSourceKind;
      return {
        kind: groupKind,
        label: sourceKindLabel(groupKind),
        entries: groupEntries,
        byteCount: totals.byteCount,
        tokenCount: totals.tokenCount,
        tokenConfidence: totals.tokenConfidence,
      } satisfies ContextGroup;
    })
    .sort((a, b) => SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind));
}

export function calculateTotals(entries: readonly ContextLedgerEntry[]): ContextTotals {
  let byteCount = 0;
  let exactTokenCount = 0;
  let estimatedTokenCount = 0;
  let unknownTokenEntries = 0;

  for (const entry of entries) {
    byteCount += entry.byteCount;
    if (entry.tokenCount === undefined || entry.tokenConfidence === "unknown") {
      unknownTokenEntries += 1;
    } else if (entry.tokenConfidence === "exact") {
      exactTokenCount += entry.tokenCount;
    } else {
      estimatedTokenCount += entry.tokenCount;
    }
  }

  const knownTokenCount = exactTokenCount + estimatedTokenCount;
  return {
    byteCount,
    tokenCount: unknownTokenEntries && knownTokenCount === 0 ? undefined : knownTokenCount,
    exactTokenCount,
    estimatedTokenCount,
    unknownTokenEntries,
    tokenConfidence: aggregateConfidence(exactTokenCount, estimatedTokenCount, unknownTokenEntries),
  };
}

export function calculateRemainingContext(contextWindowTokens: number | undefined, totals: ContextTotals): ContextWindow {
  if (contextWindowTokens === undefined || totals.tokenCount === undefined) {
    return { totalTokens: contextWindowTokens, usedTokens: totals.tokenCount, remainingTokens: undefined, tokenConfidence: totals.tokenConfidence === "unknown" ? "unknown" : "estimated" };
  }
  return {
    totalTokens: contextWindowTokens,
    usedTokens: totals.tokenCount,
    remainingTokens: Math.max(0, contextWindowTokens - totals.tokenCount),
    tokenConfidence: totals.tokenConfidence,
  };
}

export function calculateCompactionStats(beforeTokens?: number, afterTokens?: number, confidence: TokenConfidence = "exact"): CompactionStats {
  const deltaTokens = beforeTokens === undefined || afterTokens === undefined ? undefined : afterTokens - beforeTokens;
  const savedTokens = deltaTokens === undefined ? undefined : Math.max(0, -deltaTokens);
  return { beforeTokens, afterTokens, deltaTokens, savedTokens, tokenConfidence: beforeTokens === undefined || afterTokens === undefined ? "unknown" : confidence };
}

export function createContextSnapshot(input: {
  entries: ContextLedgerEntry[];
  capturedAt?: string;
  contextWindowTokens?: number;
  compaction?: CompactionStats;
  warnings?: string[];
}): ContextSnapshot {
  const entries = stableSortEntries(input.entries);
  const totals = calculateTotals(entries);
  const warnings = [...(input.warnings ?? [])];
  if (totals.estimatedTokenCount > 0) warnings.push("token totals include deterministic estimates");
  if (totals.unknownTokenEntries > 0) warnings.push("some entries have unknown token counts");
  if (input.contextWindowTokens === undefined) warnings.push("context window is unknown");
  return {
    capturedAt: input.capturedAt ?? new Date(0).toISOString(),
    totals,
    remaining: calculateRemainingContext(input.contextWindowTokens, totals),
    contextWindowTokens: input.contextWindowTokens,
    compaction: input.compaction,
    groups: groupLedgerEntries(entries),
    warnings: uniqueStrings(warnings),
  };
}

function mergeTokenCount(previous: ContextLedgerEntry, next: ContextLedgerEntry, confidence: TokenConfidence): number | undefined {
  if (confidence === "unknown") return undefined;
  if (next.tokenCount !== undefined) return next.tokenCount;
  if (previous.tokenCount !== undefined && next.byteCount === previous.byteCount) return previous.tokenCount;
  return estimateTokens(next.byteCount);
}

function mergeTokenConfidence(previous: TokenConfidence, next: TokenConfidence): TokenConfidence {
  if (next === "exact") return "exact";
  if (previous === "exact" && next === "estimated") return "estimated";
  if (next === "unknown") return previous === "unknown" ? "unknown" : previous;
  return next;
}

function aggregateConfidence(exact: number, estimated: number, unknown: number): TokenConfidence {
  if (unknown > 0 && exact === 0 && estimated === 0) return "unknown";
  if (estimated > 0 || unknown > 0) return "estimated";
  return "exact";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}
