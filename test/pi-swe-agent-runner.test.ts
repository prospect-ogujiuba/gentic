import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AgentRunner,
  buildRunnerInvocation,
  resolvePinnedPiCli,
  type AgentRunRequest,
  type ResolvedPiCli,
  type RunnerFailureCode,
} from "../extensions/pi-swe/src/runner.ts";
import { createWorkflow, reduceWorkflow, type RunLease } from "../extensions/pi-swe/src/workflow.ts";

const FIXED_NOW = "2026-02-03T00:00:00.000Z";
const CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const SNAPSHOT_HASH = `sha256:${"b".repeat(64)}`;

function lease(runId = "run-1"): RunLease {
  return {
    id: `lease-${runId}`,
    runId,
    ownerId: "parent-session",
    stage: "implementation",
    taskId: "T1",
    fence: 1,
    acquiredAt: FIXED_NOW,
    expiresAt: "2026-02-03T00:10:00.000Z",
  };
}

function request(cwd: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    role: "implementer",
    runId: "run-1",
    actorId: "implementer-run-1",
    lease: lease(),
    cwd,
    provider: "fixture-provider",
    model: "fixture-model",
    thinking: "high",
    projectInstructions: ["Follow the project contract exactly."],
    contractPacket: { hash: CONTRACT_HASH, payload: { task: "T1", acceptance: ["works"] } },
    snapshotPacket: {
      hash: SNAPSHOT_HASH,
      payload: {
        cumulativeDelta: "diff --git a/src/a.ts b/src/a.ts\n",
        relevantFiles: ["src/a.ts", "test/a.test.ts"],
        objectiveEvidence: [{ command: "node --test", exitCode: 0, advisory: true }],
      },
    },
    readScope: ["**"],
    writeScope: ["src/**", "test/**"],
    budgets: { timeoutMs: 5_000, maxTurns: 4, maxOutputBytes: 64 * 1024, maxRetries: 0, killGraceMs: 50 },
    ...overrides,
  };
}

function fakeCli(root: string): { pi: ResolvedPiCli; capture: string; marker: string; state: string } {
  const path = join(root, "fake-pi.mjs");
  const capture = join(root, "capture.ndjson");
  const marker = join(root, "grandchild-survived");
  const state = join(root, "attempt-count");
  writeFileSync(path, `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode = process.env.FAKE_MODE || "success";
const cfg = JSON.parse(readFileSync(process.env.PI_SWE_RUN_CONFIG, "utf8"));
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), config: cfg }) + "\\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({ type: "session", version: 3, id: String(process.pid), cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "message_end", message: { role: "assistant", provider: mode === "model-mismatch" ? "fallback-provider" : cfg.provider, model: cfg.model, stopReason: "toolUse" } });
if (mode === "credential") { process.stderr.write("No API key configured for fixture-provider\\n"); process.exit(1); }
if (mode === "nonzero") process.exit(7);
if (mode === "retry") {
  let count = 0;
  try { count = Number(readFileSync(${JSON.stringify(state)}, "utf8")); } catch {}
  writeFileSync(${JSON.stringify(state)}, String(count + 1));
  if (count === 0) process.exit(9);
}
if (mode === "deadline") { setTimeout(() => {}, 30_000); }
else if (mode === "process-group") {
  spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 800); setTimeout(() => {}, 30000);`)}], { stdio: "ignore" });
  setTimeout(() => {}, 30_000);
} else if (mode === "output-limit") {
  process.stdout.write("x".repeat(200_000));
} else if (mode === "model-error") {
  emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider exploded" } });
  emit({ type: "agent_end", messages: [] });
} else if (mode === "missing") {
  emit({ type: "agent_end", messages: [] });
} else if (mode === "premature") {
  // Clean exit without the terminating report or agent_end must not succeed.
} else {
  if (mode === "turn-limit") for (let i = 0; i < 8; i++) emit({ type: "turn_start" });
  const details = mode === "malformed"
    ? { outcome: "approved", summary: 42, findings: [] }
    : mode === "needs-input"
      ? { outcome: "needs-input", summary: "need a decision", findings: [], questions: ["Which API contract is authoritative?"] }
      : mode === "questions-on-success"
        ? { outcome: "completed", summary: "ambiguous success", findings: [], questions: ["Unresolved?"] }
        : mode === "out-of-scope"
          ? { outcome: "completed", summary: "escaped scope", changedPaths: ["outside.txt"], findings: [] }
          : { outcome: cfg.role === "implementer" ? "completed" : "approved", summary: "bounded report", changedPaths: cfg.role === "implementer" ? ["src/a.ts"] : undefined, findings: [{ severity: "warning", summary: "minor risk", evidence: "src/a.ts:1" }] };
  emit({ type: "tool_execution_start", toolCallId: "report-1", toolName: "runner_report", args: details });
  emit({ type: "tool_execution_end", toolCallId: "report-1", toolName: "runner_report", result: { content: [{ type: "text", text: "accepted" }], details, terminate: true }, isError: false });
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
}
`);
  return {
    pi: { entrypoint: path, packageRoot: root, version: "0.84.2" },
    capture,
    marker,
    state,
  };
}

function captures(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runner(root: string, mode = "success") {
  const fixture = fakeCli(root);
  return {
    fixture,
    runner: new AgentRunner({
      pi: fixture.pi,
      childExtensionPath: resolve("extensions/pi-swe/src/runner-child.ts"),
      baseEnvironment: { ...process.env, FAKE_MODE: mode },
      now: () => new Date(FIXED_NOW),
    }),
  };
}

async function failure(mode: string, overrides: Partial<AgentRunRequest> = {}): Promise<RunnerFailureCode> {
  const root = mkdtempSync(join(tmpdir(), `pi-swe-runner-${mode}-`));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, "src"), { recursive: true });
  const built = runner(root, mode);
  const result = await built.runner.run(request(cwd, overrides));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  return result.failure.code;
}

test("pinned Pi CLI harness proves explicit extension loading, JSON events, propagation, and terminating report", () => {
  const pi = resolvePinnedPiCli();
  assert.equal(pi.version, "0.84.2");
  assert.equal(basename(pi.entrypoint), "cli.js");
  assert.notEqual(pi.entrypoint, process.argv[1]);

  const root = mkdtempSync(join(tmpdir(), "pi-swe-protocol-"));
  const capture = join(root, "capture.ndjson");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const extension = resolve("test/fixtures/pi-runner-protocol-extension.ts");
  const args = [
    pi.entrypoint, "--mode", "json", "--print", "--no-session", "--offline",
    "--no-extensions", "--extension", extension,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--no-builtin-tools", "--tools", "runner_report",
    "--provider", "swe-fixture", "--model", "runner-fixture", "--thinking", "high",
    "--system-prompt", "protocol fixture system prompt", "submit the fixture report",
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SWE_FIXTURE_CAPTURE: capture },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "session");
  assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
  assert.equal(events.find((event) => event.type === "tool_execution_end").result.terminate, true);
  assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
  const observed = JSON.parse(readFileSync(capture, "utf8").trim());
  assert.deepEqual(observed.model, { provider: "swe-fixture", id: "runner-fixture" });
  assert.equal(observed.reasoning, "high");
  assert.deepEqual(observed.tools, ["runner_report"]);
  assert.match(observed.systemPrompt, /^protocol fixture system prompt/);
  assert.doesNotMatch(observed.systemPrompt, /Output and Responses Efficiency Policy/);
});

test("production runner child extension completes through the pinned local Pi protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-production-child-"));
  const capture = join(root, "capture.ndjson");
  const emptyAgentSource = join(root, "agent-source");
  mkdirSync(emptyAgentSource);
  const actualRunner = new AgentRunner({
    baseEnvironment: {
      ...process.env,
      PI_SWE_FIXTURE_PROVIDER_ONLY: "1",
      PI_SWE_FIXTURE_CAPTURE: capture,
    },
  });
  const result = await actualRunner.run(request(process.cwd(), {
    role: "general-reviewer",
    actorId: "actual-reviewer",
    provider: "swe-fixture",
    model: "runner-fixture",
    readScope: ["extensions/pi-swe/src/**", "test/pi-swe-agent-runner.test.ts"],
    writeScope: undefined,
    snapshotPacket: {
      hash: SNAPSHOT_HASH,
      payload: {
        cumulativeDelta: "diff --git a/extensions/pi-swe/src/runner.ts b/extensions/pi-swe/src/runner.ts\n",
        relevantFiles: ["extensions/pi-swe/src/runner.ts", "test/pi-swe-agent-runner.test.ts"],
        objectiveEvidence: [],
      },
    },
    trustedExtensions: [resolve("test/fixtures/pi-runner-protocol-extension.ts")],
    agentSourceDir: emptyAgentSource,
    budgets: { timeoutMs: 15_000, maxTurns: 4, maxOutputBytes: 256 * 1024, maxRetries: 0, killGraceMs: 50 },
  }));
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.failure));
  if (!result.ok) return;
  assert.equal(result.report.kind, "general-review");
  assert.equal(result.report.outcome, "approved");
  const observed = JSON.parse(readFileSync(capture, "utf8").trim());
  assert.deepEqual(observed.tools, ["runner_read", "runner_report"]);
  assert.equal(observed.reasoning, "high");
});

test("invocation is fresh, explicit, discovery-free, and capability scoped by role", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-invocation-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const pi = fakeCli(root).pi;
  const reviewer = request(cwd, {
    role: "general-reviewer",
    actorId: "reviewer-1",
    readScope: ["src/a.ts", "test/a.test.ts"],
    writeScope: undefined,
  });
  const invocation = buildRunnerInvocation(reviewer, {
    pi,
    childExtensionPath: resolve("extensions/pi-swe/src/runner-child.ts"),
    agentDir: join(root, "agent"),
    configPath: join(root, "config.json"),
  });
  const joined = invocation.args.join(" ");
  for (const flag of ["--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools"]) assert.match(joined, new RegExp(flag));
  assert.doesNotMatch(joined, /--fork|--resume|--continue|--session-id/);
  assert.match(joined, /--provider fixture-provider --model fixture-model --thinking high/);
  assert.deepEqual(invocation.effectiveConfig.tools, ["runner_read", "runner_report"]);
  assert.equal(invocation.effectiveConfig.freshSession, true);
  assert.equal(invocation.effectiveConfig.discoveryDisabled, true);
  assert.match(invocation.systemPrompt, /requirements and test adequacy/i);
  assert.match(invocation.systemPrompt, /not an OS sandbox/i);
});

test("each attempt is a fresh process and report provenance is runner-supplied and bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-fresh-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, "src"), { recursive: true });
  const built = runner(root);
  const first = await built.runner.run(request(cwd));
  const second = await built.runner.run(request(cwd, { runId: "run-2", actorId: "impl-2", lease: lease("run-2") }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const seen = captures(built.fixture.capture);
  assert.equal(new Set(seen.map((entry) => entry.pid)).size, 2);
  assert.notEqual(seen[0].config.agentDir, seen[1].config.agentDir);
  assert.equal(first.report.provenance.runId, "run-1");
  assert.equal(first.report.provenance.actorId, "implementer-run-1");
  assert.equal(first.report.provenance.contractHash, CONTRACT_HASH);
  assert.equal(first.report.provenance.snapshotHash, SNAPSHOT_HASH);
  assert.deepEqual(first.report.changedPaths, ["src/a.ts"]);
  assert.equal(first.report.findings[0]?.id, "run-1-f001");
  assert.equal(first.effectiveConfig.childTestsAreAdvisory, true);
});

test("review packets contain exact delta, relevant files, and advisory evidence but no implementation conversation or verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-review-packet-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const built = runner(root);
  const result = await built.runner.run(request(cwd, {
    role: "general-reviewer",
    actorId: "reviewer-1",
    readScope: ["src/a.ts", "test/a.test.ts"],
    writeScope: undefined,
  }));
  assert.equal(result.ok, true);
  const config = captures(built.fixture.capture)[0].config;
  const packet = JSON.stringify(config.packet);
  assert.match(packet, /diff --git a\/src\/a.ts/);
  assert.match(packet, /test\/a.test.ts/);
  assert.match(packet, /"advisory":true/);
  assert.doesNotMatch(packet, /implementationConversation|reviewerVerdict/);
  assert.deepEqual(config.tools, ["runner_read", "runner_report"]);
});

test("needs-input questions are correlated and explicit workflow response persists the parent answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-clarification-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const built = runner(root, "needs-input");
  const result = await built.runner.run(request(cwd));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.outcome, "needs-input");
  assert.equal(result.report.questions?.[0]?.id, "run-1-q001");
  assert.equal(result.report.questions?.[0]?.askedByRunId, "run-1");

  let workflow = createWorkflow({
    topic: "clarification-test",
    goal: "test handoff",
    now: FIXED_NOW,
    tasks: [{ id: "T1", title: "task", writeScope: ["src/**"], nonGoals: ["none"], verification: [{ command: "node", args: ["--test"] }] }],
  });
  workflow.tasks[0]!.clarifications = result.report.questions ?? [];
  const completedAuthority = structuredClone(workflow);
  completedAuthority.status = "complete";
  completedAuthority.tasks[0]!.status = "complete";
  assert.throws(() => reduceWorkflow(completedAuthority, {
    type: "respond-clarification", taskId: "T1", questionId: "run-1-q001", answer: "late", answeredBy: "parent-session",
  }), /completed workflow clarifications are immutable/);
  const answered = reduceWorkflow(workflow, {
    type: "respond-clarification",
    taskId: "T1",
    questionId: "run-1-q001",
    answer: "The checked-in OpenAPI document is authoritative.",
    answeredBy: "parent-session",
  }, "2026-02-03T00:01:00.000Z").workflow;
  assert.equal(answered.tasks[0]!.clarifications[0]?.answer, "The checked-in OpenAPI document is authoritative.");
  assert.equal(answered.tasks[0]!.clarifications[0]?.answeredBy, "parent-session");
  assert.throws(() => reduceWorkflow(answered, {
    type: "respond-clarification", taskId: "T1", questionId: "run-1-q001", answer: "overwrite", answeredBy: "other",
  }), /already answered/);
});

test("runner classifies report, provider, exit, deadline, turn, and output failures distinctly", async () => {
  assert.equal(await failure("malformed"), "malformed-report");
  assert.equal(await failure("questions-on-success"), "malformed-report");
  assert.equal(await failure("out-of-scope"), "malformed-report");
  assert.equal(await failure("missing"), "missing-report");
  assert.equal(await failure("premature"), "premature-exit");
  assert.equal(await failure("model-error"), "model-error");
  assert.equal(await failure("model-mismatch"), "model-mismatch");
  assert.equal(await failure("credential"), "credentials-unavailable");
  assert.equal(await failure("nonzero"), "nonzero-exit");
  assert.equal(await failure("deadline", { budgets: { timeoutMs: 50, maxTurns: 4, maxOutputBytes: 64 * 1024, maxRetries: 0, killGraceMs: 20 } }), "deadline");
  assert.equal(await failure("turn-limit", { budgets: { timeoutMs: 5_000, maxTurns: 2, maxOutputBytes: 64 * 1024, maxRetries: 0, killGraceMs: 20 } }), "turn-limit");
  assert.equal(await failure("output-limit", { budgets: { timeoutMs: 5_000, maxTurns: 4, maxOutputBytes: 1_024, maxRetries: 0, killGraceMs: 20 } }), "output-limit");
});

test("abort cancellation terminates the whole process group with escalation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-cancel-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const built = runner(root, "process-group");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const result = await built.runner.run(request(cwd, { budgets: { timeoutMs: 5_000, maxTurns: 4, maxOutputBytes: 64 * 1024, maxRetries: 0, killGraceMs: 30 } }), { signal: controller.signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.code, "cancelled");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  assert.equal(existsSync(built.fixture.marker), false, "grandchild survived process-group cancellation");
});

test("infrastructure retries are bounded and use a new process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-retry-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, "src"), { recursive: true });
  const built = runner(root, "retry");
  const result = await built.runner.run(request(cwd, { budgets: { timeoutMs: 5_000, maxTurns: 4, maxOutputBytes: 64 * 1024, maxRetries: 1, killGraceMs: 20 } }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attempts, 2);
  const seen = captures(built.fixture.capture);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen.map((entry) => entry.pid)).size, 2);
  assert.notEqual(seen[0].config.agentDir, seen[1].config.agentDir);
});

test("bootstrap cancellation terminates resistant descendant process groups", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-bootstrap-cancel-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const marker = join(root, "bootstrap-grandchild-survived");
  const bootstrap = join(root, "hanging-bootstrap.mjs");
  writeFileSync(bootstrap, `import { spawn } from "node:child_process"; process.on("SIGTERM", () => {}); spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 800); setTimeout(() => {}, 30000);`)}], { stdio: "ignore" }); setTimeout(() => {}, 30000);`);
  const built = runner(root);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const result = await built.runner.run(request(cwd, {
    bootstrap: [{ command: process.execPath, args: [bootstrap], timeoutMs: 5_000 }],
  }), { signal: controller.signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.code, "cancelled");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  assert.equal(existsSync(marker), false, "bootstrap grandchild survived cancellation");
});

test("bootstrap uses isolated caches inside the workspace and rejects symlinked dependency trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-bootstrap-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const bootstrap = join(root, "bootstrap.mjs");
  const observed = join(root, "bootstrap.json");
  writeFileSync(bootstrap, `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("node_modules"); writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), cache: process.env.npm_config_cache, home: process.env.COREPACK_HOME, secret: process.env.PI_SWE_TEST_SECRET }));`);
  const built = runner(root);
  process.env.PI_SWE_TEST_SECRET = "must-not-leak";
  const result = await built.runner.run(request(cwd, {
    bootstrap: [{ command: process.execPath, args: [bootstrap], timeoutMs: 2_000 }],
  }));
  assert.equal(result.ok, true);
  const env = JSON.parse(readFileSync(observed, "utf8"));
  assert.equal(env.cwd, cwd);
  assert.match(env.cache, /^\/tmp\/.*pi-swe-bootstrap-run-1-.*\/npm-cache$/);
  assert.match(env.home, /^\/tmp\/.*pi-swe-bootstrap-run-1-.*\/corepack$/);
  assert.equal(env.cache.startsWith(cwd), false);
  assert.equal(env.secret, undefined);
  delete process.env.PI_SWE_TEST_SECRET;

  const outside = join(root, "shared-node-modules");
  mkdirSync(outside);
  const badCwd = join(root, "bad-workspace");
  mkdirSync(badCwd);
  symlinkSync(outside, join(badCwd, "node_modules"), "dir");
  const rejected = await built.runner.run(request(badCwd));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.failure.code, "bootstrap-isolation");

  const nestedCwd = join(root, "nested-workspace");
  mkdirSync(join(nestedCwd, "node_modules"), { recursive: true });
  symlinkSync(outside, join(nestedCwd, "node_modules", "escaped-package"), "dir");
  const nested = await built.runner.run(request(nestedCwd));
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.equal(nested.failure.code, "bootstrap-isolation");
});
