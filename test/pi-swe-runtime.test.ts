import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_PI_SWE_CONFIG } from "../extensions/pi-swe/src/config/index.ts";
import { decodeSweStateEnvelope, emitWarnings, formatAdvisoryChips, persistSessionRuntime, refreshPeerContext, resetTurnRuntime, SWE_ADVISORY_WIDGET_KEY, type PiSweRuntime } from "../extensions/pi-swe/src/app/runtime.ts";
import { createSweState } from "../extensions/pi-swe/src/app/state.ts";
import { createPiSweRunner, reducePiSweRunner } from "../extensions/pi-swe/src/lifecycle.ts";
import {
  markPiSweRunnerDispatchSent,
  pausePersistedPiSweRunner,
  persistPiSweRunnerState,
  readPiSweRunnerState,
  runnerLockPath,
  runnerStatePath,
  stopPersistedPiSweRunner,
} from "../extensions/pi-swe/src/app/runner-persistence.ts";

function mockContext() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ctx = {
    cwd: process.cwd(),
    ui: {
      theme: {
        fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
        bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
      },
      notify: (...args: unknown[]) => calls.push({ method: "notify", args }),
      setWidget: (...args: unknown[]) => calls.push({ method: "setWidget", args }),
    },
  } as unknown as ExtensionContext;

  return { ctx, calls };
}

function runtime(): PiSweRuntime {
  return {
    capabilityWarnings: [],
    config: { ...DEFAULT_PI_SWE_CONFIG, stages: { ...DEFAULT_PI_SWE_CONFIG.stages }, surgicalChange: { ...DEFAULT_PI_SWE_CONFIG.surgicalChange } },
    configDiagnostics: [],
    configSource: "test",
    detectedPeers: [],
    externalCapabilities: { getWarnings: () => [] },
    state: createSweState(),
    stateDiagnostics: [],
    todoEvidence: [],
    warnings: [],
  };
}

test("pi-swe active todo is fallback context and cannot replace a canonical cursor", () => {
  const state = runtime();
  state.state.activeInitiative = {
    topic: "demo",
    manifestPath: ".model-artifacts/initiatives/demo/specs/manifest.json",
    manifestSchemaVersion: 2,
    planRevision: 1,
    planPath: ".model-artifacts/initiatives/demo/plans/plan.md",
    lifecycle: { initiativeState: "approved" },
    gates: { readyIds: [], blockerCodes: [] },
  };
  state.externalCapabilities = {
    getActiveTodo: () => ({ id: "todo-1", title: "legacy marker" }),
    getWarnings: () => [],
  };

  refreshPeerContext(state);

  assert.equal(state.state.activePlan, undefined);
  assert.equal(state.state.activeInitiative?.topic, "demo");
});

test("pi-swe bounds session cursor summaries and markers before append", () => {
  const state = runtime();
  state.state.activePlan = { source: "prompt", marker: "m".repeat(5000) };
  state.state.activeInitiative = {
    topic: "demo",
    manifestPath: ".model-artifacts/initiatives/demo/specs/manifest.json",
    manifestSchemaVersion: 2,
    planRevision: 1,
    planPath: ".model-artifacts/initiatives/demo/plans/plan.md",
    lifecycle: { initiativeState: "approved" },
    gates: { readyIds: Array.from({ length: 20_000 }, (_, index) => `id-${index}`), blockerCodes: [] },
  };
  let appended: unknown;

  persistSessionRuntime(state, { appendEntry: (_type: string, data: unknown) => { appended = data; } } as never);

  const decoded = decodeSweStateEnvelope(appended);
  assert.ok(decoded);
  assert.equal(decoded.activePlan?.marker.length, 1024);
  assert.equal(decoded.activeInitiative?.gates.readyIds.length, 25);
  assert.deepEqual(state.stateDiagnostics, []);
});

test("pi-swe advisory chips use neutral background with warning-colored codes", () => {
  const { ctx } = mockContext();

  const formatted = formatAdvisoryChips(ctx, [
    { code: "missing_plan", severity: "advisory", message: "No active plan before code change.", nextAction: "Start or assign a SWE plan/todo before editing." },
  ]);

  assert.equal(formatted?.length, 1);
  assert.match(formatted[0], /<bg:customMessageBg>/);
  assert.match(formatted[0], /<fg:muted>pi-swe<\/fg>/);
  assert.match(formatted[0], /<fg:warning>missing_plan<\/fg>/);
  assert.match(formatted[0], /<fg:dim>Start or assign a SWE plan\/todo before editing\.<\/fg>/);
});

test("pi-swe emits advisory chips instead of warning notifications", () => {
  const { ctx, calls } = mockContext();
  const state = runtime();

  emitWarnings(ctx, state, [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }]);

  assert.deepEqual(calls.filter((call) => call.method === "notify"), []);
  const widgetCall = calls.findLast((call) => call.method === "setWidget");
  assert.equal(widgetCall?.args[0], SWE_ADVISORY_WIDGET_KEY);
  assert.deepEqual(widgetCall?.args[2], { placement: "belowEditor" });
  assert.match((widgetCall?.args[1] as string[])[0], /missing_plan/);
  assert.match((widgetCall?.args[1] as string[])[0], /missing_inspection/);
});

test("pi-swe clears advisory widget on turn reset", () => {
  const { ctx, calls } = mockContext();
  const state = runtime();

  emitWarnings(ctx, state, [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }]);
  resetTurnRuntime(state, ctx);

  const widgetCall = calls.findLast((call) => call.method === "setWidget");
  assert.equal(widgetCall?.args[0], SWE_ADVISORY_WIDGET_KEY);
  assert.equal(widgetCall?.args[1], undefined);
});

test("pi-swe atomically round trips one bounded runner lease per topic", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-state-"));
  const runner = createPiSweRunner({
    runId: "run-1",
    mode: "guided",
    until: "contract",
    identity: {
      topic: "demo",
      planRevision: 2,
      contractId: "P01-C02",
      contractPath: ".model-artifacts/initiatives/demo/plans/revisions/r2/P01-C02.md",
      contractHash: `sha256:${"a".repeat(64)}`,
    },
    policy: { maxTurns: 4, maxRetries: 2, maxElapsedMs: 60_000 },
    startedAtMs: 1_000,
  });

  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "demo", ownerToken: "owner-1", runner }), []);
  const persisted = JSON.parse(readFileSync(join(cwd, runnerStatePath("demo")), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.ownerToken, "owner-1");

  const recovered = readPiSweRunnerState(cwd, "demo", "owner-1");
  assert.deepEqual(recovered.diagnostics, []);
  assert.deepEqual(recovered.snapshot, { version: 1, topic: "demo", ownerToken: "owner-1", runner });
  assert.equal(recovered.recovery, "evaluate");
});

test("pi-swe runner persistence fails closed for unsafe, malformed, future, oversized, and conflicting leases", () => {
  const makeRunner = (topic = "demo") => createPiSweRunner({
    runId: "run-1",
    mode: "guided",
    until: "contract",
    identity: {
      topic,
      planRevision: 2,
      contractId: "P01-C02",
      contractPath: `.model-artifacts/initiatives/${topic}/plans/revisions/r2/P01-C02.md`,
      contractHash: `sha256:${"a".repeat(64)}`,
    },
    policy: { maxTurns: 4, maxRetries: 2, maxElapsedMs: 60_000 },
    startedAtMs: 1_000,
  });

  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-invalid-"));
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "demo", ownerToken: "owner-1", runner: makeRunner() }), []);
  assert.equal(persistPiSweRunnerState(cwd, { topic: "demo", ownerToken: "owner-2", runner: makeRunner() })[0]?.code, "owner_mismatch");
  assert.equal(readPiSweRunnerState(cwd, "demo", "owner-2").diagnostics[0]?.code, "owner_mismatch");
  assert.equal(persistPiSweRunnerState(cwd, { topic: "../escape", ownerToken: "owner-1", runner: makeRunner() })[0]?.code, "invalid_state");

  const stateFile = join(cwd, runnerStatePath("demo"));
  writeFileSync(stateFile, "{partial", "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo").diagnostics[0]?.code, "state_read_error");
  writeFileSync(stateFile, JSON.stringify({ version: 2 }), "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo").diagnostics[0]?.code, "future_version");
  writeFileSync(stateFile, "x".repeat(64 * 1024 + 1), "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo").diagnostics[0]?.code, "state_too_large");

  const mismatch = { version: 1, topic: "other", ownerToken: "owner-1", runner: makeRunner("other") };
  writeFileSync(stateFile, JSON.stringify(mismatch), "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo").diagnostics[0]?.code, "invalid_state");
  const partial = { version: 1, topic: "demo", ownerToken: "owner-1", runner: { ...makeRunner(), policy: undefined } };
  writeFileSync(stateFile, JSON.stringify(partial), "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo").diagnostics[0]?.code, "invalid_state");

  const symlinkCwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-swe-runner-outside-"));
  mkdirSync(join(symlinkCwd, ".model-artifacts/system/logs"), { recursive: true });
  symlinkSync(outside, join(symlinkCwd, ".model-artifacts/system/logs/pi-swe"), "dir");
  assert.equal(persistPiSweRunnerState(symlinkCwd, { topic: "demo", ownerToken: "owner-1", runner: makeRunner() })[0]?.code, "invalid_state");
  assert.equal(readPiSweRunnerState(symlinkCwd, "demo").diagnostics[0]?.code, "state_read_error");

  const lockedCwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-locked-"));
  const lockDirectory = join(lockedCwd, runnerLockPath("demo"));
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(lockDirectory, "owner"), "stale-owner\n", "utf8");
  const locked = persistPiSweRunnerState(lockedCwd, { topic: "demo", ownerToken: "owner-1", runner: makeRunner() });
  assert.equal(locked[0]?.code, "owner_mismatch");
  assert.match(locked[0]?.message ?? "", /stale-owner/);

  const lockSymlinkCwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-lock-symlink-"));
  const lockOutside = mkdtempSync(join(tmpdir(), "pi-swe-runner-lock-outside-"));
  const lockParent = join(lockSymlinkCwd, ".model-artifacts/system/logs/pi-swe/demo");
  mkdirSync(lockParent, { recursive: true });
  symlinkSync(lockOutside, join(lockParent, "runner.lock"), "dir");
  const lockSymlink = persistPiSweRunnerState(lockSymlinkCwd, { topic: "demo", ownerToken: "owner-1", runner: makeRunner() });
  assert.equal(lockSymlink[0]?.code, "invalid_state");
});

test("pi-swe runner recovery distinguishes dispatch crash windows and applies idempotent controls", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runner-recovery-"));
  const identity = {
    topic: "demo",
    planRevision: 2,
    contractId: "P01-C02",
    contractPath: ".model-artifacts/initiatives/demo/plans/revisions/r2/P01-C02.md",
    contractHash: `sha256:${"a".repeat(64)}` as const,
  };
  const initial = createPiSweRunner({
    runId: "run-1",
    mode: "guided",
    until: "contract",
    identity,
    policy: { maxTurns: 4, maxRetries: 2, maxElapsedMs: 60_000 },
    startedAtMs: 1_000,
  });
  const dispatched = reducePiSweRunner({
    state: initial,
    canonical: { identity, recommendation: { stage: "implement", skill: "swe-implement", blockingReasons: [] } },
    event: { kind: "evaluate" },
    nowMs: 2_000,
  }).state;
  assert.equal(dispatched.pendingDispatch?.deliveryStatus, "prepared");
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "demo", ownerToken: "owner-1", runner: dispatched }), []);
  assert.equal(readPiSweRunnerState(cwd, "demo", "owner-1").recovery, "uncertain-dispatch");

  writeFileSync(`${join(cwd, runnerStatePath("demo"))}.tmp-crash`, "{partial", "utf8");
  assert.equal(readPiSweRunnerState(cwd, "demo", "owner-1").snapshot?.runner.pendingDispatch?.token, "run-1:1");

  assert.equal(markPiSweRunnerDispatchSent(cwd, "demo", "owner-1", "wrong-token")[0]?.code, "invalid_state");
  assert.deepEqual(markPiSweRunnerDispatchSent(cwd, "demo", "owner-1", "run-1:1"), []);
  assert.deepEqual(markPiSweRunnerDispatchSent(cwd, "demo", "owner-1", "run-1:1"), []);
  const sent = readPiSweRunnerState(cwd, "demo", "owner-1");
  assert.equal(sent.recovery, "await-checkpoint");
  assert.equal(sent.snapshot?.runner.pendingDispatch?.deliveryStatus, "sent");

  const accepted = reducePiSweRunner({
    state: sent.snapshot!.runner,
    canonical: { identity, recommendation: { stage: "verify", skill: "swe-verify", blockingReasons: [] } },
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1",
      dispatchToken: "run-1:1",
      ...identity,
      stage: "implement",
      outcome: "completed",
      evidence: [{ path: ".model-artifacts/initiatives/demo/reports/verification.md", sha256: `sha256:${"b".repeat(64)}` }],
    } },
    nowMs: 3_000,
  }).state;
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "demo", ownerToken: "owner-1", runner: accepted }), []);
  assert.equal(readPiSweRunnerState(cwd, "demo", "owner-1").recovery, "evaluate");

  assert.deepEqual(pausePersistedPiSweRunner(cwd, "demo", "owner-1"), []);
  assert.deepEqual(pausePersistedPiSweRunner(cwd, "demo", "owner-1"), []);
  const paused = readPiSweRunnerState(cwd, "demo", "owner-1");
  assert.equal(paused.recovery, "inactive");
  assert.equal(paused.snapshot?.runner.terminalReason, "operator-paused");

  assert.deepEqual(stopPersistedPiSweRunner(cwd, "demo", "owner-1"), []);
  assert.deepEqual(stopPersistedPiSweRunner(cwd, "demo", "owner-1"), []);
  const stopped = readPiSweRunnerState(cwd, "demo", "owner-1");
  assert.equal(stopped.snapshot?.runner.status, "stopped");
  assert.equal(stopped.snapshot?.runner.terminalReason, "operator-stopped");
});
