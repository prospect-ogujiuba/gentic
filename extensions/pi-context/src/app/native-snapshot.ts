import {
  createContextTelemetrySnapshot,
  sanitizeContextTelemetrySnapshot,
} from "../../../../src/services/context-telemetry.ts";
import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  evaluateContextPressure,
  type ContextPressurePolicy,
} from "../domain/index.ts";
import {
  NATIVE_SNAPSHOT_LIMITS,
  type NativeContextSnapshot,
  type NativeContributorDetail,
  type NativeContributorKind,
  type NativeSnapshotContext,
  type NativeSnapshotContributor,
  type NativeSnapshotDiagnostic,
  type NativeSnapshotPressure,
} from "./native-snapshot-contract.ts";

export type CreateNativeContextSnapshotOptions = {
  capturedAt?: string;
  pressurePolicy?: ContextPressurePolicy;
  collectContributors?: boolean;
};

const CONTRIBUTOR_ORDER: NativeContributorKind[] = [
  "system-prompt",
  "active-tools",
  "context-files",
  "skills",
  "user-messages",
  "assistant-messages",
  "tool-results",
  "other-session",
];
const CONTRIBUTOR_LABELS: Record<NativeContributorKind, string> = {
  "system-prompt": "System prompt",
  "active-tools": "Active tools",
  "context-files": "Context files",
  skills: "Skills",
  "user-messages": "User messages",
  "assistant-messages": "Assistant messages",
  "tool-results": "Tool results",
  "other-session": "Other session",
};

type MutableContributor = { itemCount: number; byteCount: number };
type Measurement = { byteCount: number; truncated: boolean };
type ContributorCollection = {
  detail: NativeContributorDetail;
  contributors: NativeSnapshotContributor[];
  totalEntries: number;
  scannedEntries: number;
};

/** Adapt current Pi command APIs into the package-level aggregate telemetry contract. */
export function createNativeContextSnapshot(
  ctx: NativeSnapshotContext,
  options: CreateNativeContextSnapshotOptions = {},
): NativeContextSnapshot {
  const diagnostics: NativeSnapshotDiagnostic[] = [];
  const usageSource = safely(() => ctx.getContextUsage());
  const usage = readUsage(usageSource.value);
  if (
    !usageSource.ok
    || !usageSource.value
    || (usage.usedTokens === undefined && usage.contextWindowTokens === undefined && usage.remainingPercent === undefined)
  ) addDiagnostic(diagnostics, "usage-unavailable");

  const collected = options.collectContributors === false
    ? emptyCollection()
    : collectNativeContributors(ctx, diagnostics);
  const contributorDiagnostics = collected.detail === "degraded"
    ? ["contributors-degraded" as const, ...diagnostics]
    : diagnostics;

  return createContextTelemetrySnapshot({
    capturedAt: options.capturedAt,
    usage,
    pressure: pressureFromUsage(usage, options.pressurePolicy ?? DEFAULT_CONTEXT_PRESSURE_POLICY),
    contributorDetail: collected.detail,
    contributors: collected.contributors,
    branch: {
      totalEntries: collected.totalEntries,
      scannedEntries: collected.scannedEntries,
      truncated: collected.totalEntries > collected.scannedEntries,
    },
    diagnostics: contributorDiagnostics,
  });
}

export function renderNativeContextSummary(input: NativeContextSnapshot): string {
  const snapshot = sanitizeNativeContextSnapshot(input);
  const usage = snapshot.usage;
  const lines = [
    "pi-context",
    `Context: ${formatUsage(usage.usedTokens, usage.contextWindowTokens)}`,
    `Remaining: ${formatRemaining(usage.remainingTokens, usage.contextWindowTokens, usage.remainingPercent)}`,
    `Pressure: ${formatPressure(snapshot.pressure)}`,
    `Contributor detail: ${snapshot.contributorDetail}`,
    "Contributors:",
  ];
  if (snapshot.contributors.length === 0) lines.push("- none available");
  for (const contributor of snapshot.contributors) {
    lines.push(
      `- ${CONTRIBUTOR_LABELS[contributor.kind]}: ${formatNumber(contributor.tokenCount)} estimated tokens (${formatNumber(contributor.byteCount)} B, ${plural(contributor.itemCount, "item")})`,
    );
  }
  if (snapshot.branch.truncated) {
    lines.push(`Active branch: newest ${formatNumber(snapshot.branch.scannedEntries)} of ${formatNumber(snapshot.branch.totalEntries)} entries scanned`);
  }
  if (snapshot.diagnostics.length) lines.push(`Diagnostics: ${snapshot.diagnostics.join(", ")}`);
  return lines.join("\n");
}

export function sanitizeNativeContextSnapshot(input: NativeContextSnapshot): NativeContextSnapshot {
  return sanitizeContextTelemetrySnapshot(input);
}

function collectNativeContributors(
  ctx: NativeSnapshotContext,
  diagnostics: NativeSnapshotDiagnostic[],
): ContributorCollection {
  const contributors = new Map<NativeContributorKind, MutableContributor>();
  let sourceAvailable = false;
  let totalEntries = 0;
  let scannedEntries = 0;

  const promptSource = safely(() => ctx.getSystemPromptOptions());
  const promptOptions = promptSource.ok ? record(promptSource.value) : undefined;
  if (!promptOptions) addDiagnostic(diagnostics, "prompt-options-unavailable");
  else {
    sourceAvailable = true;
    collectPromptContributors(promptOptions, contributors, diagnostics);
  }

  const branchSource = safely(() => ctx.sessionManager.getBranch());
  const branch = branchSource.ok && safely(() => Array.isArray(branchSource.value)).value === true
    ? branchSource.value as unknown[]
    : undefined;
  const branchLength = branch ? arrayLength(branch) : undefined;
  if (!branch || branchLength === undefined) addDiagnostic(diagnostics, "branch-unavailable");
  else {
    sourceAvailable = true;
    totalEntries = branchLength;
    const first = Math.max(0, totalEntries - NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned);
    scannedEntries = totalEntries - first;
    if (first > 0) addDiagnostic(diagnostics, "branch-truncated");
    for (let index = first; index < totalEntries; index += 1) {
      const entry = safely(() => branch[index]);
      if (entry.ok) collectBranchContributor(entry.value, contributors, diagnostics);
      else addDiagnostic(diagnostics, "content-truncated");
    }
  }

  const publicContributors = CONTRIBUTOR_ORDER.flatMap((kind) => {
    const value = contributors.get(kind);
    return value ? [{
      kind,
      itemCount: value.itemCount,
      byteCount: value.byteCount,
      tokenCount: Math.ceil(value.byteCount / 4),
    }] : [];
  }).slice(0, NATIVE_SNAPSHOT_LIMITS.maxContributors);

  return {
    detail: sourceAvailable ? "degraded" : "unavailable",
    contributors: publicContributors,
    totalEntries,
    scannedEntries,
  };
}

function collectPromptContributors(
  options: Record<string, unknown>,
  contributors: Map<NativeContributorKind, MutableContributor>,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  addText(contributors, "system-prompt", safeProperty(options, "customPrompt", diagnostics), diagnostics);
  addText(contributors, "system-prompt", safeProperty(options, "appendSystemPrompt", diagnostics), diagnostics);
  collectArray(safeProperty(options, "promptGuidelines", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxPromptGuidelinesScanned, (item) => {
    addText(contributors, "system-prompt", item, diagnostics);
  }, diagnostics);

  const snippets = record(safeProperty(options, "toolSnippets", diagnostics));
  collectArray(safeProperty(options, "selectedTools", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxToolsScanned, (item) => {
    const snippet = typeof item === "string" && snippets ? safeProperty(snippets, item, diagnostics) : undefined;
    addStrings(contributors, "active-tools", [item, snippet], diagnostics);
  }, diagnostics);

  collectArray(safeProperty(options, "contextFiles", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxContextFilesScanned, (item) => {
    const contextFile = record(item);
    addText(contributors, "context-files", contextFile ? safeProperty(contextFile, "content", diagnostics) : undefined, diagnostics, true);
  }, diagnostics);

  collectArray(safeProperty(options, "skills", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxSkillsScanned, (item) => {
    const skill = record(item);
    addStrings(contributors, "skills", skill
      ? [safeProperty(skill, "name", diagnostics), safeProperty(skill, "description", diagnostics)]
      : [], diagnostics, true);
  }, diagnostics);
}

function collectBranchContributor(
  value: unknown,
  contributors: Map<NativeContributorKind, MutableContributor>,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  const entry = record(value);
  if (!entry) {
    addContent(contributors, "other-session", undefined, diagnostics, true);
    return;
  }
  const type = safeProperty(entry, "type", diagnostics);
  if (type === "message") {
    const message = record(safeProperty(entry, "message", diagnostics));
    const role = message ? safeProperty(message, "role", diagnostics) : undefined;
    const content = message ? safeProperty(message, "content", diagnostics) : undefined;
    addContent(contributors, messageKind(role), content, diagnostics, true);
    return;
  }
  if (type === "custom_message") {
    addContent(contributors, "other-session", safeProperty(entry, "content", diagnostics), diagnostics, true);
    return;
  }
  if (type === "compaction" || type === "branch_summary") {
    addText(contributors, "other-session", safeProperty(entry, "summary", diagnostics), diagnostics, true);
    return;
  }
  addContent(contributors, "other-session", undefined, diagnostics, true);
}

function messageKind(role: unknown): NativeContributorKind {
  if (role === "user") return "user-messages";
  if (role === "assistant") return "assistant-messages";
  if (role === "toolResult" || role === "tool") return "tool-results";
  return "other-session";
}

function collectArray(
  value: unknown,
  limit: number,
  visit: (item: unknown) => void,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  if (safely(() => Array.isArray(value)).value !== true) return;
  const array = value as unknown[];
  const length = arrayLength(array);
  if (length === undefined) {
    addDiagnostic(diagnostics, "content-truncated");
    return;
  }
  for (let index = 0; index < Math.min(length, limit); index += 1) {
    const item = safely(() => array[index]);
    if (item.ok) visit(item.value);
    else addDiagnostic(diagnostics, "content-truncated");
  }
  if (length > limit) addDiagnostic(diagnostics, "prompt-options-truncated");
}

function addText(
  contributors: Map<NativeContributorKind, MutableContributor>,
  kind: NativeContributorKind,
  value: unknown,
  diagnostics: NativeSnapshotDiagnostic[],
  countAbsent = false,
): void {
  if (value === undefined && !countAbsent) return;
  addMeasurement(contributors, kind, measureText(value), diagnostics);
}

function addStrings(
  contributors: Map<NativeContributorKind, MutableContributor>,
  kind: NativeContributorKind,
  values: readonly unknown[],
  diagnostics: NativeSnapshotDiagnostic[],
  countAbsent = false,
): void {
  if (values.length === 0 && !countAbsent) return;
  let remaining = NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue;
  let byteCount = 0;
  let truncated = false;
  for (const value of values) {
    const measured = measureText(value, remaining);
    byteCount += measured.byteCount;
    remaining -= measured.charCount;
    truncated ||= measured.truncated;
  }
  addMeasurement(contributors, kind, { byteCount, truncated }, diagnostics);
}

function addContent(
  contributors: Map<NativeContributorKind, MutableContributor>,
  kind: NativeContributorKind,
  value: unknown,
  diagnostics: NativeSnapshotDiagnostic[],
  countAbsent = false,
): void {
  if (value === undefined && !countAbsent) return;
  addMeasurement(contributors, kind, measureContent(value), diagnostics);
}

function addMeasurement(
  contributors: Map<NativeContributorKind, MutableContributor>,
  kind: NativeContributorKind,
  measurement: Measurement,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  const aggregate = contributors.get(kind) ?? { itemCount: 0, byteCount: 0 };
  aggregate.itemCount += 1;
  aggregate.byteCount += measurement.byteCount;
  contributors.set(kind, aggregate);
  if (measurement.truncated) addDiagnostic(diagnostics, "content-truncated");
}

function measureContent(value: unknown): Measurement {
  if (typeof value === "string") return measureText(value);
  if (safely(() => Array.isArray(value)).value !== true) {
    return { byteCount: 0, truncated: value !== undefined && value !== null };
  }
  const blocks = value as unknown[];
  const length = arrayLength(blocks);
  if (length === undefined) return { byteCount: 0, truncated: true };
  let remaining = NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue;
  let byteCount = 0;
  let truncated = length > NATIVE_SNAPSHOT_LIMITS.maxContentBlocksPerValue;
  for (let index = 0; index < Math.min(length, NATIVE_SNAPSHOT_LIMITS.maxContentBlocksPerValue); index += 1) {
    const block = safely(() => blocks[index]);
    if (!block.ok) {
      truncated = true;
      continue;
    }
    const text = typeof block.value === "string"
      ? block.value
      : record(block.value)
        ? safeProperty(record(block.value)!, "text", [])
        : undefined;
    if (typeof text !== "string") {
      truncated ||= block.value !== undefined && block.value !== null;
      continue;
    }
    const measured = measureText(text, remaining);
    byteCount += measured.byteCount;
    remaining -= measured.charCount;
    truncated ||= measured.truncated;
  }
  return { byteCount, truncated };
}

function measureText(value: unknown, limit = NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue): Measurement & { charCount: number } {
  if (typeof value !== "string") return { byteCount: 0, charCount: 0, truncated: value !== undefined && value !== null };
  const measured = value.slice(0, Math.max(0, limit));
  return {
    byteCount: new TextEncoder().encode(measured).byteLength,
    charCount: measured.length,
    truncated: measured.length < value.length,
  };
}

function readUsage(value: unknown): NativeContextSnapshot["usage"] {
  const usage = record(value) ?? {};
  const usedTokens = nonNegativeNumber(propertyValue(usage, "tokens"));
  const contextWindowTokens = positiveNumber(propertyValue(usage, "contextWindow"));
  const usedPercent = finiteNumber(propertyValue(usage, "percent"));
  const remainingTokens = usedTokens === undefined || contextWindowTokens === undefined
    ? undefined
    : Math.max(0, contextWindowTokens - usedTokens);
  const remainingPercent = usedTokens !== undefined && contextWindowTokens !== undefined
    ? clampPercent(100 - ((usedTokens / contextWindowTokens) * 100))
    : usedPercent === undefined ? undefined : clampPercent(100 - usedPercent);
  return { usedTokens, contextWindowTokens, remainingTokens, remainingPercent };
}

function pressureFromUsage(
  usage: NativeContextSnapshot["usage"],
  policy: ContextPressurePolicy,
): NativeSnapshotPressure {
  const evaluation = evaluateContextPressure(
    usage.usedTokens === undefined && usage.remainingPercent === undefined
      ? undefined
      : {
          tokens: usage.usedTokens,
          contextWindow: usage.contextWindowTokens,
          percent: usage.remainingPercent === undefined ? undefined : 100 - usage.remainingPercent,
          tokenConfidence: "estimated",
        },
    policy,
  );
  return evaluation.available
    ? { available: true, level: evaluation.level, remainingPercent: evaluation.remainingPercent }
    : { available: false, level: "unavailable" };
}

function emptyCollection(): ContributorCollection {
  return { detail: "unavailable", contributors: [], totalEntries: 0, scannedEntries: 0 };
}

function safeProperty(
  value: Record<string, unknown>,
  key: string,
  diagnostics: NativeSnapshotDiagnostic[],
): unknown {
  const property = safely(() => value[key]);
  if (!property.ok) addDiagnostic(diagnostics, "content-truncated");
  return property.value;
}

function propertyValue(value: Record<string, unknown>, key: string): unknown {
  return safely(() => value[key]).value;
}

function arrayLength(value: unknown[]): number | undefined {
  const length = safely(() => value.length);
  return length.ok ? nonNegativeInteger(length.value) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const arrayCheck = safely(() => Array.isArray(value));
  return arrayCheck.ok && !arrayCheck.value ? value as Record<string, unknown> : undefined;
}

function addDiagnostic(diagnostics: NativeSnapshotDiagnostic[], diagnostic: NativeSnapshotDiagnostic): void {
  if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatUsage(tokens: number | undefined, contextWindow: number | undefined): string {
  if (tokens === undefined && contextWindow === undefined) return "unavailable";
  if (tokens === undefined) return `unknown of ${formatNumber(contextWindow)} tokens`;
  if (contextWindow === undefined) return `${formatNumber(tokens)} tokens`;
  return `${formatNumber(tokens)} of ${formatNumber(contextWindow)} tokens`;
}

function formatRemaining(tokens: number | undefined, contextWindow: number | undefined, percent: number | undefined): string {
  if (tokens === undefined && percent === undefined) return "unavailable";
  const count = tokens === undefined
    ? "unknown tokens"
    : contextWindow === undefined
      ? `${formatNumber(tokens)} tokens`
      : `${formatNumber(tokens)} of ${formatNumber(contextWindow)} tokens`;
  return percent === undefined ? count : `${count} (${formatPercent(percent)}%)`;
}

function formatPressure(pressure: NativeSnapshotPressure): string {
  if (!pressure.available || pressure.level === "unavailable") return "unavailable";
  return pressure.remainingPercent === undefined
    ? pressure.level
    : `${pressure.level} (${formatPercent(pressure.remainingPercent)}% remaining)`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "unknown" : Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function plural(count: number, label: string): string {
  return `${formatNumber(count)} ${label}${count === 1 ? "" : "s"}`;
}

function safely<T>(read: () => T): { ok: true; value: T } | { ok: false; value: undefined } {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, value: undefined };
  }
}
