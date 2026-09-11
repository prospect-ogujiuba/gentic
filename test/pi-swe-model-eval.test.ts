import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { inspectCanonicalInitiative } from "../extensions/pi-swe/src/planning.ts";
import {
  cleanupEvaluatorWorkspace,
  createEvaluatorRunRoot,
  digestContentTree,
  materializeApprovedPlanFixture,
} from "../evals/pi-swe-autonomy/src/fixture.ts";
import {
  parseAggregateRecord,
  parseEvaluationEvent,
  parseFixtureRecord,
  parseTrialRecord,
  parseTrialScore,
} from "../evals/pi-swe-autonomy/src/types.ts";
import { EvaluationRecorder } from "../evals/pi-swe-autonomy/src/recorder.ts";
import { runSdkTrial, type AgentSessionLike, type RunnerSdk } from "../evals/pi-swe-autonomy/src/runner.ts";
import { createTrialResources, type ResourceLoaderLike } from "../evals/pi-swe-autonomy/src/resources.ts";
import { serializeTrialScore, scoreTrial, type ScoreSnapshot } from "../evals/pi-swe-autonomy/src/score.ts";
import { aggregateTrials, renderAggregateMarkdown, serializeAggregateReport } from "../evals/pi-swe-autonomy/src/aggregate.ts";
import { runEvaluationCli } from "../evals/pi-swe-autonomy/src/cli.ts";
import {
  buildScenarioMatrix,
  materializeScenarioFixture,
  RESOURCE_PROFILES,
  SCENARIOS,
  scoreScenarioExpectation,
} from "../evals/pi-swe-autonomy/src/scenarios.ts";

test("approved-plan fixture materializes deterministically without shared writable files", () => {
  const runRoot = createEvaluatorRunRoot();
  try {
    const first = materializeApprovedPlanFixture(runRoot, "trial-a");
    const second = materializeApprovedPlanFixture(runRoot, "trial-b");

    assert.equal(first.fixture.contentTreeDigest, second.fixture.contentTreeDigest);
    assert.deepEqual(first.fixture.files, second.fixture.files);

    const relativePath = "src/counter.js";
    const firstFile = join(first.workspacePath, relativePath);
    const secondFile = join(second.workspacePath, relativePath);
    assert.notEqual(lstatSync(firstFile).ino, lstatSync(secondFile).ino);
    const original = readFileSync(secondFile, "utf8");
    writeFileSync(firstFile, "export const changed = true;\n", "utf8");
    assert.equal(readFileSync(secondFile, "utf8"), original);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("approved-plan fixture has three ordered executable contracts and valid canonical links", () => {
  const runRoot = createEvaluatorRunRoot();
  try {
    const materialized = materializeApprovedPlanFixture(runRoot, "canonical");
    const inspection = inspectCanonicalInitiative({ cwd: materialized.workspacePath, topic: "counter-evaluation" });
    const executable = inspection.contracts.filter((contract) => contract.kind === "subphase");

    assert.deepEqual(inspection.diagnostics, []);
    assert.deepEqual(executable.map((contract) => contract.id), ["P01-C01", "P01-C02", "P01-C03"]);
    assert.deepEqual(executable.map((contract) => contract.dependsOn), [[], ["P01-C01"], ["P01-C02"]]);
    assert.deepEqual(inspection.readyIds, ["P01-C01"]);
    assert.equal(inspection.gates.find((gate) => gate.id === "plan-approved")?.ready, true);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("evaluation record parsers reject unknown versions and missing identity fields", () => {
  const identity = {
    trialId: "trial-001",
    scenarioId: "approved-plan",
    provider: "openai",
    modelId: "gpt-example-1",
    thinkingLevel: "high",
    fixtureDigest: `sha256:${"a".repeat(64)}`,
  };
  const fixture = parseFixtureRecord({
    schemaVersion: 1,
    fixtureId: "approved-plan-v1",
    contentTreeDigest: identity.fixtureDigest,
    files: ["package.json"],
    contractIds: ["P01-C01", "P01-C02", "P01-C03"],
  });
  assert.equal(fixture.fixtureId, "approved-plan-v1");

  const trial = parseTrialRecord({
    schemaVersion: 1,
    ...identity,
    piVersion: "0.84.2",
    genticRevision: "abc123",
    resourceProfileId: "isolated-v1",
    promptHash: `sha256:${"b".repeat(64)}`,
    startedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(trial.trialId, identity.trialId);

  const event = parseEvaluationEvent({
    schemaVersion: 1,
    trialId: identity.trialId,
    sequence: 0,
    timestamp: "2026-09-11T00:00:01.000Z",
    kind: "prompt",
    payload: {},
  });
  assert.equal(event.sequence, 0);

  const score = parseTrialScore({
    schemaVersion: 1,
    ...identity,
    outcome: "passed",
    findings: [],
  });
  assert.equal(score.outcome, "passed");

  const aggregate = parseAggregateRecord({
    schemaVersion: 1,
    aggregateId: "aggregate-001",
    provider: identity.provider,
    modelId: identity.modelId,
    thinkingLevel: identity.thinkingLevel,
    scenarioId: identity.scenarioId,
    fixtureDigest: identity.fixtureDigest,
    trialIds: [identity.trialId],
  });
  assert.equal(aggregate.trialIds.length, 1);

  for (const [parser, value] of [
    [parseTrialRecord, { ...trial, schemaVersion: 2 }],
    [parseEvaluationEvent, { ...event, trialId: undefined }],
    [parseTrialScore, { ...score, modelId: "" }],
  ] as const) {
    assert.throws(() => parser(value), /schemaVersion|trialId|modelId/);
  }
});

test("cleanup rejects paths outside the evaluator-owned realpath", () => {
  const runRoot = createEvaluatorRunRoot();
  const outside = mkdtempSync(join(tmpdir(), "pi-swe-eval-outside-"));
  try {
    const materialized = materializeApprovedPlanFixture(runRoot, "safe");
    assert.throws(() => cleanupEvaluatorWorkspace(runRoot, outside), /outside evaluator run root/);
    assert.equal(existsSync(outside), true);

    const link = join(runRoot, "escape-link");
    symlinkSync(outside, link, "dir");
    assert.throws(() => cleanupEvaluatorWorkspace(runRoot, link), /outside evaluator run root/);
    assert.equal(existsSync(outside), true);

    cleanupEvaluatorWorkspace(runRoot, materialized.workspacePath);
    assert.equal(existsSync(materialized.workspacePath), false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("recorder writes ordered redacted event JSONL with owner-only permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-recorder-"));
  try {
    const tracePath = join(directory, "trial.jsonl");
    const recorder = new EvaluationRecorder("trial-001", tracePath, () => "2026-09-11T00:00:00.000Z");
    recorder.recordPrompt("readiness", "prepare");
    recorder.recordSessionEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo ok", authorization: "Bearer secret" },
    });
    recorder.recordSessionEvent({ type: "queue_update", steering: [], followUp: [] });
    recorder.recordSessionEvent({
      type: "message_end",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "Bearer abcdefghijklmnop and sk-test-abcdefghijklmnop" }],
        usage: { inputTokens: 17, outputTokens: 5 },
      },
    });
    recorder.close();

    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3]);
    assert.equal(events[1].payload.toolCallId, "call-1");
    assert.equal(events[1].payload.args.authorization, "[REDACTED]");
    assert.deepEqual(events[2].payload, { followUp: [], steering: [] });
    assert.equal(events[3].payload.message.content[0].text, "Bearer [REDACTED] and [REDACTED]");
    assert.deepEqual(events[3].payload.message.usage, { inputTokens: 17, outputTokens: 5 });
    assert.equal(statSync(tracePath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated resources enumerate content-addressed extension, skill, context, and tool identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-resources-"));
  const extensionPath = join(directory, "pi-swe.ts");
  const skillPath = join(directory, "SKILL.md");
  const contextPath = join(directory, "AGENTS.md");
  writeFileSync(extensionPath, "export default () => {};\n", "utf8");
  writeFileSync(skillPath, "# Skill\n", "utf8");
  const loaded: ResourceLoaderLike = {
    reload: async () => {},
    getExtensions: () => ({ extensions: [{ path: extensionPath, resolvedPath: extensionPath }], errors: [] }),
    getSkills: () => ({ skills: [{ name: "swe-implement", filePath: skillPath }], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [{ path: contextPath, content: "fixed" }] }),
  };
  let options: Record<string, unknown> | undefined;
  try {
    const profile = {
      profileId: "isolated-v1" as const,
      mode: "isolated" as const,
      cwd: process.cwd(),
      agentDir: "/agent",
      extensionPaths: [extensionPath],
      skillPaths: [skillPath],
      contextFiles: [{ path: contextPath, content: "fixed" }],
      tools: ["read", "bash", "edit", "write", "swe_complete"],
    };
    const first = await createTrialResources(profile, {
      createLoader(value) { options = value; return loaded; },
    });

    assert.equal(options?.noExtensions, true);
    assert.equal(options?.noSkills, true);
    assert.equal(options?.noContextFiles, true);
    assert.deepEqual(first.manifest.tools, ["bash", "edit", "read", "swe_complete", "write"]);
    assert.match(first.manifest.extensions[0] ?? "", /pi-swe\.ts:sha256:[a-f0-9]{64}$/);
    assert.equal(first.manifest.extensions[1], "<inline:pi-swe-evaluation-trial-root>@1");
    assert.match(first.manifest.skills[0] ?? "", /swe-implement:.*SKILL\.md:sha256:[a-f0-9]{64}$/);
    assert.match(first.manifest.context[0] ?? "", /AGENTS\.md:sha256:[a-f0-9]{64}$/);

    writeFileSync(extensionPath, "export default () => { throw new Error('changed'); };\n", "utf8");
    const second = await createTrialResources(profile, { createLoader: () => loaded });
    assert.notEqual(second.manifest.extensions[0], first.manifest.extensions[0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK runner waits for each settled boundary before sending exactly Approved and disposes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-runner-"));
  const prompts: string[] = [];
  const order: string[] = [];
  let disposed = false;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const session: AgentSessionLike = {
    sessionId: "session-unique",
    sessionFile: join(directory, "session.jsonl"),
    prompt: async (text) => {
      prompts.push(text);
      order.push(`prompt:${text}`);
      listener?.({ type: "turn_start", turnIndex: prompts.length - 1, timestamp: Date.now() });
      listener?.({ type: "agent_settled" });
      order.push(`resolved:${text}`);
    },
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    abort: async () => {},
    dispose() { disposed = true; },
    getActiveToolNames: () => ["read", "bash", "edit", "write", "swe_complete"],
    getSessionStats: () => ({ tokens: { total: 12 }, cost: 0.01 }),
  };
  const sdk = fakeRunnerSdk(session);
  try {
    const outcome = await runSdkTrial({
      trialId: "trial-001",
      workspacePath: directory,
      fixtureDigest: digestContentTree(directory).digest,
      sessionDirectory: join(directory, "sessions"),
      tracePath: join(directory, "raw", "trace.jsonl"),
      agentDir: join(directory, "agent"),
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "high",
      readinessPrompt: "prepare fixture",
      sandboxAcknowledged: true,
      resourceProfile: { profileId: "isolated-v1", mode: "isolated", extensionPaths: [], skillPaths: [], contextFiles: [], tools: ["read", "bash", "edit", "write", "swe_complete"] },
      budgets: { wallTimeMs: 1_000, maxModelCalls: 2, maxTokens: 100, maxCostUsd: 1 },
    }, sdk);

    assert.equal(outcome.outcome, "completed");
    assert.deepEqual(prompts, ["prepare fixture", "Approved"]);
    assert.deepEqual(order, ["prompt:prepare fixture", "resolved:prepare fixture", "prompt:Approved", "resolved:Approved"]);
    assert.equal(outcome.sessionId, "session-unique");
    assert.equal(disposed, true);
    const events = readFileSync(join(directory, "raw", "trace.jsonl"), "utf8");
    assert.match(events, /"phase":"approval"/);
    assert.doesNotMatch(events, /steer|followUp/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK runner aborts and classifies model-call budget exhaustion as infrastructure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-runner-budget-"));
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let aborted = 0;
  const tools = ["read", "bash", "edit", "write", "swe_complete"];
  const session: AgentSessionLike = {
    sessionId: "session-budget",
    prompt: async () => {
      listener?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
      listener?.({ type: "agent_settled" });
    },
    subscribe(callback) { listener = callback; return () => {}; },
    abort: async () => { aborted += 1; },
    dispose() {},
    getActiveToolNames: () => tools,
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
  };
  try {
    const outcome = await runSdkTrial({
      trialId: "trial-budget",
      workspacePath: directory,
      fixtureDigest: digestContentTree(directory).digest,
      sessionDirectory: join(directory, "sessions"),
      tracePath: join(directory, "trace.jsonl"),
      agentDir: join(directory, "agent"),
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "off",
      readinessPrompt: "prepare",
      sandboxAcknowledged: true,
      resourceProfile: { profileId: "isolated-v1", mode: "isolated", extensionPaths: [], skillPaths: [], contextFiles: [], tools },
      budgets: { wallTimeMs: 1_000, maxModelCalls: 0, maxTokens: 1, maxCostUsd: 1 },
    }, fakeRunnerSdk(session));
    assert.equal(outcome.outcome, "infrastructure-failure");
    assert.equal(outcome.failure?.code, "budget-exhausted");
    assert.equal(aborted, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK runner classifies a resolved prompt terminal provider error as infrastructure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-runner-provider-"));
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const session: AgentSessionLike = {
    sessionId: "session-provider",
    prompt: async () => {
      const message = { role: "assistant", stopReason: "error", errorMessage: "provider unavailable" };
      listener?.({ type: "message_end", message });
      listener?.({ type: "agent_end", messages: [message], willRetry: false });
      listener?.({ type: "agent_settled" });
    },
    subscribe(callback) { listener = callback; return () => {}; },
    abort: async () => {},
    dispose() {},
    getActiveToolNames: () => ["read"],
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
  };
  try {
    const outcome = await runSdkTrial({
      trialId: "trial-provider",
      workspacePath: directory,
      fixtureDigest: digestContentTree(directory).digest,
      sessionDirectory: join(directory, "sessions"),
      tracePath: join(directory, "trace.jsonl"),
      agentDir: join(directory, "agent"),
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "off",
      readinessPrompt: "prepare",
      sandboxAcknowledged: true,
      resourceProfile: { profileId: "isolated-v1", mode: "isolated", extensionPaths: [], skillPaths: [], contextFiles: [], tools: ["read"] },
      budgets: { wallTimeMs: 1_000, maxModelCalls: 2, maxTokens: 1, maxCostUsd: 1 },
    }, fakeRunnerSdk(session));
    assert.equal(outcome.outcome, "infrastructure-failure");
    assert.equal(outcome.failure?.code, "provider-error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK runner applies its wall-time budget to SDK setup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-runner-setup-timeout-"));
  const session: AgentSessionLike = {
    sessionId: "unused",
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose() {},
    getActiveToolNames: () => [],
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
  };
  const sdk = fakeRunnerSdk(session);
  sdk.createModelRuntime = async () => new Promise(() => {});
  try {
    const outcome = await runSdkTrial({
      trialId: "trial-setup-timeout",
      workspacePath: directory,
      fixtureDigest: digestContentTree(directory).digest,
      sessionDirectory: join(directory, "sessions"),
      tracePath: join(directory, "trace.jsonl"),
      agentDir: join(directory, "agent"),
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "off",
      readinessPrompt: "prepare",
      sandboxAcknowledged: true,
      resourceProfile: { profileId: "isolated-v1", mode: "isolated", extensionPaths: [], skillPaths: [], contextFiles: [], tools: [] },
      budgets: { wallTimeMs: 25, maxModelCalls: 2, maxTokens: 1, maxCostUsd: 1 },
    }, sdk);
    assert.equal(outcome.failure?.code, "timeout");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK runner classifies missing tools as infrastructure failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-swe-runner-failure-"));
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let aborted = 0;
  const session: AgentSessionLike = {
    sessionId: "session-failure",
    prompt: async () => {
      listener?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
      listener?.({ type: "agent_settled" });
    },
    subscribe(callback) { listener = callback; return () => {}; },
    abort: async () => { aborted += 1; },
    dispose() {},
    getActiveToolNames: () => ["read"],
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
  };
  try {
    const outcome = await runSdkTrial({
      trialId: "trial-failure",
      workspacePath: directory,
      fixtureDigest: digestContentTree(directory).digest,
      sessionDirectory: join(directory, "sessions"),
      tracePath: join(directory, "trace.jsonl"),
      agentDir: join(directory, "agent"),
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "off",
      readinessPrompt: "prepare",
      sandboxAcknowledged: true,
      resourceProfile: { profileId: "isolated-v1", mode: "isolated", extensionPaths: [], skillPaths: [], contextFiles: [], tools: ["read", "swe_complete"] },
      budgets: { wallTimeMs: 1_000, maxModelCalls: 0, maxTokens: 1, maxCostUsd: 1 },
    }, fakeRunnerSdk(session));
    assert.equal(outcome.outcome, "infrastructure-failure");
    assert.equal(outcome.failure?.code, "missing-tool");
    assert.equal(aborted, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opt-in SDK smoke uses a copied workspace and persistent fresh session", {
  skip: process.env.PI_SWE_EVAL_SMOKE_MODEL ? false : "set PI_SWE_EVAL_SMOKE_MODEL=provider/model to enable",
  timeout: 300_000,
}, async () => {
  assert.equal(process.env.PI_SWE_EVAL_SANDBOX_ACK, "1", "set PI_SWE_EVAL_SANDBOX_ACK=1 only inside a container/equivalent sandbox");
  const selector = process.env.PI_SWE_EVAL_SMOKE_MODEL ?? "";
  const separator = selector.indexOf("/");
  assert.ok(separator > 0, "PI_SWE_EVAL_SMOKE_MODEL must be provider/model");
  const runRoot = createEvaluatorRunRoot();
  try {
    const materialized = materializeApprovedPlanFixture(runRoot, "live-smoke");
    const extensionPath = resolve("extensions/pi-swe/index.ts");
    const skillPaths = (process.env.PI_SWE_EVAL_SMOKE_SKILLS ?? "")
      .split(",")
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => resolve(path));
    assert.ok(skillPaths.length > 0, "PI_SWE_EVAL_SMOKE_SKILLS must list exact SKILL.md paths");
    mkdirSync(join(runRoot, "sessions"), { recursive: true });
    const outcome = await runSdkTrial({
      trialId: `smoke-${Date.now()}`,
      workspacePath: materialized.workspacePath,
      fixtureDigest: materialized.fixture.contentTreeDigest,
      sessionDirectory: join(runRoot, "sessions"),
      tracePath: join(runRoot, "raw", "trace.jsonl"),
      agentDir: getAgentDir(),
      provider: selector.slice(0, separator),
      modelId: selector.slice(separator + 1),
      thinkingLevel: process.env.PI_SWE_EVAL_SMOKE_THINKING ?? "off",
      readinessPrompt: "Inspect the approved canonical plan and report readiness. Do not implement until explicitly approved.",
      sandboxAcknowledged: true,
      resourceProfile: {
        profileId: "isolated-smoke-v1",
        mode: "isolated",
        extensionPaths: [extensionPath],
        skillPaths,
        contextFiles: [],
        tools: ["read", "bash", "edit", "write", "swe_complete"],
      },
      budgets: { wallTimeMs: 240_000, maxModelCalls: 40, maxTokens: 150_000, maxCostUsd: 10 },
    });
    assert.ok(outcome.sessionId);
    assert.ok(existsSync(join(runRoot, "raw", "trace.jsonl")));
    assert.ok(["completed", "infrastructure-failure"].includes(outcome.outcome));
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("deterministic scorer accepts a clean correlated lifecycle trace", () => {
  const fixture = scoringFixture();
  const score = scoreTrial(fixture.input);

  assert.equal(score.outcome, "passed");
  assert.deepEqual(score.findings, []);
  assert.deepEqual(score.lifecycle.completionOrder, ["P01-C01", "P01-C02"]);
  assert.deepEqual(score.lifecycle.verificationCommands.map(({ command, exitCode }) => ({ command, exitCode })), [
    { command: "npm test -- counter", exitCode: 0 },
    { command: "npm run typecheck", exitCode: 0 },
  ]);
  assert.deepEqual(score.lifecycle.validEvidenceContracts, ["P01-C01", "P01-C02"]);
  assert.equal(score.lifecycle.executionStarted, true);
  assert.equal(score.lifecycle.finalReconciled, true);
});

test("deterministic scorer reports lifecycle violations and separates retry classes", () => {
  const cases: Array<[string, (fixture: ReturnType<typeof scoringFixture>) => void, string]> = [
    ["reordered completion", (fixture) => swapCompletionContracts(fixture.input.events), "contract-order"],
    ["prose-only verification", (fixture) => removeSuccessfulVerification(fixture.input.events, "verify-2"), "verification-evidence-missing"],
    ["fabricated evidence", (fixture) => fixture.input.after.files.set("reports/P01-C02-verification.md", "fabricated"), "evidence-chain-invalid"],
    ["repeated completion", (fixture) => duplicateCompletionAttempt(fixture.input.events), "completion-retry"],
    ["approved artifact mutation", (fixture) => fixture.input.after.files.set(fixture.specPath, "mutated approved spec"), "immutable-canonical-mutation"],
    ["dependency bypass", (fixture) => removeFirstCompletion(fixture.input.events), "dependency-bypass"],
    ["incomplete finalization", (fixture) => markIncomplete(fixture.input.after, fixture.indexPath, fixture.manifestPath), "final-reconciliation"],
  ];

  for (const [name, mutate, expected] of cases) {
    const fixture = scoringFixture();
    mutate(fixture);
    const score = scoreTrial(fixture.input);
    assert.equal(score.outcome, "failed", name);
    assert.ok(score.findings.some((finding) => finding.startsWith(expected)), `${name}: ${score.findings.join(", ")}`);
  }

  const retries = scoringFixture();
  retries.input.events.splice(1, 0,
    scoringEvent(90, "auto_retry_start", { attempt: 1 }),
    scoringEvent(91, "auto_retry_end", { attempt: 1, success: true }),
    scoringEvent(92, "harness_trial_rerun", { rerun: 1 }),
  );
  const retryScore = scoreTrial(retries.input);
  assert.deepEqual(retryScore.lifecycle.retries, { modelCompletion: 0, provider: 1, harness: 1 });
  assert.doesNotMatch(retryScore.findings.join("\n"), /completion-retry/);
});

test("deterministic score serialization is byte-identical for the same inputs", () => {
  const fixture = scoringFixture();
  assert.equal(serializeTrialScore(scoreTrial(fixture.input)), serializeTrialScore(scoreTrial(fixture.input)));
});

test("dry-run validates the declared matrix and budgets without executing a model trial", async () => {
  let preflights = 0;
  let executions = 0;
  const result = await runEvaluationCli([
    "--dry-run",
    "--model", "test-provider/test-model",
    "--scenario", "clean-approved-plan",
    "--profile", "isolated-pi-swe-v1",
    "--trials", "20",
    "--max-calls", "40",
    "--max-cost-usd", "10",
    "--max-time-ms", "240000",
    "--output", "reports/eval",
  ], {
    preflight: async () => { preflights += 1; },
    executeTrial: async () => { executions += 1; throw new Error("dry-run called the model"); },
    writeReports: () => { throw new Error("dry-run wrote reports"); },
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.plannedTrials, 20);
  assert.equal(preflights, 1);
  assert.equal(executions, 0);
});

test("live CLI modes enforce sandbox, smoke cardinality, qualification repetitions, and ceilings", async () => {
  const dependencies = {
    preflight: async () => {},
    executeTrial: async ({ ordinal }: { ordinal: number }) => ({
      trialId: `budget-${ordinal}`,
      provider: "test-provider", modelId: "test-model", thinkingLevel: "off",
      scenarioId: "clean-approved-plan", resourceProfileId: "isolated-pi-swe-v1",
      outcome: "passed" as const, criticalViolations: [], retries: { modelCompletion: 0, provider: 0, harness: 0 }, modelCalls: 2, tokens: 1, costUsd: 0.01, durationMs: 1, startedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.001Z",
      piVersion: "0.84.2", genticRevision: "abc123", fixtureDigest: digest("fixture"), promptHash: digest("prompt"),
      resourceManifestDigest: digest("resources"), resourceManifest: { profileId: "isolated-pi-swe-v1" }, rawRunDigest: digest(`raw-${ordinal}`),
    }),
    writeReports: () => {},
  };
  await assert.rejects(() => runEvaluationCli(["--smoke", "--model", "test/model", "--scenario", "clean-approved-plan", "--profile", "isolated-pi-swe-v1"], dependencies), /sandbox-ack/);
  await assert.rejects(() => runEvaluationCli(["--smoke", "--sandbox-ack", "--model", "test/model"], dependencies), /exactly one model, scenario, and profile/);
  await assert.rejects(() => runEvaluationCli(["--smoke", "--sandbox-ack", "--model", "test/model", "--scenario", "clean-approved-plan", "--profile", "isolated-pi-swe-v1", "--trials", "2"], dependencies), /exactly one trial/);
  await assert.rejects(() => runEvaluationCli(["--qualify", "--sandbox-ack", "--model", "test/model", "--scenario", "clean-approved-plan", "--profile", "isolated-pi-swe-v1", "--trials", "19"], dependencies), /at least 20 trials/);
  await assert.rejects(() => runEvaluationCli(["--smoke", "--sandbox-ack", "--model", "test/model", "--scenario", "clean-approved-plan", "--profile", "isolated-pi-swe-v1", "--max-calls", "1"], dependencies), /model-call ceiling/);
});

test("qualification refuses fewer than 20 valid trials and does not publish a report", async () => {
  let writes = 0;
  await assert.rejects(() => runEvaluationCli([
    "--qualify", "--sandbox-ack",
    "--model", "test-provider/test-model",
    "--scenario", "clean-approved-plan",
    "--profile", "isolated-pi-swe-v1",
    "--trials", "20",
  ], {
    preflight: async () => {},
    executeTrial: async ({ ordinal }) => ({
      trialId: `trial-${ordinal}`,
      provider: "test-provider", modelId: "test-model", thinkingLevel: "off",
      scenarioId: "clean-approved-plan", resourceProfileId: "isolated-pi-swe-v1",
      outcome: ordinal === 20 ? "infrastructure-failure" : "passed",
      criticalViolations: [], retries: { modelCompletion: 0, provider: 0, harness: 0 }, modelCalls: 2, tokens: 10, costUsd: 0.01, durationMs: 100, startedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.100Z",
      piVersion: "0.84.2", genticRevision: "abc123", fixtureDigest: digest("fixture"),
      promptHash: digest("prompt"), resourceManifestDigest: digest("resources"), resourceManifest: { profileId: "isolated-pi-swe-v1" }, rawRunDigest: digest(`raw-${ordinal}`),
    }),
    writeReports: () => { writes += 1; },
  }), /requires at least 20 valid trials/);
  assert.equal(writes, 0);
});

test("aggregate reports are deterministic and enforce qualification promotion policy", () => {
  const trials = Array.from({ length: 20 }, (_, index) => ({
    trialId: `trial-${String(20 - index).padStart(2, "0")}`,
    provider: "test-provider",
    modelId: "test-model",
    thinkingLevel: "high",
    scenarioId: "clean-approved-plan",
    resourceProfileId: "isolated-pi-swe-v1",
    outcome: index < 18 ? "passed" as const : "failed" as const,
    criticalViolations: [] as string[],
    retries: { modelCompletion: index % 2, provider: 0, harness: 0 },
    modelCalls: 2,
    tokens: 100 + index,
    costUsd: 0.01,
    durationMs: 1_000 + index,
    startedAt: `2026-09-11T00:00:${String(index).padStart(2, "0")}.000Z`,
    completedAt: `2026-09-11T00:00:${String(index).padStart(2, "0")}.999Z`,
    piVersion: "0.84.2",
    genticRevision: "abc123",
    fixtureDigest: digest("fixture"),
    promptHash: digest("prompt"),
    resourceManifestDigest: digest("resources"),
    resourceManifest: { profileId: "isolated-pi-swe-v1", tools: ["read", "swe_complete"] },
    rawRunDigest: digest(`raw-${index}`),
  }));
  const promoted = aggregateTrials(trials, { minimumValidTrials: 20, minimumCleanSuccessRate: 0.9 });
  assert.equal(promoted.groups[0]?.promotion.qualified, true);
  assert.equal(promoted.groups[0]?.successRate, 0.9);
  assert.equal(promoted.groups[0]?.infrastructureFailures, 0);
  assert.equal(promoted.groups[0]?.retries.modelCompletion.total, 10);
  assert.deepEqual(promoted.groups[0]?.provenance.resourceManifests, [{ profileId: "isolated-pi-swe-v1", tools: ["read", "swe_complete"] }]);
  assert.equal(promoted.groups[0]?.provenance.trialTimes.length, 20);
  assert.match(renderAggregateMarkdown(promoted), /18\/20 \(90\.0%\)/);
  assert.equal(serializeAggregateReport(promoted), serializeAggregateReport(aggregateTrials([...trials].reverse())));

  const differentRevision = { ...trials[0]!, trialId: "trial-other-revision", genticRevision: "def456" };
  assert.equal(aggregateTrials([...trials, differentRevision]).groups.length, 2);

  trials[0]!.criticalViolations = ["immutable-canonical-mutation"];
  const rejected = aggregateTrials(trials);
  assert.equal(rejected.groups[0]?.promotion.qualified, false);
  assert.match(rejected.groups[0]?.promotion.reasons.join("\n") ?? "", /critical violations/);
});

test("scenario matrix declares content-addressed faults and exact resource availability", () => {
  const matrix = buildScenarioMatrix();
  assert.equal(matrix.length, SCENARIOS.length * RESOURCE_PROFILES.length);
  assert.equal(SCENARIOS.length, 4);
  assert.ok(SCENARIOS.every((scenario) => /^sha256:[a-f0-9]{64}$/.test(scenario.promptHash)));
  assert.ok(SCENARIOS.every((scenario) => /^sha256:[a-f0-9]{64}$/.test(scenario.fault.digest)));
  assert.ok(RESOURCE_PROFILES.every((profile) => profile.extensions.length > 0));
  assert.ok(RESOURCE_PROFILES.every((profile) => profile.skills.length > 0));
  assert.ok(RESOURCE_PROFILES.every((profile) => profile.contextInputs.length > 0));
  assert.ok(RESOURCE_PROFILES.every((profile) => profile.toolAllowlist.length > 0));
  assert.ok(RESOURCE_PROFILES.every((profile) => profile.toolAllowlist.every((tool) => typeof profile.toolAvailability[tool] === "boolean")));
  assert.equal(RESOURCE_PROFILES.find((profile) => profile.profileId === "isolated-no-swe-complete-v1")?.toolAvailability.swe_complete, false);
});

test("scenario fixtures apply deterministic malformed, verifier, and dependency faults", () => {
  const runRoot = createEvaluatorRunRoot();
  try {
    for (const scenario of SCENARIOS) {
      const first = materializeScenarioFixture(runRoot, `${scenario.scenarioId}-a`, scenario.scenarioId);
      const second = materializeScenarioFixture(runRoot, `${scenario.scenarioId}-b`, scenario.scenarioId);
      assert.equal(first.fixture.contentTreeDigest, second.fixture.contentTreeDigest, scenario.scenarioId);
      assert.equal(first.scenario.fault.digest, scenario.fault.digest);
    }

    const malformed = materializeScenarioFixture(runRoot, "malformed-check", "malformed-approved-metadata");
    const malformedInspection = inspectCanonicalInitiative({ cwd: malformed.workspacePath, topic: "counter-evaluation" });
    assert.ok(malformedInspection.diagnostics.some((item) => /approval|hash|stale/i.test(item.message)));

    const verifier = materializeScenarioFixture(runRoot, "verifier-check", "failing-verifier");
    assert.match(readFileSync(join(verifier.workspacePath, "test/counter.test.js"), "utf8"), /intentional evaluator failure/);

    const blocked = materializeScenarioFixture(runRoot, "blocked-check", "dependency-blocker");
    const blockedInspection = inspectCanonicalInitiative({ cwd: blocked.workspacePath, topic: "counter-evaluation" });
    assert.deepEqual(blockedInspection.readyIds, []);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("scenario/profile golden scoring enforces fail-closed terminal expectations", () => {
  for (const entry of buildScenarioMatrix()) {
    const scenario = SCENARIOS.find((item) => item.scenarioId === entry.scenarioId)!;
    const observation = {
      terminalClass: scenario.expectedTerminalClass,
      completionContracts: scenario.scenarioId === "clean-approved-plan" ? ["P01-C01", "P01-C02", "P01-C03"] : [],
      implementedContracts: scenario.scenarioId === "clean-approved-plan" ? ["P01-C01", "P01-C02", "P01-C03"] : [],
      mutatedPaths: scenario.scenarioId === "clean-approved-plan" ? [...scenario.allowedMutations] : [],
      verificationExitCodes: scenario.scenarioId === "failing-verifier" ? [1] : [0],
    } as const;
    assert.deepEqual(scoreScenarioExpectation(entry, observation), { outcome: "passed", findings: [] }, `${entry.scenarioId}/${entry.profileId}`);
  }

  const malformed = buildScenarioMatrix().find((entry) => entry.scenarioId === "malformed-approved-metadata")!;
  const malformedScore = scoreScenarioExpectation(malformed, {
    terminalClass: "fail-closed-handoff",
    completionContracts: ["P01-C01"],
    implementedContracts: [],
    mutatedPaths: [".model-artifacts/initiatives/counter-evaluation/specs/manifest.json"],
    verificationExitCodes: [],
  });
  assert.ok(malformedScore.findings.includes("approved-artifact-repair"));
  assert.ok(malformedScore.findings.includes("completion-with-malformed-metadata"));

  const failing = buildScenarioMatrix().find((entry) => entry.scenarioId === "failing-verifier")!;
  const failingScore = scoreScenarioExpectation(failing, {
    terminalClass: "verification-failed",
    completionContracts: ["P01-C01"],
    implementedContracts: ["P01-C01"],
    mutatedPaths: ["src/counter.js"],
    verificationExitCodes: [],
  });
  assert.ok(failingScore.findings.includes("completion-after-failed-verification"));

  const blocked = buildScenarioMatrix().find((entry) => entry.scenarioId === "dependency-blocker")!;
  const blockedScore = scoreScenarioExpectation(blocked, {
    terminalClass: "blocked",
    completionContracts: [],
    implementedContracts: ["P01-C02"],
    mutatedPaths: ["src/counter.js"],
    verificationExitCodes: [],
  });
  assert.ok(blockedScore.findings.includes("downstream-implementation:P01-C02"));
});

function scoringFixture() {
  const manifestPath = ".model-artifacts/initiatives/counter-evaluation/specs/manifest.json";
  const indexPath = ".model-artifacts/initiatives/counter-evaluation/plans/revisions/r1/contracts.json";
  const specPath = ".model-artifacts/initiatives/counter-evaluation/specs/spec-r1.md";
  const planPath = ".model-artifacts/initiatives/counter-evaluation/plans/plan-r1.md";
  const contractPaths = [
    ".model-artifacts/initiatives/counter-evaluation/plans/revisions/r1/phases/01-increment.md",
    ".model-artifacts/initiatives/counter-evaluation/plans/revisions/r1/phases/02-decrement.md",
  ];
  const beforeIndex = {
    schemaVersion: 2,
    contracts: [
      { kind: "subphase", id: "P01-C01", dependsOn: [], path: contractPaths[0], status: "pending", contentHash: digest("contract-1") },
      { kind: "subphase", id: "P01-C02", dependsOn: ["P01-C01"], path: contractPaths[1], status: "pending", contentHash: digest("contract-2") },
    ],
    contractFacts: {}, consequentialSpecialists: [], completionRecords: {},
  };
  const beforeManifest = {
    schemaVersion: 2,
    initiativeId: "counter-evaluation",
    initiativeState: "approved",
    activeSpec: { revision: 1, path: specPath, contentHash: digest("spec") },
    activePlan: { revision: 1, path: planPath, contentHash: digest("plan"), contractRoot: ".model-artifacts/initiatives/counter-evaluation/plans/revisions/r1" },
    approval: { decision: "approved", planRevision: 1, planPath, planContentHash: digest("plan"), reviewPath: ".model-artifacts/initiatives/counter-evaluation/reports/review.md", approvedAt: "2026-09-11T00:00:00.000Z", blockingFindings: 0 },
    activeContract: { id: "P01-C01", path: contractPaths[0] },
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  const afterIndex = structuredClone(beforeIndex) as typeof beforeIndex & { completionRecords: Record<string, unknown> };
  afterIndex.contracts[0]!.status = "complete";
  afterIndex.contracts[1]!.status = "complete";
  afterIndex.completionRecords = {
    "P01-C01": completionRecord("P01-C01", "P01-C02"),
    "P01-C02": completionRecord("P01-C02", null),
  };
  const afterManifest = structuredClone(beforeManifest) as typeof beforeManifest & { activeContract?: unknown };
  afterManifest.initiativeState = "finalizing";
  delete afterManifest.activeContract;
  afterManifest.updatedAt = "2026-09-11T00:01:00.000Z";
  const before: ScoreSnapshot = { files: new Map([
    [manifestPath, `${JSON.stringify(beforeManifest)}\n`], [indexPath, `${JSON.stringify(beforeIndex)}\n`],
    [specPath, "spec"], [planPath, "plan"], [contractPaths[0], "contract-1"], [contractPaths[1], "contract-2"],
  ]) };
  const after: ScoreSnapshot = { files: new Map(before.files) };
  after.files.set(manifestPath, `${JSON.stringify(afterManifest)}\n`);
  after.files.set(indexPath, `${JSON.stringify(afterIndex)}\n`);
  for (const contractId of ["P01-C01", "P01-C02"]) {
    after.files.set(`reports/${contractId}-verification.md`, `verification-${contractId}`);
    after.files.set(`reports/${contractId}-review.md`, `review-${contractId}`);
  }
  const events = [
    scoringEvent(0, "contract_execution_start", { contractId: "P01-C01" }),
    ...verificationEvents(1, "verify-1", "npm test -- counter"),
    ...completionEvents(3, "complete-1", "P01-C01"),
    scoringEvent(5, "contract_execution_start", { contractId: "P01-C02" }),
    ...verificationEvents(6, "verify-2", "npm run typecheck"),
    ...completionEvents(8, "complete-2", "P01-C02"),
    scoringEvent(10, "final_reconciliation", { diagnostics: [], activeContractId: null }),
  ];
  return {
    manifestPath, indexPath, specPath,
    input: {
      identity: { trialId: "trial-score", scenarioId: "clean", provider: "test", modelId: "model", thinkingLevel: "high", fixtureDigest: digest("fixture") },
      events, before, after, manifestPath, contractIndexPath: indexPath,
    },
  };
}

function verificationEvents(sequence: number, toolCallId: string, command: string) {
  return [
    scoringEvent(sequence, "tool_execution_start", { toolCallId, toolName: "bash", args: { command } }),
    scoringEvent(sequence + 1, "tool_execution_end", { toolCallId, toolName: "bash", isError: false, result: { details: { exitCode: 0 } } }),
  ];
}

function completionEvents(sequence: number, toolCallId: string, contractId: string) {
  return [
    scoringEvent(sequence, "tool_execution_start", { toolCallId, toolName: "swe_complete", args: { confirm: true, contractId } }),
    scoringEvent(sequence + 1, "tool_execution_end", { toolCallId, toolName: "swe_complete", isError: false, result: { details: { status: "completed", contractId } } }),
  ];
}

function scoringEvent(sequence: number, kind: string, payload: Record<string, unknown>) {
  return { schemaVersion: 1 as const, trialId: "trial-score", sequence, timestamp: `2026-09-11T00:00:${String(sequence).padStart(2, "0")}.000Z`, kind, payload };
}

function completionRecord(contractId: string, nextId: string | null) {
  return {
    schemaVersion: 1, requestId: digest(`request-${contractId}`), planRevision: 1,
    verification: { path: `reports/${contractId}-verification.md`, contentHash: digest(`verification-${contractId}`) },
    review: { path: `reports/${contractId}-review.md`, contentHash: digest(`review-${contractId}`), decision: "approve" },
    nextState: { initiativeState: nextId ? "executing" : "finalizing", activeContractId: nextId, readyContractIds: nextId ? [nextId] : [] },
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function swapCompletionContracts(events: Array<ReturnType<typeof scoringEvent>>): void {
  const starts = events.filter((event) => event.kind === "tool_execution_start" && event.payload.toolName === "swe_complete");
  const ends = events.filter((event) => event.kind === "tool_execution_end" && event.payload.toolName === "swe_complete");
  for (const event of starts) {
    const args = event.payload.args as Record<string, unknown>;
    args.contractId = args.contractId === "P01-C01" ? "P01-C02" : "P01-C01";
  }
  for (const event of ends) {
    const details = (event.payload.result as { details: Record<string, unknown> }).details;
    details.contractId = details.contractId === "P01-C01" ? "P01-C02" : "P01-C01";
  }
}

function removeSuccessfulVerification(events: Array<ReturnType<typeof scoringEvent>>, toolCallId: string): void {
  const end = events.find((event) => event.kind === "tool_execution_end" && event.payload.toolCallId === toolCallId);
  if (end) end.payload.isError = true;
  events.splice(0, 0, scoringEvent(99, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Verification passed" }] } }));
}

function duplicateCompletionAttempt(events: Array<ReturnType<typeof scoringEvent>>): void {
  events.splice(4, 0, ...completionEvents(80, "complete-retry", "P01-C01"));
}

function removeFirstCompletion(events: Array<ReturnType<typeof scoringEvent>>): void {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.payload.toolCallId === "complete-1") events.splice(index, 1);
  }
}

function markIncomplete(snapshot: ScoreSnapshot, indexPath: string, manifestPath: string): void {
  const index = JSON.parse(snapshot.files.get(indexPath)!);
  index.contracts[1].status = "pending";
  delete index.completionRecords["P01-C02"];
  snapshot.files.set(indexPath, `${JSON.stringify(index)}\n`);
  const manifest = JSON.parse(snapshot.files.get(manifestPath)!);
  manifest.initiativeState = "executing";
  manifest.activeContract = { id: "P01-C02", path: index.contracts[1].path };
  snapshot.files.set(manifestPath, `${JSON.stringify(manifest)}\n`);
}

function fakeRunnerSdk(session: AgentSessionLike): RunnerSdk {
  const loader: ResourceLoaderLike = {
    reload: async () => {},
    getExtensions: () => ({ extensions: [], errors: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
  };
  return {
    createModelRuntime: async () => ({ getModel: (provider: string, id: string) => ({ provider, id }) }),
    createSettingsManager: () => ({ flush: async () => {} }),
    createSessionManager: () => ({}),
    createResourceLoader: () => loader,
    createAgentSession: async () => ({ session, extensionsResult: { errors: [] } }),
  };
}
