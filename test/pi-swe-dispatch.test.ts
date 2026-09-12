import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { persistPiSweRunnerState, readPiSweRunnerState } from "../extensions/pi-swe/src/app/runner-persistence.ts";
import { createRuntime } from "../extensions/pi-swe/src/app/runtime.ts";
import { createPiSweRunner, reducePiSweRunner } from "../extensions/pi-swe/src/domain/runner.ts";
import { registerSweCommands } from "../extensions/pi-swe/src/pi/commands.ts";
import { settlePiSweRunner } from "../extensions/pi-swe/src/pi/work-runner.ts";

const sha256 = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}` as const;

function writeFile(cwd: string, path: string, content: string): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function fixture(seedRunner = true): { cwd: string; topic: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-dispatch-"));
  const topic = "guided-runner";
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
    contracts: [
      { kind: "phase", id: "P01", dependsOn: [], planRevision: 1, path: contractPath, status: "pending", contentHash: sha256(contract) },
      { kind: "subphase", parentId: "P01", id: "P01-C01", dependsOn: [], planRevision: 1, path: contractPath, status: "pending", contentHash: sha256(contract) },
    ],
    contractFacts: {
      P01: { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true },
      "P01-C01": { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true },
    },
    consequentialSpecialists: [], completionRecords: {},
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
  const identity = { topic, planRevision: 1, contractId: "P01-C01", contractPath, contractHash: sha256(contract) };
  if (seedRunner) {
    const runner = createPiSweRunner({ runId: "session-1:1", mode: "guided", until: "contract", identity, policy: { maxTurns: 6, maxRetries: 2, maxElapsedMs: 60_000 }, startedAtMs: 1 });
    assert.deepEqual(persistPiSweRunnerState(cwd, { topic, ownerToken: "session-1", runner }), []);
  }
  return { cwd, topic };
}

test("work start kicks the initial dispatch while settled events own continuations", async () => {
  const { cwd, topic } = fixture(false);
  const commands = new Map<string, { handler: Function }>();
  const sent: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
    sendUserMessage(content: string) { sent.push(content); },
  };
  registerSweCommands(pi as never, createRuntime({ cwd } as never));
  const ctx = {
    cwd, isIdle: () => true, sessionManager: { getSessionId: () => "session-1" },
    ui: { notify() {} },
  };

  await commands.get("swe")!.handler(`work start ${topic}`, ctx);

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /^\/skill:swe-implement /);
  assert.equal(readPiSweRunnerState(cwd, topic).snapshot?.runner.pendingDispatch?.deliveryStatus, "sent");
  rmSync(cwd, { recursive: true, force: true });
});

test("settled dispatcher persists intent before one expanded canonical skill prompt", async () => {
  const { cwd, topic } = fixture();
  const sent: Array<{ content: string; options: unknown }> = [];
  const pi = {
    sendUserMessage(content: string, options: unknown) {
      const duringSend = readPiSweRunnerState(cwd, topic, "session-1").snapshot?.runner.pendingDispatch;
      assert.equal(duringSend?.deliveryStatus, "prepared", "dispatch intent must be durable before send");
      sent.push({ content, options });
    },
  };
  const ctx = { cwd, sessionId: "session-1", isIdle: () => true, ui: { notify() {} } };

  await settlePiSweRunner(pi as never, ctx as never, topic, 2);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { expandPromptTemplates: true });
  assert.match(sent[0]?.content ?? "", /^\/skill:swe-implement /);
  assert.match(sent[0]?.content ?? "", /P01-C01/);
  assert.match(sent[0]?.content ?? "", /swe_checkpoint/);
  assert.equal(readPiSweRunnerState(cwd, topic).snapshot?.runner.pendingDispatch?.deliveryStatus, "sent");
  rmSync(cwd, { recursive: true, force: true });
});

test("a valid implement checkpoint advances the next settled dispatch to verification", async () => {
  const { cwd, topic } = fixture();
  const sent: string[] = [];
  const pi = { sendUserMessage(content: string) { sent.push(content); } };
  const ctx = { cwd, sessionId: "session-1", isIdle: () => true, ui: { notify() {} } };
  await settlePiSweRunner(pi as never, ctx as never, topic, 2);

  const dispatched = readPiSweRunnerState(cwd, topic, "session-1").snapshot!;
  const evidencePath = `.model-artifacts/initiatives/${topic}/logs/implementation.md`;
  const evidence = "implemented\n";
  writeFile(cwd, evidencePath, evidence);
  const accepted = reducePiSweRunner({
    state: dispatched.runner,
    canonical: { identity: dispatched.runner.identity, recommendation: { stage: "implement", skill: "swe-implement", blockingReasons: [] } },
    event: { kind: "checkpoint", checkpoint: {
      runId: dispatched.runner.runId,
      dispatchToken: dispatched.runner.pendingDispatch!.token,
      ...dispatched.runner.identity,
      stage: "implement",
      outcome: "completed",
      evidence: [{ path: evidencePath, sha256: sha256(evidence) }],
    } },
    nowMs: 3,
  });
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic, ownerToken: "session-1", runner: accepted.state }), []);

  await settlePiSweRunner(pi as never, ctx as never, topic, 4);

  assert.equal(sent.length, 2);
  assert.match(sent[1] ?? "", /^\/skill:swe-verify /);
  assert.match(sent[1] ?? "", new RegExp(evidencePath));
  rmSync(cwd, { recursive: true, force: true });
});

test("contract-ready checkpoint cannot bypass guarded completion evidence", async () => {
  const { cwd, topic } = fixture();
  const initial = readPiSweRunnerState(cwd, topic, "session-1").snapshot!;
  const reviewDispatch = reducePiSweRunner({
    state: initial.runner,
    canonical: { identity: initial.runner.identity, recommendation: { stage: "implementation-review", skill: "swe-review", blockingReasons: [] } },
    event: { kind: "evaluate" },
    nowMs: 2,
  });
  const reviewPath = `.model-artifacts/initiatives/${topic}/reports/review.md`;
  const review = "review without completion envelope\n";
  writeFile(cwd, reviewPath, review);
  const accepted = reducePiSweRunner({
    state: reviewDispatch.state,
    canonical: { identity: initial.runner.identity, recommendation: { stage: "implementation-review", skill: "swe-review", blockingReasons: [] } },
    event: { kind: "checkpoint", checkpoint: {
      runId: initial.runner.runId,
      dispatchToken: reviewDispatch.state.pendingDispatch!.token,
      ...initial.runner.identity,
      stage: "implementation-review",
      outcome: "contract-ready",
      evidence: [{ path: reviewPath, sha256: sha256(review) }],
    } },
    nowMs: 3,
  });
  assert.equal(accepted.action.kind, "complete-contract");
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic, ownerToken: "session-1", runner: accepted.state }), []);
  const notifications: string[] = [];

  await settlePiSweRunner({ sendUserMessage() { assert.fail("completion must not dispatch another skill"); } } as never, {
    cwd, sessionId: "session-1", isIdle: () => true, ui: { notify(message: string) { notifications.push(message); } },
  } as never, topic, 4);

  const runner = readPiSweRunnerState(cwd, topic).snapshot?.runner;
  assert.equal(runner?.status, "blocked");
  assert.equal(runner?.terminalReason, "completion-failed");
  assert.match(notifications.at(-1) ?? "", /completion rejected/i);
  rmSync(cwd, { recursive: true, force: true });
});

test("contract-ready checkpoint completes only through current hashed evidence", async () => {
  const { cwd, topic } = fixture();
  const initial = readPiSweRunnerState(cwd, topic, "session-1").snapshot!;
  const verificationPath = `.model-artifacts/initiatives/${topic}/reports/verification.md`;
  const verificationEnvelope = {
    schemaVersion: 1, mode: "verification", topic, contractId: initial.runner.identity.contractId,
    contractPath: initial.runner.identity.contractPath, planRevision: 1, contractContentHash: initial.runner.identity.contractHash,
    outcome: "pass", gaps: "none",
  };
  const verification = `# Verification\nPi-SWE-Evidence: ${JSON.stringify(verificationEnvelope)}\n`;
  writeFile(cwd, verificationPath, verification);
  const reviewPath = `.model-artifacts/initiatives/${topic}/reports/implementation-review.md`;
  const reviewEnvelope = {
    schemaVersion: 1, mode: "implementation-review", topic, contractId: initial.runner.identity.contractId,
    contractPath: initial.runner.identity.contractPath, planRevision: 1, contractContentHash: initial.runner.identity.contractHash,
    decision: "approve", blockingFindings: 0,
    verification: { path: verificationPath, contentHash: sha256(verification) },
  };
  const review = `# Review\nPi-SWE-Evidence: ${JSON.stringify(reviewEnvelope)}\n`;
  writeFile(cwd, reviewPath, review);
  const dispatched = reducePiSweRunner({
    state: initial.runner,
    canonical: { identity: initial.runner.identity, recommendation: { stage: "implementation-review", skill: "swe-review", blockingReasons: [] } },
    event: { kind: "evaluate" }, nowMs: 2,
  });
  const accepted = reducePiSweRunner({
    state: dispatched.state,
    canonical: { identity: initial.runner.identity, recommendation: { stage: "implementation-review", skill: "swe-review", blockingReasons: [] } },
    event: { kind: "checkpoint", checkpoint: {
      runId: initial.runner.runId, dispatchToken: dispatched.state.pendingDispatch!.token, ...initial.runner.identity,
      stage: "implementation-review", outcome: "contract-ready", evidence: [{ path: reviewPath, sha256: sha256(review) }],
    } }, nowMs: 3,
  });
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic, ownerToken: "session-1", runner: { ...accepted.state, until: "initiative" } }), []);

  const notifications: string[] = [];
  const sent: string[] = [];
  await settlePiSweRunner({ sendUserMessage(content: string) { sent.push(content); } } as never, {
    cwd, sessionId: "session-1", isIdle: () => true, ui: { notify(message: string) { notifications.push(message); } },
  } as never, topic, 4);

  const completedRunner = readPiSweRunnerState(cwd, topic).snapshot?.runner;
  assert.equal(completedRunner?.status, "running", notifications.at(-1));
  assert.equal(completedRunner?.pendingDispatch?.stage, "finalize");
  assert.match(sent[0] ?? "", /^\/skill:swe-finalize /);
  const index = JSON.parse(readFileSync(join(cwd, `.model-artifacts/initiatives/${topic}/plans/revisions/r1/contracts.json`), "utf8"));
  assert.equal(index.contracts.find((contract: { id: string }) => contract.id === "P01-C01").status, "complete");
  assert.ok(index.completionRecords["P01-C01"]);

  const finalizeEvidencePath = `.model-artifacts/initiatives/${topic}/reports/final-handoff.md`;
  const finalizeEvidence = "final handoff\n";
  writeFile(cwd, finalizeEvidencePath, finalizeEvidence);
  const finalized = reducePiSweRunner({
    state: completedRunner!,
    canonical: { identity: completedRunner!.identity, recommendation: { stage: "finalize", skill: "swe-finalize", blockingReasons: [] } },
    event: { kind: "checkpoint", checkpoint: {
      runId: completedRunner!.runId, dispatchToken: completedRunner!.pendingDispatch!.token, ...completedRunner!.identity,
      stage: "finalize", outcome: "completed", evidence: [{ path: finalizeEvidencePath, sha256: sha256(finalizeEvidence) }],
    } }, nowMs: 5,
  });
  assert.deepEqual(persistPiSweRunnerState(cwd, { topic, ownerToken: "session-1", runner: finalized.state }), []);
  await settlePiSweRunner({ sendUserMessage() { assert.fail("finalize checkpoint must stop"); } } as never, {
    cwd, sessionId: "session-1", isIdle: () => true, ui: { notify() {} },
  } as never, topic, 6);
  assert.equal(readPiSweRunnerState(cwd, topic).snapshot?.runner.terminalReason, "initiative-complete");
  rmSync(cwd, { recursive: true, force: true });
});

test("settled dispatcher does not duplicate a sent dispatch without its checkpoint", async () => {
  const { cwd, topic } = fixture();
  let sends = 0;
  const pi = { sendUserMessage() { sends += 1; } };
  const notifications: string[] = [];
  const ctx = { cwd, sessionId: "session-1", isIdle: () => true, ui: { notify(message: string) { notifications.push(message); } } };

  await settlePiSweRunner(pi as never, ctx as never, topic, 2);
  await settlePiSweRunner(pi as never, ctx as never, topic, 3);

  assert.equal(sends, 1);
  const runner = readPiSweRunnerState(cwd, topic).snapshot?.runner;
  assert.equal(runner?.status, "paused");
  assert.equal(runner?.terminalReason, "missing-checkpoint");
  assert.match(notifications.at(-1) ?? "", /checkpoint/i);
  rmSync(cwd, { recursive: true, force: true });
});
