import fs from "node:fs";
import path from "node:path";

import {
  createContextSnapshot,
  sourceKindLabel,
  type CompactionStats,
  type ContextGroup,
  type ContextLedgerEntry,
  type ContextSnapshot,
  type ContextSourceKind,
  type TokenConfidence,
} from "../domain/index.ts";
import type { PiContextSessionState } from "./session-state.ts";

export type PiContextReportMode = "summary" | "artifact";
export type PiContextArtifactFormat = "markdown" | "json";

export type PiContextReportRequest = {
  mode: PiContextReportMode;
  artifactFormat: PiContextArtifactFormat;
  groups: ContextSourceKind[];
  help: boolean;
  warnings: string[];
};

export type PiContextReportOptions = {
  capturedAt?: string;
  cwd?: string;
  reportDir?: string;
};

export type PiContextReportArtifact = {
  path: string;
  relativePath: string;
  format: PiContextArtifactFormat;
};

const REPORT_DIR = path.join(".model-artifacts", "todo", "pi-context", "reports");
const GROUP_ALIASES: Record<string, ContextSourceKind> = {
  system: "system",
  user: "user",
  project: "project",
  extension: "extension",
  extensions: "extension",
  session: "session",
  tool: "tool",
  tools: "tool",
  artifact: "discovered",
  artifacts: "discovered",
  discovered: "discovered",
  compaction: "compaction",
  unknown: "unknown",
};

export function parsePiContextReportArgs(args: string): PiContextReportRequest {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const request: PiContextReportRequest = { mode: "summary", artifactFormat: "markdown", groups: [], help: false, warnings: [] };

  for (const token of tokens) {
    if (token === "help" || token === "--help" || token === "-h") {
      request.help = true;
      continue;
    }
    if (token === "summary" || token === "default") {
      request.mode = "summary";
      continue;
    }
    if (token === "open" || token === "artifact" || token === "report") {
      request.mode = "artifact";
      continue;
    }
    if (token === "json" || token === "--json") {
      request.mode = "artifact";
      request.artifactFormat = "json";
      continue;
    }
    if (token === "markdown" || token === "md") {
      request.mode = "artifact";
      request.artifactFormat = "markdown";
      continue;
    }
    const group = GROUP_ALIASES[token];
    if (group) {
      if (!request.groups.includes(group)) request.groups.push(group);
      continue;
    }
    request.warnings.push(`unknown /pi-context option ignored: ${token}`);
  }

  return request;
}

export function createPiContextReportSnapshot(state: PiContextSessionState | undefined, options: PiContextReportOptions = {}): ContextSnapshot {
  if (!state) {
    return createContextSnapshot({
      entries: [],
      capturedAt: options.capturedAt,
      warnings: ["pi-context session ledger is unavailable; no lifecycle hook has initialized it yet"],
    });
  }

  return createContextSnapshot({
    entries: state.ledgerEntries,
    capturedAt: options.capturedAt ?? state.lastUpdatedAt,
    contextWindowTokens: latestContextWindow(state),
    compaction: latestCompactionStats(state.ledgerEntries),
    warnings: state.warnings,
  });
}

export function renderPiContextSummary(snapshot: ContextSnapshot, request: Partial<Pick<PiContextReportRequest, "groups" | "warnings">> = {}): string {
  const groups = filteredGroups(snapshot.groups, request.groups ?? []);
  const lines = [
    "pi-context",
    `Total: ${formatTokens(snapshot.totals.tokenCount, snapshot.totals.tokenConfidence)} (${formatBytes(snapshot.totals.byteCount)})`,
    `Remaining: ${formatRemaining(snapshot)}`,
    `Compaction: ${formatCompaction(snapshot.compaction)}`,
  ];

  if (request.groups?.length) lines.push(`Filters: ${request.groups.map(sourceKindLabel).join(", ")}`);
  lines.push("Breakdown:");
  if (groups.length === 0) lines.push("- no matching ledger entries");
  for (const group of groups) lines.push(`- ${group.label}: ${formatTokens(group.tokenCount, group.tokenConfidence)} (${formatBytes(group.byteCount)}, ${plural(group.entries.length, "entry", "entries")})`);

  const warnings = uniqueStrings([...(snapshot.warnings ?? []), ...(request.warnings ?? [])]);
  if (warnings.length) {
    lines.push("Warnings:");
    for (const warning of warnings.slice(0, 4)) lines.push(`- ${warning}`);
    if (warnings.length > 4) lines.push(`- ${warnings.length - 4} more warning(s) in artifact report`);
  }
  lines.push("Artifacts: /pi-context artifact or /pi-context json");
  return lines.join("\n");
}

export function piContextHelpText(): string {
  return [
    "pi-context",
    "Usage: /pi-context [summary|artifact|json] [system|session|tools|extensions|project|user|artifacts]",
    "summary/default: concise grouped ledger report",
    "artifact/open: write markdown report under .model-artifacts/todo/pi-context/reports/",
    "json: write deterministic JSON report under .model-artifacts/todo/pi-context/reports/",
  ].join("\n");
}

export function writePiContextReportArtifact(snapshot: ContextSnapshot, request: Partial<Pick<PiContextReportRequest, "artifactFormat" | "groups">> = {}, options: PiContextReportOptions = {}): PiContextReportArtifact {
  const format = request.artifactFormat ?? "markdown";
  const cwd = options.cwd ?? process.cwd();
  const relativeDir = options.reportDir ?? REPORT_DIR;
  const dir = path.resolve(cwd, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  const stem = `pi-context-${safeTimestamp(snapshot.capturedAt)}`;
  const relativePath = path.join(relativeDir, `${stem}.${format === "json" ? "json" : "md"}`);
  const filePath = path.resolve(cwd, relativePath);
  const content = format === "json" ? renderPiContextJson(snapshot, request.groups ?? []) : renderPiContextMarkdown(snapshot, request.groups ?? []);
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, relativePath, format };
}

export function renderPiContextMarkdown(snapshot: ContextSnapshot, groups: ContextSourceKind[] = []): string {
  const selectedGroups = filteredGroups(snapshot.groups, groups);
  const lines = [
    "# pi-context report",
    "",
    `Generated: ${snapshot.capturedAt}`,
    "",
    "## Summary",
    "",
    `- Total: ${formatTokens(snapshot.totals.tokenCount, snapshot.totals.tokenConfidence)} (${formatBytes(snapshot.totals.byteCount)})`,
    `- Remaining: ${formatRemaining(snapshot)}`,
    `- Compaction: ${formatCompaction(snapshot.compaction)}`,
    `- Token detail: exact ${formatMaybeNumber(snapshot.totals.exactTokenCount)}, estimated ${formatMaybeNumber(snapshot.totals.estimatedTokenCount)}, unknown entries ${snapshot.totals.unknownTokenEntries}`,
  ];

  if (snapshot.warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of snapshot.warnings) lines.push(`- ${warning}`);
  }

  lines.push("", "## Breakdown", "");
  if (selectedGroups.length === 0) lines.push("No matching ledger entries.");
  for (const group of selectedGroups) {
    lines.push(`### ${group.label}`, "", `- Tokens: ${formatTokens(group.tokenCount, group.tokenConfidence)}`, `- Bytes: ${formatBytes(group.byteCount)}`, `- Entries: ${group.entries.length}`, "");
    for (const entry of group.entries) lines.push(formatEntryMarkdown(entry));
  }

  return `${lines.join("\n")}\n`;
}

export function renderPiContextJson(snapshot: ContextSnapshot, groups: ContextSourceKind[] = []): string {
  const payload = {
    schemaVersion: 1,
    generatedAt: snapshot.capturedAt,
    totals: snapshot.totals,
    remaining: snapshot.remaining,
    compaction: snapshot.compaction,
    warnings: snapshot.warnings,
    groups: filteredGroups(snapshot.groups, groups),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function filteredGroups(allGroups: ContextGroup[], groups: ContextSourceKind[]): ContextGroup[] {
  if (groups.length === 0) return allGroups;
  const selected = new Set(groups);
  return allGroups.filter((group) => selected.has(group.kind));
}

function latestContextWindow(state: PiContextSessionState): number | undefined {
  for (let index = state.usageSnapshots.length - 1; index >= 0; index -= 1) {
    const contextWindow = state.usageSnapshots[index]?.contextWindow;
    if (typeof contextWindow === "number") return contextWindow;
  }
  return state.metadata.contextWindow;
}

function latestCompactionStats(entries: readonly ContextLedgerEntry[]): CompactionStats | undefined {
  const compaction = [...entries].reverse().find((entry) => entry.kind === "compaction" && entry.sourceMetadata?.resourceType === "compaction");
  if (!compaction?.sourceMetadata) return undefined;
  const metadata = compaction.sourceMetadata;
  return {
    beforeTokens: metadata.beforeTokens,
    afterTokens: metadata.afterTokens,
    deltaTokens: metadata.deltaTokens,
    savedTokens: metadata.savedTokens,
    tokenConfidence: compaction.tokenConfidence,
  };
}

function formatEntryMarkdown(entry: ContextLedgerEntry): string {
  const metadata = entry.sourceMetadata ?? {};
  const details = [
    `  - id: \`${entry.id}\``,
    `  - kind: ${entry.kind}`,
    `  - tokens: ${formatTokens(entry.tokenCount, entry.tokenConfidence)}`,
    `  - bytes: ${entry.byteCount}`,
    `  - first seen: ${entry.firstSeenAt}`,
    `  - last seen: ${entry.lastSeenAt}`,
  ];
  if (entry.origin) details.push(`  - origin: ${entry.origin}`);
  if (metadata.displayPath) details.push(`  - path: ${metadata.displayPath}`);
  if (metadata.resourceType) details.push(`  - resource type: ${metadata.resourceType}`);
  if (metadata.status) details.push(`  - status: ${metadata.status}`);
  if (metadata.warning) details.push(`  - warning: ${metadata.warning}`);
  return [`- ${entry.label}`, ...details].join("\n");
}

function formatRemaining(snapshot: ContextSnapshot): string {
  const remaining = snapshot.remaining;
  if (remaining.remainingTokens === undefined || remaining.totalTokens === undefined) return `unknown (${remaining.tokenConfidence})`;
  return `${formatMaybeNumber(remaining.remainingTokens)} of ${formatMaybeNumber(remaining.totalTokens)} tokens ${remaining.tokenConfidence}`;
}

function formatCompaction(compaction: CompactionStats | undefined): string {
  if (!compaction) return "none recorded";
  const saved = compaction.savedTokens === undefined ? "unknown saved" : `${formatMaybeNumber(compaction.savedTokens)} saved`;
  const before = compaction.beforeTokens === undefined ? "unknown" : formatMaybeNumber(compaction.beforeTokens);
  const after = compaction.afterTokens === undefined ? "unknown" : formatMaybeNumber(compaction.afterTokens);
  return `${before} → ${after}, ${saved} (${compaction.tokenConfidence})`;
}

function formatTokens(tokens: number | undefined, confidence: TokenConfidence): string {
  return tokens === undefined ? `unknown tokens (${confidence})` : `${formatMaybeNumber(tokens)} tokens ${confidence}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toLocaleString("en-US");
}

function plural(count: number, singular: string, pluralValue: string): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "") || "unknown-time";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
