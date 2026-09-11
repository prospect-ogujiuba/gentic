export const EVALUATION_SCHEMA_VERSION = 1 as const;

export type ModelTrialIdentity = {
  readonly trialId: string;
  readonly scenarioId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly fixtureDigest: string;
};

export type FixtureRecord = {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly fixtureId: string;
  readonly contentTreeDigest: string;
  readonly files: readonly string[];
  readonly contractIds: readonly string[];
};

export type TrialRecord = ModelTrialIdentity & {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly piVersion: string;
  readonly genticRevision: string;
  readonly resourceProfileId: string;
  readonly promptHash: string;
  readonly startedAt: string;
};

export type EvaluationEvent = {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly trialId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type TrialScore = ModelTrialIdentity & {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly outcome: "passed" | "failed" | "infrastructure-failure";
  readonly findings: readonly string[];
};

export type AggregateRecord = {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly aggregateId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly scenarioId: string;
  readonly fixtureDigest: string;
  readonly trialIds: readonly string[];
};

type UnknownRecord = Record<string, unknown>;

export function parseFixtureRecord(value: unknown): FixtureRecord {
  const record = versionedRecord(value, "fixture");
  requireString(record, "fixtureId");
  requireSha256(record, "contentTreeDigest");
  requireStringArray(record, "files");
  requireStringArray(record, "contractIds");
  return record as FixtureRecord;
}

export function parseTrialRecord(value: unknown): TrialRecord {
  const record = versionedRecord(value, "trial");
  requireModelTrialIdentity(record);
  for (const field of ["piVersion", "genticRevision", "resourceProfileId", "startedAt"] as const) requireString(record, field);
  requireSha256(record, "promptHash");
  return record as TrialRecord;
}

export function parseEvaluationEvent(value: unknown): EvaluationEvent {
  const record = versionedRecord(value, "event");
  requireString(record, "trialId");
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) throw new Error("event.sequence must be a non-negative integer");
  requireString(record, "timestamp");
  requireString(record, "kind");
  if (!isRecord(record.payload)) throw new Error("event.payload must be an object");
  return record as EvaluationEvent;
}

export function parseTrialScore(value: unknown): TrialScore {
  const record = versionedRecord(value, "score");
  requireModelTrialIdentity(record);
  if (!["passed", "failed", "infrastructure-failure"].includes(record.outcome as string)) throw new Error("score.outcome is unsupported");
  requireStringArray(record, "findings", true);
  return record as TrialScore;
}

export function parseAggregateRecord(value: unknown): AggregateRecord {
  const record = versionedRecord(value, "aggregate");
  for (const field of ["aggregateId", "provider", "modelId", "thinkingLevel", "scenarioId"] as const) requireString(record, field);
  requireSha256(record, "fixtureDigest");
  requireStringArray(record, "trialIds");
  return record as AggregateRecord;
}

function requireModelTrialIdentity(record: UnknownRecord): void {
  for (const field of ["trialId", "scenarioId", "provider", "modelId", "thinkingLevel"] as const) requireString(record, field);
  requireSha256(record, "fixtureDigest");
}

function versionedRecord(value: unknown, name: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} record must be an object`);
  if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    throw new Error(`${name}.schemaVersion must be ${EVALUATION_SCHEMA_VERSION}`);
  }
  return value;
}

function requireString(record: UnknownRecord, field: string): void {
  if (typeof record[field] !== "string" || !(record[field] as string).trim()) throw new Error(`${field} must be a non-empty string`);
}

function requireSha256(record: UnknownRecord, field: string): void {
  if (typeof record[field] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record[field] as string)) {
    throw new Error(`${field} must be a sha256 digest`);
  }
}

function requireStringArray(record: UnknownRecord, field: string, allowEmpty = false): void {
  const value = record[field];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${field} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
