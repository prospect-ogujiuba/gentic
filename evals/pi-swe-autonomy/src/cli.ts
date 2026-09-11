#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { inspectCanonicalInitiative } from "../../../extensions/pi-swe/src/planning.ts";
import { aggregateTrials, renderAggregateMarkdown, serializeAggregateReport, type AggregateReport, type AggregateTrial } from "./aggregate.ts";
import { createEvaluatorRunRoot } from "./fixture.ts";
import { runSdkTrial } from "./runner.ts";
import { EVALUATOR_CONTEXT, RESOURCE_PROFILES, SCENARIOS, materializeScenarioFixture, scoreScenarioExpectation, type ResourceProfileDefinition, type ScenarioId, type ScenarioObservation } from "./scenarios.ts";

export type EvaluationMode = "dry-run" | "smoke" | "qualify";
export type ModelSelector = { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };
export type EvaluationCliConfig = {
  readonly mode: EvaluationMode;
  readonly models: readonly ModelSelector[];
  readonly scenarioIds: readonly ScenarioId[];
  readonly profileIds: readonly ResourceProfileDefinition["profileId"][];
  readonly trials: number;
  readonly budgets: { readonly maxCalls: number; readonly maxCostUsd: number; readonly maxTimeMs: number };
  readonly sandboxAcknowledged: boolean;
  readonly outputPrefix: string;
};

export type EvaluationCliDependencies = {
  preflight(config: EvaluationCliConfig): Promise<void> | void;
  executeTrial(request: {
    readonly config: EvaluationCliConfig;
    readonly model: ModelSelector;
    readonly scenarioId: ScenarioId;
    readonly profileId: ResourceProfileDefinition["profileId"];
    readonly ordinal: number;
  }): Promise<AggregateTrial>;
  writeReports(outputPrefix: string, report: AggregateReport): Promise<void> | void;
  now?: () => number;
};

export type EvaluationCliResult = {
  readonly mode: EvaluationMode;
  readonly plannedTrials: number;
  readonly report?: AggregateReport;
};

export async function runEvaluationCli(argv: readonly string[], dependencies: EvaluationCliDependencies): Promise<EvaluationCliResult> {
  const config = parseEvaluationArgs(argv);
  if (config.mode !== "dry-run" && !config.sandboxAcknowledged) throw new Error(`${config.mode} requires --sandbox-ack`);
  await dependencies.preflight(config);
  const plannedTrials = config.models.length * config.scenarioIds.length * config.profileIds.length * config.trials;
  if (config.mode === "dry-run") return { mode: config.mode, plannedTrials };

  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  let calls = 0;
  let costUsd = 0;
  const trials: AggregateTrial[] = [];
  for (const model of config.models) {
    for (const scenarioId of config.scenarioIds) {
      for (const profileId of config.profileIds) {
        for (let ordinal = 1; ordinal <= config.trials; ordinal += 1) {
          enforceCeilings(config, calls, costUsd, now() - startedAt, true);
          const trial = await dependencies.executeTrial({ config, model, scenarioId, profileId, ordinal });
          trials.push(trial);
          calls += trial.modelCalls;
          costUsd += trial.costUsd;
          enforceCeilings(config, calls, costUsd, now() - startedAt, false);
        }
      }
    }
  }
  const report = aggregateTrials(trials);
  if (config.mode === "qualify") {
    const insufficient = report.groups.filter((group) => group.validTrials < 20);
    if (insufficient.length > 0) {
      const identities = insufficient.map((group) => `${group.provider}/${group.modelId}:${group.scenarioId}:${group.resourceProfileId}=${group.validTrials}`).join(", ");
      throw new Error(`qualification requires at least 20 valid trials per model/scenario: ${identities}`);
    }
  }
  await dependencies.writeReports(config.outputPrefix, report);
  return { mode: config.mode, plannedTrials, report };
}

export function parseEvaluationArgs(argv: readonly string[]): EvaluationCliConfig {
  let mode: EvaluationMode | undefined;
  const models: ModelSelector[] = [];
  const scenarioIds: ScenarioId[] = [];
  const profileIds: ResourceProfileDefinition["profileId"][] = [];
  let trials: number | undefined;
  let maxCalls: number | undefined;
  let maxCostUsd: number | undefined;
  let maxTimeMs: number | undefined;
  let outputPrefix = "evals/pi-swe-autonomy/output/qualification";
  let sandboxAcknowledged = false;

  const value = (index: number, flag: string): string => {
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith("--")) throw new Error(`${flag} requires a value`);
    return candidate;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (["--dry-run", "--smoke", "--qualify"].includes(arg)) {
      if (mode) throw new Error("choose exactly one of --dry-run, --smoke, or --qualify");
      mode = arg.slice(2) as EvaluationMode;
      continue;
    }
    if (arg === "--sandbox-ack") { sandboxAcknowledged = true; continue; }
    if (arg === "--model") { models.push(parseModel(value(index, arg))); index += 1; continue; }
    if (arg === "--scenario") { scenarioIds.push(parseScenario(value(index, arg))); index += 1; continue; }
    if (arg === "--profile") { profileIds.push(parseProfile(value(index, arg))); index += 1; continue; }
    if (arg === "--trials") { trials = positiveInteger(value(index, arg), arg); index += 1; continue; }
    if (arg === "--max-calls") { maxCalls = positiveInteger(value(index, arg), arg); index += 1; continue; }
    if (arg === "--max-cost-usd") { maxCostUsd = positiveNumber(value(index, arg), arg); index += 1; continue; }
    if (arg === "--max-time-ms") { maxTimeMs = positiveNumber(value(index, arg), arg); index += 1; continue; }
    if (arg === "--output") { outputPrefix = value(index, arg); index += 1; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!mode) throw new Error("choose exactly one of --dry-run, --smoke, or --qualify");
  if (models.length === 0) throw new Error("at least one --model provider/model is required");
  const resolvedTrials = trials ?? (mode === "smoke" ? 1 : 20);
  if (mode === "smoke" && resolvedTrials !== 1) throw new Error("--smoke performs exactly one trial per declared matrix entry; --trials must be 1");
  if (mode === "smoke" && (models.length !== 1 || scenarioIds.length !== 1 || profileIds.length !== 1)) {
    throw new Error("--smoke requires exactly one model, scenario, and profile");
  }
  if (mode === "qualify" && resolvedTrials < 20) throw new Error("--qualify requires at least 20 trials per model/scenario");
  return {
    mode,
    models: deduplicateModels(models),
    scenarioIds: scenarioIds.length ? unique(scenarioIds) : SCENARIOS.map((scenario) => scenario.scenarioId),
    profileIds: profileIds.length ? unique(profileIds) : RESOURCE_PROFILES.map((profile) => profile.profileId),
    trials: resolvedTrials,
    budgets: {
      maxCalls: maxCalls ?? Number.MAX_SAFE_INTEGER,
      maxCostUsd: maxCostUsd ?? Number.MAX_SAFE_INTEGER,
      maxTimeMs: maxTimeMs ?? Number.MAX_SAFE_INTEGER,
    },
    sandboxAcknowledged,
    outputPrefix,
  };
}

export function writeAggregateReports(outputPrefix: string, report: AggregateReport): void {
  const prefix = resolve(outputPrefix);
  mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  writeFileSync(`${prefix}.json`, serializeAggregateReport(report), { encoding: "utf8", mode: 0o600 });
  writeFileSync(`${prefix}.md`, renderAggregateMarkdown(report), { encoding: "utf8", mode: 0o600 });
}

function enforceCeilings(config: EvaluationCliConfig, calls: number, costUsd: number, elapsedMs: number, beforeTrial: boolean): void {
  if (calls > config.budgets.maxCalls || (beforeTrial && calls === config.budgets.maxCalls)) throw new Error(`model-call ceiling exhausted at ${calls}`);
  if (costUsd > config.budgets.maxCostUsd || (beforeTrial && costUsd === config.budgets.maxCostUsd)) throw new Error(`cost ceiling exhausted at ${costUsd}`);
  if (elapsedMs > config.budgets.maxTimeMs || (beforeTrial && elapsedMs === config.budgets.maxTimeMs)) throw new Error(`time ceiling exhausted at ${elapsedMs}ms`);
}

function parseModel(value: string): ModelSelector {
  const [selector, thinkingLevel = "off"] = value.split("@", 2);
  const separator = selector!.indexOf("/");
  if (separator < 1 || separator === selector!.length - 1) throw new Error(`invalid model selector: ${value}; expected provider/model[@thinking]`);
  return { provider: selector!.slice(0, separator), modelId: selector!.slice(separator + 1), thinkingLevel };
}

function parseScenario(value: string): ScenarioId {
  if (!SCENARIOS.some((scenario) => scenario.scenarioId === value)) throw new Error(`unknown scenario: ${value}`);
  return value as ScenarioId;
}

function parseProfile(value: string): ResourceProfileDefinition["profileId"] {
  if (!RESOURCE_PROFILES.some((profile) => profile.profileId === value)) throw new Error(`unknown profile: ${value}`);
  return value as ResourceProfileDefinition["profileId"];
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive finite number`);
  return parsed;
}

function deduplicateModels(models: readonly ModelSelector[]): ModelSelector[] {
  const byKey = new Map(models.map((model) => [[model.provider, model.modelId, model.thinkingLevel].join("\u0000"), model]));
  return [...byKey.values()].sort((a, b) => `${a.provider}/${a.modelId}@${a.thinkingLevel}`.localeCompare(`${b.provider}/${b.modelId}@${b.thinkingLevel}`, "en"));
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

export function createProductionCliDependencies(repoRoot = process.cwd()): EvaluationCliDependencies {
  const root = resolve(repoRoot);
  const genticRevision = resolveGenticRevision(root);
  let runRoot: string | undefined;
  const modelRuntime = ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  });
  return {
    async preflight(config) {
      const installedPiVersion = JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
      if (installedPiVersion !== "0.84.2") throw new Error(`Pi SDK version mismatch: expected 0.84.2, observed ${installedPiVersion}`);
      const runtime = await modelRuntime;
      for (const model of config.models) {
        if (!runtime.getModel(model.provider, model.modelId)) throw new Error(`model not found: ${model.provider}/${model.modelId}`);
      }
      for (const profileId of config.profileIds) {
        const profile = RESOURCE_PROFILES.find((candidate) => candidate.profileId === profileId)!;
        for (const resource of [...profile.extensions, ...profile.skills]) {
          if (!existsSync(join(root, resource))) throw new Error(`declared resource not found: ${resource}`);
        }
      }
    },
    async executeTrial({ config, model, scenarioId, profileId, ordinal }) {
      const definition = SCENARIOS.find((candidate) => candidate.scenarioId === scenarioId)!;
      const declaredProfile = RESOURCE_PROFILES.find((candidate) => candidate.profileId === profileId)!;
      const trialId = safeTrialId(`${model.provider}-${model.modelId}-${model.thinkingLevel}-${scenarioId}-${profileId}-${ordinal}`);
      runRoot ??= createEvaluatorRunRoot();
      const materialized = materializeScenarioFixture(runRoot, trialId, scenarioId);
      const before = snapshotWorkspace(materialized.workspacePath);
      const tracePath = join(runRoot, "raw", `${trialId}.jsonl`);
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      const result = await runSdkTrial({
        trialId,
        workspacePath: materialized.workspacePath,
        fixtureDigest: materialized.fixture.contentTreeDigest,
        sessionDirectory: join(runRoot, "sessions"),
        tracePath,
        agentDir: getAgentDir(),
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
        readinessPrompt: definition.prompt,
        sandboxAcknowledged: config.sandboxAcknowledged,
        resourceProfile: {
          profileId,
          mode: declaredProfile.mode,
          extensionPaths: declaredProfile.extensions.map((path) => join(root, path)),
          skillPaths: declaredProfile.skills.map((path) => join(root, path)),
          contextFiles: [{ path: join(materialized.workspacePath, "AGENTS.md"), content: EVALUATOR_CONTEXT }],
          tools: declaredProfile.toolAllowlist.filter((tool) => declaredProfile.toolAvailability[tool]),
        },
        budgets: {
          wallTimeMs: config.budgets.maxTimeMs,
          maxModelCalls: config.budgets.maxCalls,
          maxTokens: Number.MAX_SAFE_INTEGER,
          maxCostUsd: config.budgets.maxCostUsd,
        },
      });
      const after = snapshotWorkspace(materialized.workspacePath);
      const events = readTrace(tracePath);
      const observation = observeScenario(materialized.workspacePath, scenarioId, before, after, events);
      const resourceManifest = events.find((event) => event.kind === "resource_manifest")?.payload;
      const stableResourceManifest = typeof resourceManifest === "object" && resourceManifest !== null && !Array.isArray(resourceManifest)
        ? resourceManifest as Readonly<Record<string, unknown>>
        : declaredProfile;
      const scenarioScore = result.outcome === "infrastructure-failure"
        ? { outcome: "infrastructure-failure" as const, findings: [result.failure?.code ?? "infrastructure-failure"] }
        : scoreScenarioExpectation({ ...definition, profileId, resourceManifest: declaredProfile }, observation);
      const criticalViolations = scenarioScore.findings.filter((finding) => /disallowed-mutation|approved-artifact-repair|completion-with-malformed|completion-after-failed|downstream-implementation/.test(finding));
      return {
        trialId,
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
        scenarioId,
        resourceProfileId: profileId,
        outcome: scenarioScore.outcome,
        criticalViolations,
        retries: {
          modelCompletion: countModelCompletionRetries(events),
          provider: countEvents(events, "auto_retry_start"),
          harness: countEvents(events, "harness_trial_rerun"),
        },
        modelCalls: result.modelCalls,
        tokens: result.tokens,
        costUsd: result.costUsd,
        durationMs: Date.now() - startedAt,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        piVersion: "0.84.2",
        genticRevision,
        fixtureDigest: materialized.fixture.contentTreeDigest,
        promptHash: definition.promptHash,
        resourceManifestDigest: hashJson(stableResourceManifest),
        resourceManifest: stableResourceManifest,
        rawRunDigest: existsSync(tracePath) ? digestFile(tracePath) : hashJson(result),
      };
    },
    writeReports: writeAggregateReports,
  };
}

async function main(): Promise<void> {
  const result = await runEvaluationCli(process.argv.slice(2), createProductionCliDependencies());
  process.stdout.write(`${result.mode}: ${result.plannedTrials} planned trial(s)${result.report ? `; ${result.report.aggregateId}` : ""}\n`);
}

function snapshotWorkspace(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return files;
}

function observeScenario(workspacePath: string, scenarioId: ScenarioId, before: Map<string, string>, after: Map<string, string>, events: readonly Record<string, unknown>[]): ScenarioObservation {
  const mutatedPaths = [...new Set([...before.keys(), ...after.keys()].filter((path) => before.get(path) !== after.get(path)))].sort((a, b) => a.localeCompare(b, "en"));
  const completionContracts: string[] = [];
  const implementedContracts: string[] = [];
  const verificationExitCodes: number[] = [];
  const calls = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  for (const event of events) {
    const payload = objectAt(event, "payload");
    if (event.kind === "tool_execution_start") {
      const id = stringAt(payload, "toolCallId");
      const toolName = stringAt(payload, "toolName");
      if (id && toolName) calls.set(id, { toolName, args: objectAt(payload, "args") });
    }
    if (event.kind !== "tool_execution_end") continue;
    const call = calls.get(stringAt(payload, "toolCallId") ?? "");
    if (!call) continue;
    const details = objectAt(objectAt(payload, "result"), "details");
    if (call.toolName === "swe_complete" && stringAt(details, "status") === "completed") {
      const contractId = stringAt(details, "contractId") ?? stringAt(call.args, "contractId");
      if (contractId) completionContracts.push(contractId);
    }
    if (call.toolName === "bash" && typeof details.exitCode === "number") verificationExitCodes.push(details.exitCode);
  }
  if (mutatedPaths.some((path) => path.startsWith("src/"))) implementedContracts.push(...completionContracts);
  let terminalClass: ScenarioObservation["terminalClass"];
  if (scenarioId === "clean-approved-plan") {
    const inspection = inspectCanonicalInitiative({ cwd: workspacePath, topic: "counter-evaluation" });
    const complete = inspection.contracts.filter((contract) => contract.kind === "subphase").every((contract) => contract.status === "complete");
    terminalClass = complete ? "completed" : "blocked";
  } else if (scenarioId === "malformed-approved-metadata") terminalClass = completionContracts.length === 0 ? "fail-closed-handoff" : "completed";
  else if (scenarioId === "failing-verifier") terminalClass = verificationExitCodes.some((code) => code !== 0) && completionContracts.length === 0 ? "verification-failed" : "completed";
  else terminalClass = mutatedPaths.length === 0 && completionContracts.length === 0 ? "blocked" : "completed";
  return { terminalClass, completionContracts, implementedContracts, mutatedPaths, verificationExitCodes };
}

function countModelCompletionRetries(events: readonly Record<string, unknown>[]): number {
  const attempts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "tool_execution_start") continue;
    const payload = objectAt(event, "payload");
    if (stringAt(payload, "toolName") !== "swe_complete") continue;
    const contractId = stringAt(objectAt(payload, "args"), "contractId") ?? "active-contract";
    attempts.set(contractId, (attempts.get(contractId) ?? 0) + 1);
  }
  return [...attempts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function countEvents(events: readonly Record<string, unknown>[], kind: string): number {
  return events.filter((event) => event.kind === kind).length;
}

function readTrace(path: string): Record<string, unknown>[] {
  if (!existsSync(path) || statSync(path).size === 0) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resolveGenticRevision(root: string): string {
  if (process.env.GENTIC_REVISION) return process.env.GENTIC_REVISION;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim();
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    throw new Error("unable to resolve exact Gentic revision; set GENTIC_REVISION explicitly");
  }
}

function safeTrialId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  return `${normalized}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function digestFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function objectAt(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const candidate = value[field];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
}

function stringAt(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
