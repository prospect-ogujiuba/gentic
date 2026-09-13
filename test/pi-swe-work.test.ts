import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";

import { createRuntime } from "../extensions/pi-swe/src/app/runtime.ts";
import { persistPiSweRunnerState, readPiSweRunnerState } from "../extensions/pi-swe/src/app/runner-persistence.ts";
import { createPiSweRunner, reducePiSweRunner, type PiSweRunnerStage } from "../extensions/pi-swe/src/domain/runner.ts";
import { registerSweCommands } from "../extensions/pi-swe/src/pi/commands.ts";
import { registerSweTools } from "../extensions/pi-swe/src/pi/tools.ts";

const sha256 = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}` as const;

function writeFile(cwd: string, path: string, content: string): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function canonicalFixture(topic = "guided-runner", cwd = mkdtempSync(join(tmpdir(), "pi-swe-work-"))): string {
  const specPath = `.model-artifacts/initiatives/${topic}/specs/spec.md`;
  const manifestPath = `.model-artifacts/initiatives/${topic}/specs/manifest.json`;
  const planPath = `.model-artifacts/initiatives/${topic}/plans/plan.md`;
  const contractRoot = `.model-artifacts/initiatives/${topic}/plans/revisions/r1`;
  const contractPath = `${contractRoot}/contracts/01.md`;
  const reviewPath = `.model-artifacts/initiatives/${topic}/reports/plan-review.md`;
  const spec = "# spec\n", plan = "# plan\n", contract = "# contract\n";
  writeFile(cwd, specPath, spec);
  writeFile(cwd, planPath, plan);
  writeFile(cwd, contractPath, contract);
  writeFile(cwd, reviewPath, "# review\n");
  writeFile(cwd, `${contractRoot}/contracts.json`, JSON.stringify({
    schemaVersion: 2,
    contracts: [{ kind: "phase", id: "P01-C01", dependsOn: [], planRevision: 1, path: contractPath, status: "pending", contentHash: sha256(contract) }],
    contractFacts: { "P01-C01": { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true } },
    consequentialSpecialists: [],
    completionRecords: {},
  }));
  writeFile(cwd, manifestPath, JSON.stringify({
    schemaVersion: 2, initiativeId: topic, topic, initiativeState: "executing",
    activeSpec: { revision: 1, path: specPath, contentHash: sha256(spec) },
    activePlan: { revision: 1, path: planPath, contractRoot, contentHash: sha256(plan) },
    activeContract: { id: "P01-C01", path: contractPath },
    specialists: Object.fromEntries(["diagnosis", "dsa", "tdd", "security", "migration", "performance", "accessibility-ux", "operations", "compatibility"].map((id) => [id, { status: "not-required", rationale: `${id} not required` }])),
    approval: { decision: "approved", planRevision: 1, planPath, planContentHash: sha256(plan), reviewPath, approvedAt: "2026-09-11T00:00:00.000Z", blockingFindings: 0 },
    updatedAt: "2026-09-11T00:00:00.000Z",
  }));
  return cwd;
}

function commandHarness(cwd: string, idle = true) {
  const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    registerCommand(name: string, command: { handler: Function; getArgumentCompletions?: Function }) { commands.set(name, command); },
  };
  const runtime = createRuntime({ cwd, sessionId: "session-1" } as never);
  registerSweCommands(pi as never, runtime);
  const ctx = {
    cwd,
    sessionId: "session-1",
    isIdle: () => idle,
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  };
  return { swe: commands.get("swe")!, ctx, notifications, runtime };
}

test("/swe work conservatively authorizes start and reports exact persisted policy", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd);

  await swe.handler("work status guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot, undefined, "status must not create a run");

  await swe.handler("work start guided-runner --mode autonomous --until initiative --max-turns 7 --max-minutes 12", ctx);
  const started = readPiSweRunnerState(cwd, "guided-runner", "session-1");
  assert.deepEqual(started.diagnostics, []);
  assert.equal(started.snapshot?.runner.mode, "autonomous");
  assert.equal(started.snapshot?.runner.until, "initiative");
  assert.equal(started.snapshot?.runner.policy.maxTurns, 7);
  assert.equal(started.snapshot?.runner.policy.maxElapsedMs, 12 * 60_000);
  assert.equal(started.snapshot?.runner.status, "running");
  assert.equal(started.snapshot?.runner.identity.contractId, "P01-C01");
  assert.match(notifications.at(-1)?.message ?? "", /mode: autonomous/);
  assert.match(notifications.at(-1)?.message ?? "", /stage: await-evaluation/);
  const runId = started.snapshot?.runner.runId;
  await swe.handler("work start guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.runId, runId, "busy start must not replace the active run");

  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work start transfers ownership only after the previous runner is terminal", async () => {
  const cwd = canonicalFixture();
  const ownerOne = commandHarness(cwd);
  const ownerTwo = commandHarness(cwd);
  ownerTwo.ctx.sessionId = "session-2";

  await ownerOne.swe.handler("work start guided-runner", ownerOne.ctx);
  const activeRunId = readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.runId;

  await ownerTwo.swe.handler("work start guided-runner", ownerTwo.ctx);
  const protectedRunner = readPiSweRunnerState(cwd, "guided-runner").snapshot;
  assert.equal(protectedRunner?.ownerToken, "session-1");
  assert.equal(protectedRunner?.runner.runId, activeRunId, "a non-owner must not replace an active run");

  await ownerOne.swe.handler("work stop guided-runner", ownerOne.ctx);
  await ownerTwo.swe.handler("work start guided-runner", ownerTwo.ctx);
  const replacement = readPiSweRunnerState(cwd, "guided-runner", "session-2");
  assert.deepEqual(replacement.diagnostics, []);
  assert.equal(replacement.snapshot?.ownerToken, "session-2");
  assert.match(replacement.snapshot?.runner.runId ?? "", /^session-2:/);
  assert.equal(replacement.snapshot?.runner.status, "running");
  assert.notEqual(replacement.snapshot?.runner.runId, activeRunId);

  const completedRunner = { ...replacement.snapshot!.runner, status: "complete" as const, terminalReason: "initiative-complete" };
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-2", runner: completedRunner }), []);
  const ownerThree = commandHarness(cwd);
  ownerThree.ctx.sessionId = "session-3";
  await ownerThree.swe.handler("work start guided-runner", ownerThree.ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.ownerToken, "session-3");

  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work uses one context window by default without numeric turn or time limits", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd);

  await swe.handler("work start guided-runner", ctx);

  const started = readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner;
  assert.equal(started?.mode, "guided");
  assert.equal(started?.until, "context");
  assert.deepEqual(started?.policy, { maxRetries: 2 });
  assert.match(notifications.at(-1)?.message ?? "", /max-turns=unlimited/);
  assert.match(notifications.at(-1)?.message ?? "", /max-elapsed-ms=unlimited/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work uses bounded configured policy defaults without enabling implicit autonomy", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, runtime } = commandHarness(cwd);
  runtime.config = { ...runtime.config, runner: { maxTurns: 8, maxRetries: 3, maxMinutes: 45 } };

  await swe.handler("work start guided-runner", ctx);

  const started = readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner;
  assert.equal(started?.mode, "guided");
  assert.equal(started?.until, "context");
  assert.deepEqual(started?.policy, { maxTurns: 8, maxRetries: 3, maxElapsedMs: 45 * 60_000 });
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work status and operator stops remain available when canonical metadata is missing", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd);
  await swe.handler("work start guided-runner", ctx);
  rmSync(join(cwd, ".model-artifacts/initiatives/guided-runner/specs/manifest.json"));

  await swe.handler("work status guided-runner", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /run: session-1:/);
  await swe.handler("work pause guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, "paused");
  await swe.handler("work stop guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, "stopped");
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work start selects the deterministic ready contract when activeContract is absent", async () => {
  const cwd = canonicalFixture();
  const manifestPath = join(cwd, ".model-artifacts/initiatives/guided-runner/specs/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.activeContract;
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const contractRoot = ".model-artifacts/initiatives/guided-runner/plans/revisions/r1";
  const secondPath = `${contractRoot}/contracts/02.md`;
  const second = "# contract 02\n";
  writeFile(cwd, secondPath, second);
  const indexPath = join(cwd, contractRoot, "contracts.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.contracts.push({ kind: "phase", id: "P01-C02", dependsOn: [], planRevision: 1, path: secondPath, status: "pending", contentHash: sha256(second) });
  index.contractFacts["P01-C02"] = { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true };
  writeFileSync(indexPath, JSON.stringify(index), "utf8");
  const { swe, ctx, notifications } = commandHarness(cwd);

  await swe.handler("work start guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.identity.contractId, "P01-C01", notifications.at(-1)?.message);
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work pause, resume, and stop are explicit and idempotent", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx } = commandHarness(cwd);
  await swe.handler("work start guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.mode, "guided");
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.until, "context");

  await swe.handler("work pause guided-runner", ctx);
  await swe.handler("work pause guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, "paused");
  await swe.handler("work resume guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, "running");
  await swe.handler("work stop guided-runner", ctx);
  await swe.handler("work stop guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, "stopped");
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work resume replaces an exhausted legacy budget with current context defaults", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd);
  await swe.handler("work start guided-runner --until contract --max-turns 1 --max-minutes 30", ctx);
  const original = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  assert.deepEqual(persistPiSweRunnerState(cwd, {
    topic: "guided-runner",
    ownerToken: "session-1",
    runner: {
      ...original.runner,
      status: "paused",
      turnCount: 1,
      lastAcceptedDispatchSequence: 1,
      nextDispatchSequence: 2,
      terminalReason: "turn-budget-exhausted",
    },
  }), []);

  const contractRoot = ".model-artifacts/initiatives/guided-runner/plans/revisions/r1";
  const nextContractPath = `${contractRoot}/contracts/02.md`;
  const nextContract = "# contract 02\n";
  writeFile(cwd, nextContractPath, nextContract);
  const indexPath = join(cwd, contractRoot, "contracts.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.contracts[0].status = "complete";
  index.contracts.push({ kind: "phase", id: "P01-C02", dependsOn: ["P01-C01"], planRevision: 1, path: nextContractPath, status: "pending", contentHash: sha256(nextContract) });
  index.contractFacts["P01-C02"] = { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true };
  writeFileSync(indexPath, JSON.stringify(index), "utf8");
  const manifestPath = join(cwd, ".model-artifacts/initiatives/guided-runner/specs/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.activeContract = { id: "P01-C02", path: nextContractPath };
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  await swe.handler("work resume guided-runner", ctx);
  const resumed = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  assert.notEqual(resumed.runner.runId, original.runner.runId, notifications.at(-1)?.message);
  assert.equal(resumed.runner.identity.contractId, "P01-C02");
  assert.equal(resumed.runner.until, "context");
  assert.deepEqual(resumed.runner.policy, { maxRetries: 2 });
  assert.equal(resumed.runner.turnCount, 0);
  assert.equal(resumed.runner.status, "running");

  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work resume rejects a non-exhausted stale runner identity", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd);
  await swe.handler("work start guided-runner", ctx);
  const original = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  assert.deepEqual(persistPiSweRunnerState(cwd, {
    topic: "guided-runner",
    ownerToken: "session-1",
    runner: {
      ...original.runner,
      identity: { ...original.runner.identity, contractId: "P00-C01" },
      status: "paused",
      terminalReason: "operator-paused",
    },
  }), []);

  await swe.handler("work resume guided-runner", ctx);
  const unchanged = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  assert.equal(unchanged.runner.runId, original.runner.runId);
  assert.equal(unchanged.runner.status, "paused");
  assert.match(notifications.at(-1)?.message ?? "", /persisted runner identity is stale/);
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work resume safely starts a fresh run when a new session takes ownership", async () => {
  const cwd = canonicalFixture();
  const ownerOne = commandHarness(cwd);
  await ownerOne.swe.handler("work start guided-runner", ownerOne.ctx);
  const original = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  const prepared = reducePiSweRunner({
    state: original.runner,
    canonical: { identity: original.runner.identity, recommendation: { stage: "implement", skill: "swe-implement", blockingReasons: [] } },
    event: { kind: "evaluate" },
    nowMs: Date.now(),
  }).state;
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-1", runner: prepared }), []);
  await ownerOne.swe.handler("work pause guided-runner", ownerOne.ctx);

  const ownerTwo = commandHarness(cwd);
  ownerTwo.ctx.sessionId = "session-2";
  await ownerTwo.swe.handler("work resume guided-runner", ownerTwo.ctx);
  const resumed = readPiSweRunnerState(cwd, "guided-runner", "session-2");
  assert.deepEqual(resumed.diagnostics, []);
  assert.equal(resumed.snapshot?.ownerToken, "session-2");
  assert.match(resumed.snapshot?.runner.runId ?? "", /^session-2:/);
  assert.notEqual(resumed.snapshot?.runner.runId, original.runner.runId);
  assert.equal(resumed.snapshot?.runner.status, "running");
  assert.equal(resumed.snapshot?.runner.pendingDispatch, undefined, "takeover must invalidate an old session's pending dispatch");
  assert.equal(resumed.snapshot?.runner.turnCount, 0);
  assert.equal(
    persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-1", runner: prepared })[0]?.code,
    "owner_mismatch",
    "the prior owner must not mutate the replacement run",
  );

  const ownerThree = commandHarness(cwd);
  ownerThree.ctx.sessionId = "session-3";
  await ownerThree.swe.handler("work resume guided-runner", ownerThree.ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.ownerToken, "session-3", "explicit resume must take over a running stale-session runner");

  const ownedByThree = readPiSweRunnerState(cwd, "guided-runner", "session-3").snapshot!;
  assert.deepEqual(persistPiSweRunnerState(cwd, {
    topic: "guided-runner",
    ownerToken: "session-3",
    runner: { ...ownedByThree.runner, status: "blocked", terminalReason: "human-only-decision" },
  }), []);
  const ownerFour = commandHarness(cwd);
  ownerFour.ctx.sessionId = "session-4";
  await ownerFour.swe.handler("work resume guided-runner", ownerFour.ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.ownerToken, "session-4");

  rmSync(cwd, { recursive: true, force: true });
});

test("swe_checkpoint accepts only the active dispatch and exact canonical evidence identity", async () => {
  const cwd = canonicalFixture();
  const { swe, ctx } = commandHarness(cwd);
  await swe.handler("work start guided-runner", ctx);
  const started = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!;
  const prepared = reducePiSweRunner({
    state: started.runner,
    canonical: { identity: started.runner.identity, recommendation: { stage: "implement", skill: "swe-implement", blockingReasons: [] } },
    event: { kind: "evaluate" },
    nowMs: Date.now(),
  }).state;
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-1", runner: prepared }), []);

  const evidencePath = ".model-artifacts/initiatives/guided-runner/logs/implementation.md";
  const evidence = "implemented\n";
  writeFile(cwd, evidencePath, evidence);
  const tools = new Map<string, { execute: Function; parameters: object }>();
  registerSweTools({ registerTool(tool: { name: string; execute: Function; parameters: object }) { tools.set(tool.name, tool); } } as never);
  const checkpoint = tools.get("swe_checkpoint");
  assert.ok(checkpoint, "structured checkpoint tool must be registered");
  assert.equal(Value.Check(checkpoint.parameters, {}), false, "malformed checkpoints must fail the registered schema");
  assert.equal(Value.Check(checkpoint.parameters, { runId: "x", dispatchToken: "x:1", topic: "guided-runner" }), false);
  const params = {
    runId: prepared.runId,
    dispatchToken: prepared.pendingDispatch!.token,
    ...prepared.identity,
    stage: "implement",
    outcome: "completed",
    evidence: [{ path: evidencePath, sha256: sha256(evidence) }],
  };
  const accepted = await checkpoint.execute("call-1", params, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(accepted.details.status, "accepted");
  const persisted = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!.runner;
  assert.equal(persisted.pendingDispatch, undefined);
  assert.equal(persisted.lastAcceptedDispatchSequence, 1);

  const duplicate = await checkpoint.execute("call-2", params, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(duplicate.details.status, "rejected");
  assert.match(duplicate.details.message, /duplicate-checkpoint/);
  const contradictory = await checkpoint.execute("call-3", { ...params, outcome: "retry", failureSignature: "different-result" }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(contradictory.details.status, "rejected");
  const blocked = readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!.runner;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.terminalReason, "invalid-checkpoint");
  const stale = await checkpoint.execute("call-4", { ...params, dispatchToken: `${prepared.runId}:2` }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(stale.details.status, "rejected");
  const staleIdentity = await checkpoint.execute("call-5", { ...params, contractHash: `sha256:${"0".repeat(64)}` }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(staleIdentity.details.status, "rejected");
  const staleEvidence = await checkpoint.execute("call-6", { ...params, evidence: [{ path: evidencePath, sha256: `sha256:${"0".repeat(64)}` }] }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(staleEvidence.details.status, "rejected");
  assert.match(staleEvidence.details.message, /hash is stale/);
  const escaped = await checkpoint.execute("call-7", { ...params, evidence: [{ path: "../outside.md", sha256: sha256(evidence) }] }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(escaped.details.status, "rejected");
  const oversizedPath = ".model-artifacts/initiatives/guided-runner/logs/oversized.md";
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  writeFile(cwd, oversizedPath, oversized);
  const oversizedResult = await checkpoint.execute("call-8", { ...params, evidence: [{ path: oversizedPath, sha256: sha256(oversized) }] }, undefined, undefined, { cwd, sessionId: "session-1" });
  assert.equal(oversizedResult.details.status, "rejected");
  assert.match(oversizedResult.details.message, /exceeds/);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner", "session-1").snapshot!.runner.lastAcceptedDispatchSequence, 1);
  rmSync(cwd, { recursive: true, force: true });
});

test("swe_checkpoint accepts and surfaces every valid reducer outcome without executing it", async () => {
  const scenarios: Array<{
    name: string;
    stage: PiSweRunnerStage;
    outcome: "completed" | "retry" | "return-to-plan" | "contract-ready" | "blocked";
    expectedAction: string;
    expectedStatus: "running" | "paused" | "blocked";
    failureSignature?: string;
    blockedCase?: "unsafe-operation";
    exhausted?: boolean;
  }> = [
    { name: "completed", stage: "implement", outcome: "completed", expectedAction: "none", expectedStatus: "running" },
    { name: "retry", stage: "verify", outcome: "retry", failureSignature: "focused-failure", expectedAction: "none", expectedStatus: "running" },
    { name: "terminal-retry", stage: "verify", outcome: "retry", failureSignature: "focused-failure", exhausted: true, expectedAction: "blocked-handoff", expectedStatus: "blocked" },
    { name: "blocked", stage: "implement", outcome: "blocked", blockedCase: "unsafe-operation", expectedAction: "blocked-handoff", expectedStatus: "blocked" },
    { name: "return-to-plan", stage: "implementation-review", outcome: "return-to-plan", expectedAction: "pause", expectedStatus: "paused" },
    { name: "contract-ready", stage: "implementation-review", outcome: "contract-ready", expectedAction: "complete-contract", expectedStatus: "running" },
  ];

  for (const scenario of scenarios) {
    const cwd = canonicalFixture();
    const identity = {
      topic: "guided-runner",
      planRevision: 1,
      contractId: "P01-C01",
      contractPath: ".model-artifacts/initiatives/guided-runner/plans/revisions/r1/contracts/01.md",
      contractHash: sha256("# contract\n"),
    };
    const retryKey = `r1/P01-C01:verify->implement:${scenario.failureSignature}`;
    const initial = createPiSweRunner({
      runId: `run-${scenario.name}`,
      mode: "guided",
      until: "contract",
      identity,
      policy: { maxTurns: 6, maxRetries: scenario.exhausted ? 1 : 2, maxElapsedMs: 60_000 },
      startedAtMs: 1,
    });
    const seeded = scenario.exhausted ? { ...initial, retryCounts: { [retryKey]: 1 } } : initial;
    const prepared = reducePiSweRunner({
      state: seeded,
      canonical: { identity, recommendation: { stage: scenario.stage, skill: "swe-implement", blockingReasons: [] } },
      event: { kind: "evaluate" },
      nowMs: 2,
    }).state;
    assert.deepEqual(persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-1", runner: prepared }), []);
    const evidencePath = `.model-artifacts/initiatives/guided-runner/reports/${scenario.name}.md`;
    const evidence = `${scenario.name}\n`;
    writeFile(cwd, evidencePath, evidence);
    const tools = new Map<string, { execute: Function; parameters: object }>();
    registerSweTools({ registerTool(tool: { name: string; execute: Function; parameters: object }) { tools.set(tool.name, tool); } } as never);
    const result = await tools.get("swe_checkpoint")!.execute("call", {
      runId: prepared.runId,
      dispatchToken: prepared.pendingDispatch!.token,
      ...identity,
      stage: scenario.stage,
      outcome: scenario.outcome,
      ...(scenario.failureSignature ? { failureSignature: scenario.failureSignature } : {}),
      ...(scenario.blockedCase ? { blockedCase: scenario.blockedCase } : {}),
      evidence: [{ path: evidencePath, sha256: sha256(evidence) }],
    }, undefined, undefined, { cwd });

    assert.equal(result.details.status, "accepted", scenario.name);
    assert.equal(result.details.action.kind, scenario.expectedAction, scenario.name);
    assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.status, scenario.expectedStatus, scenario.name);
    rmSync(cwd, { recursive: true, force: true });
  }

  const cwd = canonicalFixture();
  const identity = {
    topic: "guided-runner", planRevision: 1, contractId: "P01-C01",
    contractPath: ".model-artifacts/initiatives/guided-runner/plans/revisions/r1/contracts/01.md",
    contractHash: sha256("# contract\n"),
  };
  const initial = createPiSweRunner({ runId: "run-invalid", mode: "guided", until: "contract", identity, policy: { maxTurns: 3, maxRetries: 1, maxElapsedMs: 60_000 }, startedAtMs: 1 });
  const prepared = reducePiSweRunner({ state: initial, canonical: { identity, recommendation: { stage: "implement", skill: "swe-implement", blockingReasons: [] } }, event: { kind: "evaluate" }, nowMs: 2 }).state;
  persistPiSweRunnerState(cwd, { topic: "guided-runner", ownerToken: "session-1", runner: prepared });
  const evidencePath = ".model-artifacts/initiatives/guided-runner/reports/invalid-contract-ready.md";
  const evidence = "invalid\n";
  writeFile(cwd, evidencePath, evidence);
  const tools = new Map<string, { execute: Function }>();
  registerSweTools({ registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); } } as never);
  const rejected = await tools.get("swe_checkpoint")!.execute("call", {
    runId: prepared.runId, dispatchToken: prepared.pendingDispatch!.token, ...identity,
    stage: "implement", outcome: "contract-ready", evidence: [{ path: evidencePath, sha256: sha256(evidence) }],
  }, undefined, undefined, { cwd });
  assert.equal(rejected.details.status, "rejected");
  assert.equal(rejected.details.action.kind, "blocked-handoff");
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot?.runner.terminalReason, "invalid-checkpoint");
  rmSync(cwd, { recursive: true, force: true });
});

test("/swe work rejects invalid, ambiguous, busy, and implicit autonomous starts without state", async () => {
  const cases = [
    "work start guided-runner --mode auto",
    "work start guided-runner --mode autonomous --mode guided",
    "work start guided-runner --max-turns 0",
    "work start guided-runner --max-turns 1e2",
    "work start guided-runner --until forever",
    "work start guided-runner --max-minutes 1441",
    "work start guided-runner --unknown value",
    "work start guided-runner extra-topic",
  ];
  for (const args of cases) {
    const cwd = canonicalFixture();
    const { swe, ctx, notifications } = commandHarness(cwd);
    await swe.handler(args, ctx);
    assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot, undefined, args);
    assert.equal(notifications.at(-1)?.type, "warning", args);
    rmSync(cwd, { recursive: true, force: true });
  }

  const ambiguousCwd = canonicalFixture("one");
  canonicalFixture("two", ambiguousCwd);
  const ambiguous = commandHarness(ambiguousCwd);
  await ambiguous.swe.handler("work start", ambiguous.ctx);
  assert.equal(readPiSweRunnerState(ambiguousCwd, "one").snapshot, undefined);
  assert.equal(readPiSweRunnerState(ambiguousCwd, "two").snapshot, undefined);
  assert.match(ambiguous.notifications.at(-1)?.message ?? "", /ambiguous/);
  rmSync(ambiguousCwd, { recursive: true, force: true });

  const cwd = canonicalFixture();
  const { swe, ctx, notifications } = commandHarness(cwd, false);
  await swe.handler("work start guided-runner", ctx);
  assert.equal(readPiSweRunnerState(cwd, "guided-runner").snapshot, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /idle/i);
  rmSync(cwd, { recursive: true, force: true });
});
