import {
  CONTEXT_TELEMETRY_LIMITS,
  type ContextTelemetryContributor,
  type ContextTelemetryContributorDetail,
  type ContextTelemetryContributorKind,
  type ContextTelemetryDiagnostic,
  type ContextTelemetryPressure,
  type ContextTelemetrySnapshot,
  type ContextTelemetrySnapshotInput,
} from "../contracts/context-telemetry.ts";

const CONTRIBUTOR_KINDS = new Set<ContextTelemetryContributorKind>([
  "system-prompt",
  "active-tools",
  "context-files",
  "skills",
  "user-messages",
  "assistant-messages",
  "tool-results",
  "other-session",
]);
const DIAGNOSTICS = new Set<ContextTelemetryDiagnostic>([
  "usage-unavailable",
  "prompt-options-unavailable",
  "branch-unavailable",
  "branch-truncated",
  "prompt-options-truncated",
  "content-truncated",
  "contributors-degraded",
  "contributors-truncated",
]);

/** Build the stable content-free contract from typed aggregate observations. */
export function createContextTelemetrySnapshot(input: ContextTelemetrySnapshotInput): ContextTelemetrySnapshot {
  return sanitizeContextTelemetrySnapshot(input);
}

/** Fail closed when a snapshot crosses an untyped consumer or serialization boundary. */
export function sanitizeContextTelemetrySnapshot(input: unknown): ContextTelemetrySnapshot {
  const candidate = record(input) ?? {};
  const usage = record(property(candidate, "usage")) ?? {};
  const pressure = record(property(candidate, "pressure")) ?? {};
  const branch = record(property(candidate, "branch")) ?? {};
  const contributors = arrayValues(property(candidate, "contributors"), CONTEXT_TELEMETRY_LIMITS.maxContributors)
    .flatMap(sanitizeContributor);
  const diagnostics = arrayValues(property(candidate, "diagnostics"), CONTEXT_TELEMETRY_LIMITS.maxDiagnostics)
    .filter((value): value is ContextTelemetryDiagnostic => DIAGNOSTICS.has(value as ContextTelemetryDiagnostic))
    .filter((value, index, values) => values.indexOf(value) === index);

  return {
    schemaVersion: 1,
    capturedAt: capturedAt(property(candidate, "capturedAt")),
    usage: {
      usedTokens: nonNegativeNumber(property(usage, "usedTokens")),
      contextWindowTokens: positiveNumber(property(usage, "contextWindowTokens")),
      remainingTokens: nonNegativeNumber(property(usage, "remainingTokens")),
      remainingPercent: percent(property(usage, "remainingPercent")),
    },
    pressure: sanitizePressure(pressure),
    contributorDetail: sanitizeContributorDetail(property(candidate, "contributorDetail")),
    contributors,
    branch: {
      totalEntries: integer(property(branch, "totalEntries")),
      scannedEntries: Math.min(integer(property(branch, "scannedEntries")), CONTEXT_TELEMETRY_LIMITS.maxBranchEntriesScanned),
      truncated: property(branch, "truncated") === true,
    },
    diagnostics,
    bounds: CONTEXT_TELEMETRY_LIMITS,
  };
}

function sanitizeContributor(value: unknown): ContextTelemetryContributor[] {
  const contributor = record(value);
  const kind = contributor ? property(contributor, "kind") : undefined;
  if (!contributor || !CONTRIBUTOR_KINDS.has(kind as ContextTelemetryContributorKind)) return [];
  return [{
    kind: kind as ContextTelemetryContributorKind,
    itemCount: integer(property(contributor, "itemCount")),
    byteCount: integer(property(contributor, "byteCount")),
    tokenCount: nonNegativeNumber(property(contributor, "tokenCount")),
  }];
}

function sanitizeContributorDetail(value: unknown): ContextTelemetryContributorDetail {
  return value === "degraded" ? "degraded" : "unavailable";
}

function sanitizePressure(value: Record<string, unknown>): ContextTelemetryPressure {
  const available = property(value, "available") === true;
  const level = property(value, "level");
  if (!available || (level !== "normal" && level !== "warning" && level !== "critical")) {
    return { available: false, level: "unavailable" };
  }
  return { available: true, level, remainingPercent: percent(property(value, "remainingPercent")) };
}

function capturedAt(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function arrayValues(value: unknown, limit: number): unknown[] {
  const array = safely(() => Array.isArray(value)).value === true ? value as unknown[] : undefined;
  if (!array) return [];
  const length = integer(safely(() => array.length).value);
  const values: unknown[] = [];
  for (let index = 0; index < Math.min(length, limit); index += 1) {
    const item = safely(() => array[index]);
    if (item.ok) values.push(item.value);
  }
  return values;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const isArray = safely(() => Array.isArray(value));
  return isArray.ok && !isArray.value ? value as Record<string, unknown> : undefined;
}

function property(value: Record<string, unknown>, key: string): unknown {
  return safely(() => value[key]).value;
}

function integer(value: unknown): number {
  const number = nonNegativeNumber(value);
  return number === undefined ? 0 : Math.floor(number);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function safely<T>(read: () => T): { ok: true; value: T } | { ok: false; value: undefined } {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, value: undefined };
  }
}
