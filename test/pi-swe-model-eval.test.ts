import assert from "node:assert/strict";
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
