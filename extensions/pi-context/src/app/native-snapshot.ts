import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  evaluateContextPressure,
  type ContextPressurePolicy,
} from "../domain/index.ts";
import {
  NATIVE_SNAPSHOT_LIMITS,
  type NativeContextSnapshot,
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
const CONTRIBUTOR_KINDS = new Set<NativeContributorKind>(CONTRIBUTOR_ORDER);
const DIAGNOSTIC_CODES = new Set<NativeSnapshotDiagnostic>([
  "usage-unavailable",
  "prompt-options-unavailable",
  "branch-unavailable",
  "branch-truncated",
  "prompt-options-truncated",
  "content-truncated",
  "contributors-degraded",
  "contributors-truncated",
]);

type MutableContributor = { itemCount: number; byteCount: number };
type Measurement = { byteCount: number; truncated: boolean };
type MeasurementBudget = {
  nodes: number;
  chars: number;
  truncated: boolean;
  seen: WeakSet<object>;
};

export function createNativeContextSnapshot(
  ctx: NativeSnapshotContext,
  options: CreateNativeContextSnapshotOptions = {},
): NativeContextSnapshot {
  const diagnostics: NativeSnapshotDiagnostic[] = [];
  const contributors = new Map<NativeContributorKind, MutableContributor>();

  const usageSource = safely(() => ctx.getContextUsage());
  const usage = readUsage(usageSource.value);
  if (
    !usageSource.ok
    || !usageSource.value
    || (usage.usedTokens === undefined && usage.contextWindowTokens === undefined && usage.remainingPercent === undefined)
  ) addDiagnostic(diagnostics, "usage-unavailable");

  let totalEntries = 0;
  let scannedEntries = 0;
  if (options.collectContributors !== false) {
    const promptSource = safely(() => ctx.getSystemPromptOptions());
    if (!promptSource.ok) {
      addDiagnostic(diagnostics, "prompt-options-unavailable");
    } else if (promptSource.value) {
      collectPromptContributors(promptSource.value as unknown, contributors, diagnostics);
    }

    const branchSource = safely(() => ctx.sessionManager.getBranch());
    const branchIsArray = branchSource.ok ? safely(() => Array.isArray(branchSource.value)) : { ok: false as const, value: undefined };
    if (!branchSource.ok || !branchIsArray.ok || !branchIsArray.value) {
      addDiagnostic(diagnostics, "branch-unavailable");
    } else {
      const branch = branchSource.value as unknown[];
      const lengthSource = safely(() => branch.length);
      if (!lengthSource.ok) {
        addDiagnostic(diagnostics, "branch-unavailable");
      } else {
        totalEntries = integer(lengthSource.value);
        const first = Math.max(0, totalEntries - NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned);
        scannedEntries = totalEntries - first;
        if (first > 0) addDiagnostic(diagnostics, "branch-truncated");
        for (let index = first; index < totalEntries; index += 1) {
          const entry = safely(() => branch[index]);
          if (entry.ok) collectBranchContributor(entry.value, contributors, diagnostics);
          else addDiagnostic(diagnostics, "content-truncated");
        }
      }
    }
  }

  const publicContributors = CONTRIBUTOR_ORDER
    .flatMap((kind) => {
      const value = contributors.get(kind);
      return value ? [toPublicContributor(kind, value)] : [];
    });
  if (publicContributors.length > NATIVE_SNAPSHOT_LIMITS.maxContributors) {
    publicContributors.length = NATIVE_SNAPSHOT_LIMITS.maxContributors;
    addDiagnostic(diagnostics, "contributors-truncated");
  }
  const contributorDetail = options.collectContributors === false ? "unavailable" : "degraded";
  if (contributorDetail === "degraded") addDiagnostic(diagnostics, "contributors-degraded");

  return {
    schemaVersion: 1,
    capturedAt: safeCapturedAt(options.capturedAt),
    usage,
    pressure: pressureFromUsage(usage, options.pressurePolicy ?? DEFAULT_CONTEXT_PRESSURE_POLICY),
    contributorDetail,
    contributors: publicContributors,
    branch: {
      totalEntries,
      scannedEntries,
      truncated: totalEntries > scannedEntries,
    },
    diagnostics: diagnostics.slice(0, NATIVE_SNAPSHOT_LIMITS.maxDiagnostics),
    bounds: NATIVE_SNAPSHOT_LIMITS,
  };
}

export function renderNativeContextSummary(input: NativeContextSnapshot): string {
  const snapshot = sanitizeNativeContextSnapshot(input);
  const usage = snapshot.usage;
  const lines = [
    "pi-context",
    `Context: ${formatUsage(usage.usedTokens, usage.contextWindowTokens)}`,
    `Remaining: ${formatRemaining(usage.remainingTokens, usage.contextWindowTokens, usage.remainingPercent)}`,
    `Pressure: ${formatPressure(snapshot.pressure)}`,
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
  const candidate = record(input) ?? {};
  const usage = record(propertyValue(candidate, "usage")) ?? {};
  const pressure = record(propertyValue(candidate, "pressure")) ?? {};
  const branch = record(propertyValue(candidate, "branch")) ?? {};
  const contributors = boundedArrayValues(propertyValue(candidate, "contributors"), NATIVE_SNAPSHOT_LIMITS.maxContributors)
    .flatMap((value) => sanitizeContributor(value));
  const diagnostics = boundedArrayValues(propertyValue(candidate, "diagnostics"), NATIVE_SNAPSHOT_LIMITS.maxDiagnostics)
    .filter((value): value is NativeSnapshotDiagnostic => DIAGNOSTIC_CODES.has(value as NativeSnapshotDiagnostic))
    .filter((value, index, values) => values.indexOf(value) === index);

  return {
    schemaVersion: 1,
    capturedAt: safeCapturedAt(propertyValue(candidate, "capturedAt")),
    usage: {
      usedTokens: nonNegativeNumber(propertyValue(usage, "usedTokens")),
      contextWindowTokens: positiveNumber(propertyValue(usage, "contextWindowTokens")),
      remainingTokens: nonNegativeNumber(propertyValue(usage, "remainingTokens")),
      remainingPercent: percentNumber(propertyValue(usage, "remainingPercent")),
    },
    pressure: sanitizePressure(pressure),
    contributorDetail: propertyValue(candidate, "contributorDetail") === "degraded" ? "degraded" : "unavailable",
    contributors,
    branch: {
      totalEntries: integer(propertyValue(branch, "totalEntries")),
      scannedEntries: Math.min(integer(propertyValue(branch, "scannedEntries")), NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned),
      truncated: propertyValue(branch, "truncated") === true,
    },
    diagnostics,
    bounds: NATIVE_SNAPSHOT_LIMITS,
  };
}

function collectPromptContributors(
  value: unknown,
  contributors: Map<NativeContributorKind, MutableContributor>,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  const options = record(value);
  if (!options) {
    addDiagnostic(diagnostics, "prompt-options-unavailable");
    return;
  }

  addMeasured(contributors, "system-prompt", safeProperty(options, "customPrompt", diagnostics), diagnostics);
  addMeasured(contributors, "system-prompt", safeProperty(options, "appendSystemPrompt", diagnostics), diagnostics);
  collectArray(safeProperty(options, "promptGuidelines", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxPromptGuidelinesScanned, (item) => {
    addMeasured(contributors, "system-prompt", item, diagnostics);
  }, diagnostics);

  const snippets = record(safeProperty(options, "toolSnippets", diagnostics));
  collectArray(safeProperty(options, "selectedTools", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxToolsScanned, (item) => {
    const snippet = typeof item === "string" ? safely(() => snippets?.[item]).value : undefined;
    addMeasured(contributors, "active-tools", [item, snippet], diagnostics);
  }, diagnostics);

  collectArray(safeProperty(options, "contextFiles", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxContextFilesScanned, (item) => {
    const contextFile = record(item);
    addMeasured(contributors, "context-files", contextFile ? safeProperty(contextFile, "content", diagnostics) : undefined, diagnostics, true);
  }, diagnostics);

  collectArray(safeProperty(options, "skills", diagnostics), NATIVE_SNAPSHOT_LIMITS.maxSkillsScanned, (item) => {
    const skill = record(item);
    addMeasured(contributors, "skills", skill
      ? [safeProperty(skill, "name", diagnostics), safeProperty(skill, "description", diagnostics)]
      : undefined, diagnostics, true);
  }, diagnostics);
}

function collectBranchContributor(
  value: unknown,
  contributors: Map<NativeContributorKind, MutableContributor>,
  diagnostics: NativeSnapshotDiagnostic[],
): void {
  const entry = record(value);
  if (!entry) {
    addMeasured(contributors, "other-session", undefined, diagnostics, true);
    return;
  }
  const type = safeProperty(entry, "type", diagnostics);
  if (type === "message") {
    const message = record(safeProperty(entry, "message", diagnostics));
    const role = message ? safeProperty(message, "role", diagnostics) : undefined;
    const content = message ? safeProperty(message, "content", diagnostics) : undefined;
    addMeasured(contributors, messageKind(role), content, diagnostics, true);
    return;
  }
  if (type === "custom_message") {
    addMeasured(contributors, "other-session", safeProperty(entry, "content", diagnostics), diagnostics, true);
    return;
  }
  if (type === "compaction" || type === "branch_summary") {
    addMeasured(contributors, "other-session", safeProperty(entry, "summary", diagnostics), diagnostics, true);
    return;
  }
  addMeasured(contributors, "other-session", undefined, diagnostics, true);
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
  const arrayCheck = safely(() => Array.isArray(value));
  if (!arrayCheck.ok || !arrayCheck.value) return;
  const array = value as unknown[];
  const lengthSource = safely(() => array.length);
  if (!lengthSource.ok) {
    addDiagnostic(diagnostics, "content-truncated");
    return;
  }
  const length = integer(lengthSource.value);
  const count = Math.min(length, limit);
  for (let index = 0; index < count; index += 1) {
    const item = safely(() => array[index]);
    if (item.ok) visit(item.value);
    else addDiagnostic(diagnostics, "content-truncated");
  }
  if (length > limit) addDiagnostic(diagnostics, "prompt-options-truncated");
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

function addMeasured(
  contributors: Map<NativeContributorKind, MutableContributor>,
  kind: NativeContributorKind,
  value: unknown,
  diagnostics: NativeSnapshotDiagnostic[],
  countAbsent = false,
): void {
  if (value === undefined && !countAbsent) return;
  const measurement = measureBounded(value);
  const aggregate = contributors.get(kind) ?? { itemCount: 0, byteCount: 0 };
  aggregate.itemCount += 1;
  aggregate.byteCount += measurement.byteCount;
  contributors.set(kind, aggregate);
  if (measurement.truncated) addDiagnostic(diagnostics, "content-truncated");
}

function measureBounded(value: unknown): Measurement {
  const budget: MeasurementBudget = { nodes: 0, chars: 0, truncated: false, seen: new WeakSet() };
  const byteCount = measureValue(value, budget, 0);
  return { byteCount, truncated: budget.truncated };
}

function measureValue(value: unknown, budget: MeasurementBudget, depth: number): number {
  if (budget.nodes >= NATIVE_SNAPSHOT_LIMITS.maxValueNodesScanned || depth > NATIVE_SNAPSHOT_LIMITS.maxValueDepth) {
    budget.truncated = true;
    return 0;
  }
  budget.nodes += 1;
  if (typeof value === "string") return measureString(value, budget);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return measureString(String(value), budget);
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return 0;
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return 0;
  }
  budget.seen.add(value);

  const arrayCheck = safely(() => Array.isArray(value));
  if (!arrayCheck.ok) {
    budget.truncated = true;
    return 0;
  }
  if (arrayCheck.value) {
    const array = value as unknown[];
    const lengthSource = safely(() => array.length);
    if (!lengthSource.ok) {
      budget.truncated = true;
      return 0;
    }
    const length = integer(lengthSource.value);
    const count = Math.min(length, NATIVE_SNAPSHOT_LIMITS.maxContentBlocksPerValue);
    let bytes = 0;
    for (let index = 0; index < count; index += 1) {
      const item = safely(() => array[index]);
      if (item.ok) bytes += measureValue(item.value, budget, depth + 1);
      else budget.truncated = true;
    }
    if (length > count) budget.truncated = true;
    return bytes;
  }

  const keysSource = safely(() => {
    const keys: string[] = [];
    let examined = 0;
    for (const key in value as Record<string, unknown>) {
      examined += 1;
      if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(key);
      if (examined > NATIVE_SNAPSHOT_LIMITS.maxObjectPropertiesPerValue) break;
    }
    return { keys, truncated: examined > NATIVE_SNAPSHOT_LIMITS.maxObjectPropertiesPerValue };
  });
  if (!keysSource.ok) {
    budget.truncated = true;
    return 0;
  }
  const { keys } = keysSource.value;
  const count = Math.min(keys.length, NATIVE_SNAPSHOT_LIMITS.maxObjectPropertiesPerValue);
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const key = keys[index]!;
    bytes += measureString(key, budget);
    const property = safely(() => (value as Record<string, unknown>)[key]);
    if (!property.ok) {
      budget.truncated = true;
      continue;
    }
    bytes += measureValue(property.value, budget, depth + 1);
  }
  if (keysSource.value.truncated || keys.length > count) budget.truncated = true;
  return bytes;
}

function measureString(value: string, budget: MeasurementBudget): number {
  const remaining = Math.max(0, NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue - budget.chars);
  const measured = value.slice(0, remaining);
  budget.chars += measured.length;
  if (measured.length < value.length) budget.truncated = true;
  return new TextEncoder().encode(measured).byteLength;
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

function sanitizeContributor(value: unknown): NativeSnapshotContributor[] {
  const contributor = record(value);
  const kind = contributor ? propertyValue(contributor, "kind") : undefined;
  if (!contributor || !CONTRIBUTOR_KINDS.has(kind as NativeContributorKind)) return [];
  return [{
    kind: kind as NativeContributorKind,
    itemCount: integer(propertyValue(contributor, "itemCount")),
    byteCount: integer(propertyValue(contributor, "byteCount")),
    tokenCount: nonNegativeNumber(propertyValue(contributor, "tokenCount")),
  }];
}

function sanitizePressure(value: Record<string, unknown>): NativeSnapshotPressure {
  const available = propertyValue(value, "available") === true;
  const level = propertyValue(value, "level");
  if (!available || (level !== "normal" && level !== "warning" && level !== "critical")) {
    return { available: false, level: "unavailable" };
  }
  return { available: true, level, remainingPercent: percentNumber(propertyValue(value, "remainingPercent")) };
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

function toPublicContributor(kind: NativeContributorKind, value: MutableContributor): NativeSnapshotContributor {
  return {
    kind,
    itemCount: value.itemCount,
    byteCount: value.byteCount,
    tokenCount: Math.ceil(value.byteCount / 4),
  };
}

function addDiagnostic(diagnostics: NativeSnapshotDiagnostic[], diagnostic: NativeSnapshotDiagnostic): void {
  if (!diagnostics.includes(diagnostic) && diagnostics.length < NATIVE_SNAPSHOT_LIMITS.maxDiagnostics) diagnostics.push(diagnostic);
}

function safely<T>(read: () => T): { ok: true; value: T } | { ok: false; value: undefined } {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, value: undefined };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const arrayCheck = safely(() => Array.isArray(value));
  return arrayCheck.ok && !arrayCheck.value ? value as Record<string, unknown> : undefined;
}

function propertyValue(value: Record<string, unknown>, key: string): unknown {
  return safely(() => value[key]).value;
}

function boundedArrayValues(value: unknown, limit: number): unknown[] {
  const arrayCheck = safely(() => Array.isArray(value));
  if (!arrayCheck.ok || !arrayCheck.value) return [];
  const array = value as unknown[];
  const length = integer(safely(() => array.length).value);
  const values: unknown[] = [];
  for (let index = 0; index < Math.min(length, limit); index += 1) {
    const item = safely(() => array[index]);
    if (item.ok) values.push(item.value);
  }
  return values;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined || number < 0 ? undefined : number;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined || number <= 0 ? undefined : number;
}

function percentNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : clampPercent(number);
}

function integer(value: unknown): number {
  const number = nonNegativeNumber(value);
  return number === undefined ? 0 : Math.floor(number);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function safeCapturedAt(value: unknown): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function formatUsage(used: number | undefined, total: number | undefined): string {
  if (used === undefined) return "unknown";
  return total === undefined ? `${formatNumber(used)} tokens` : `${formatNumber(used)} of ${formatNumber(total)} tokens`;
}

function formatRemaining(remaining: number | undefined, total: number | undefined, percent: number | undefined): string {
  if (remaining === undefined || total === undefined) return percent === undefined ? "unknown" : `${formatPercent(percent)}%`;
  return `${formatNumber(remaining)} of ${formatNumber(total)} tokens (${percent === undefined ? "unknown" : `${formatPercent(percent)}%`})`;
}

function formatPressure(pressure: NativeSnapshotPressure): string {
  if (!pressure.available || pressure.remainingPercent === undefined) return "unavailable";
  return `${pressure.level} (${formatPercent(pressure.remainingPercent)}% remaining)`;
}

function formatPercent(value: number): string {
  return Number(value.toFixed(2)).toLocaleString("en-US");
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toLocaleString("en-US");
}

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}
