import { createHash } from "node:crypto";

export type AggregateTrial = {
  readonly trialId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly scenarioId: string;
  readonly resourceProfileId: string;
  readonly outcome: "passed" | "failed" | "infrastructure-failure";
  readonly criticalViolations: readonly string[];
  readonly retries: { readonly modelCompletion: number; readonly provider: number; readonly harness: number };
  readonly modelCalls: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly piVersion: string;
  readonly genticRevision: string;
  readonly fixtureDigest: string;
  readonly promptHash: string;
  readonly resourceManifestDigest: string;
  readonly resourceManifest: Readonly<Record<string, unknown>>;
  readonly rawRunDigest: string;
};

export type Distribution = {
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly total: number;
};

export type AggregateGroup = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly scenarioId: string;
  readonly resourceProfileId: string;
  readonly trialIds: readonly string[];
  readonly validTrials: number;
  readonly infrastructureFailures: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly successRate: number;
  readonly wilson95: { readonly low: number; readonly high: number };
  readonly criticalViolations: readonly string[];
  readonly retries: {
    readonly modelCompletion: Distribution;
    readonly provider: Distribution;
    readonly harness: Distribution;
  };
  readonly modelCalls: Distribution;
  readonly tokens: Distribution;
  readonly costUsd: Distribution;
  readonly durationMs: Distribution;
  readonly provenance: {
    readonly piVersions: readonly string[];
    readonly genticRevisions: readonly string[];
    readonly fixtureDigests: readonly string[];
    readonly promptHashes: readonly string[];
    readonly resourceManifestDigests: readonly string[];
    readonly resourceManifests: readonly Readonly<Record<string, unknown>>[];
    readonly rawRunDigests: readonly string[];
    readonly trialTimes: readonly { readonly trialId: string; readonly startedAt: string; readonly completedAt: string }[];
  };
  readonly promotion: { readonly qualified: boolean; readonly reasons: readonly string[] };
};

export type AggregateReport = {
  readonly schemaVersion: 1;
  readonly aggregateId: string;
  readonly policy: { readonly minimumValidTrials: number; readonly minimumCleanSuccessRate: number };
  readonly groups: readonly AggregateGroup[];
};

export function aggregateTrials(
  trials: readonly AggregateTrial[],
  policy: { readonly minimumValidTrials?: number; readonly minimumCleanSuccessRate?: number } = {},
): AggregateReport {
  const resolvedPolicy = {
    minimumValidTrials: policy.minimumValidTrials ?? 20,
    minimumCleanSuccessRate: policy.minimumCleanSuccessRate ?? 0.9,
  };
  if (!Number.isSafeInteger(resolvedPolicy.minimumValidTrials) || resolvedPolicy.minimumValidTrials < 1) {
    throw new Error("minimumValidTrials must be a positive integer");
  }
  if (!Number.isFinite(resolvedPolicy.minimumCleanSuccessRate) || resolvedPolicy.minimumCleanSuccessRate < 0 || resolvedPolicy.minimumCleanSuccessRate > 1) {
    throw new Error("minimumCleanSuccessRate must be between zero and one");
  }

  const grouped = new Map<string, AggregateTrial[]>();
  for (const trial of trials) {
    validateTrial(trial);
    const key = [
      trial.provider, trial.modelId, trial.thinkingLevel, trial.scenarioId, trial.resourceProfileId,
      trial.piVersion, trial.genticRevision, trial.fixtureDigest, trial.promptHash, trial.resourceManifestDigest,
    ].join("\u0000");
    const entries = grouped.get(key) ?? [];
    entries.push(trial);
    grouped.set(key, entries);
  }
  const groups = [...grouped.values()].map((entries) => aggregateGroup(entries, resolvedPolicy)).sort((a, b) => groupKey(a).localeCompare(groupKey(b), "en"));
  const body = { schemaVersion: 1 as const, policy: resolvedPolicy, groups };
  return { ...body, aggregateId: digest(stableStringify(body)) };
}

export function serializeAggregateReport(report: AggregateReport): string {
  return `${stableStringify(report)}\n`;
}

export function renderAggregateMarkdown(report: AggregateReport): string {
  const lines = [
    "# Pi-SWE model qualification",
    "",
    `Aggregate: \`${report.aggregateId}\``,
    "",
    "| Model | Scenario | Profile | Clean success | Wilson 95% | Infrastructure | Retries M/P/H | Critical | Promotion |",
    "|---|---|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const group of report.groups) {
    const identity = `${group.provider}/${group.modelId} (${group.thinkingLevel})`;
    lines.push(`| ${identity} | ${group.scenarioId} | ${group.resourceProfileId} | ${group.passedTrials}/${group.validTrials} (${formatPercent(group.successRate)}) | ${formatPercent(group.wilson95.low)}–${formatPercent(group.wilson95.high)} | ${group.infrastructureFailures} | ${group.retries.modelCompletion.total}/${group.retries.provider.total}/${group.retries.harness.total} | ${group.criticalViolations.length} | ${group.promotion.qualified ? "qualified" : `not qualified: ${group.promotion.reasons.join("; ")}`} |`);
  }
  lines.push("", "Infrastructure failures are excluded from the valid-trial denominator and remain reported separately.", "");
  return lines.join("\n");
}

function aggregateGroup(entries: AggregateTrial[], policy: Required<Pick<Parameters<typeof aggregateTrials>[1], "minimumValidTrials" | "minimumCleanSuccessRate">>): AggregateGroup {
  const sorted = [...entries].sort((a, b) => a.trialId.localeCompare(b.trialId, "en"));
  const valid = sorted.filter((trial) => trial.outcome !== "infrastructure-failure");
  const passed = valid.filter((trial) => trial.outcome === "passed").length;
  const criticalViolations = unique(sorted.flatMap((trial) => trial.criticalViolations));
  const successRate = valid.length === 0 ? 0 : passed / valid.length;
  const reasons: string[] = [];
  if (valid.length < policy.minimumValidTrials) reasons.push(`requires at least ${policy.minimumValidTrials} valid trials`);
  if (successRate < policy.minimumCleanSuccessRate) reasons.push(`clean-path success below ${formatPercent(policy.minimumCleanSuccessRate)}`);
  if (criticalViolations.length > 0) reasons.push("critical violations observed");
  const first = sorted[0]!;
  return {
    provider: first.provider,
    modelId: first.modelId,
    thinkingLevel: first.thinkingLevel,
    scenarioId: first.scenarioId,
    resourceProfileId: first.resourceProfileId,
    trialIds: sorted.map((trial) => trial.trialId),
    validTrials: valid.length,
    infrastructureFailures: sorted.length - valid.length,
    passedTrials: passed,
    failedTrials: valid.length - passed,
    successRate,
    wilson95: wilson(passed, valid.length),
    criticalViolations,
    retries: {
      modelCompletion: distribution(sorted.map((trial) => trial.retries.modelCompletion)),
      provider: distribution(sorted.map((trial) => trial.retries.provider)),
      harness: distribution(sorted.map((trial) => trial.retries.harness)),
    },
    modelCalls: distribution(sorted.map((trial) => trial.modelCalls)),
    tokens: distribution(sorted.map((trial) => trial.tokens)),
    costUsd: distribution(sorted.map((trial) => trial.costUsd)),
    durationMs: distribution(sorted.map((trial) => trial.durationMs)),
    provenance: {
      piVersions: unique(sorted.map((trial) => trial.piVersion)),
      genticRevisions: unique(sorted.map((trial) => trial.genticRevision)),
      fixtureDigests: unique(sorted.map((trial) => trial.fixtureDigest)),
      promptHashes: unique(sorted.map((trial) => trial.promptHash)),
      resourceManifestDigests: unique(sorted.map((trial) => trial.resourceManifestDigest)),
      resourceManifests: uniqueObjects(sorted.map((trial) => trial.resourceManifest)),
      rawRunDigests: unique(sorted.map((trial) => trial.rawRunDigest)),
      trialTimes: sorted.map((trial) => ({ trialId: trial.trialId, startedAt: trial.startedAt, completedAt: trial.completedAt })),
    },
    promotion: { qualified: reasons.length === 0, reasons },
  };
}

function wilson(successes: number, trials: number): { low: number; high: number } {
  if (trials === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials) / denominator;
  return { low: center - margin, high: center + margin };
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { min: 0, median: 0, p95: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { min: sorted[0]!, median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max: sorted.at(-1)!, total: sorted.reduce((sum, value) => sum + value, 0) };
}

function validateTrial(trial: AggregateTrial): void {
  for (const field of ["trialId", "provider", "modelId", "thinkingLevel", "scenarioId", "resourceProfileId", "startedAt", "completedAt", "piVersion", "genticRevision"] as const) {
    if (!trial[field]) throw new Error(`${field} must be non-empty`);
  }
  for (const field of ["modelCalls", "tokens", "costUsd", "durationMs"] as const) {
    if (!Number.isFinite(trial[field]) || trial[field] < 0) throw new Error(`${field} must be a non-negative finite number`);
  }
  for (const [field, value] of Object.entries(trial.retries)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`retries.${field} must be a non-negative integer`);
  }
}

function groupKey(group: Pick<AggregateGroup, "provider" | "modelId" | "thinkingLevel" | "scenarioId" | "resourceProfileId">): string {
  return [
    group.provider, group.modelId, group.thinkingLevel, group.scenarioId, group.resourceProfileId,
    ...group.provenance.piVersions, ...group.provenance.genticRevisions, ...group.provenance.fixtureDigests,
    ...group.provenance.promptHashes, ...group.provenance.resourceManifestDigests,
  ].join("\u0000");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

function uniqueObjects(values: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>>[] {
  const bySerialization = new Map(values.map((value) => [stableStringify(value), value]));
  return [...bySerialization.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, value]) => value);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort((a, b) => a.localeCompare(b, "en")).map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
