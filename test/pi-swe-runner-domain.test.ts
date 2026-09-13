import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPiSweRunner,
  reducePiSweRunner,
  type PiSweRunnerCanonicalView,
  type PiSweRunnerRecord,
} from "../extensions/pi-swe/src/lifecycle.ts";

const identity = {
  topic: "demo",
  planRevision: 2,
  contractId: "P01-C01",
  contractPath: ".model-artifacts/initiatives/demo/plans/revisions/r2/contracts/P01-C01.md",
  contractHash: `sha256:${"a".repeat(64)}`,
} as const;

const evidence = [{
  path: ".model-artifacts/initiatives/demo/reports/verification.md",
  sha256: `sha256:${"b".repeat(64)}`,
}] as const;

function runner(overrides: Partial<Parameters<typeof createPiSweRunner>[0]> = {}): PiSweRunnerRecord {
  return createPiSweRunner({
    runId: "run-1",
    mode: "guided",
    until: "contract",
    identity,
    startedAtMs: 1_000,
    policy: { maxTurns: 4, maxRetries: 2, maxElapsedMs: 60_000, maxProviderUnits: 10 },
    ...overrides,
  });
}

function canonical(stage: PiSweRunnerCanonicalView["recommendation"]["stage"] = "implement", overrides: Partial<PiSweRunnerCanonicalView> = {}): PiSweRunnerCanonicalView {
  return {
    identity,
    recommendation: {
      stage,
      ...(stage === "implement" ? { skill: "swe-implement" as const } : {}),
      ...(stage === "verify" ? { skill: "swe-verify" as const } : {}),
      ...(stage === "implementation-review" ? { skill: "swe-review" as const } : {}),
      blockingReasons: [],
    },
    providerUnitsUsed: 0,
    ...overrides,
  };
}

test("pi-swe runner deterministically dispatches a canonical stage and accepts its checkpoint", () => {
  const request = { state: runner(), canonical: canonical(), event: { kind: "evaluate" } as const, nowMs: 2_000 };
  const first = reducePiSweRunner(request);
  assert.deepEqual(reducePiSweRunner(request), first);
  assert.equal(first.action.kind, "dispatch-stage");
  if (first.action.kind !== "dispatch-stage") return;
  assert.deepEqual(first.action, {
    kind: "dispatch-stage",
    stage: "implement",
    skill: "swe-implement",
    dispatchToken: "run-1:1",
    identity,
  });

  const accepted = reducePiSweRunner({
    state: first.state,
    canonical: canonical(),
    event: {
      kind: "checkpoint",
      checkpoint: {
        runId: "run-1",
        dispatchToken: "run-1:1",
        ...identity,
        stage: "implement",
        outcome: "completed",
        evidence,
      },
    },
    nowMs: 3_000,
  });
  assert.deepEqual(accepted.action, { kind: "none", reason: "checkpoint-accepted" });
  assert.equal(accepted.state.turnCount, 1);
  assert.equal(accepted.state.pendingDispatch, undefined);
  assert.equal(accepted.state.lastAcceptedDispatchSequence, 1);
});

test("pi-swe runner accepts an explicitly retried pending checkpoint after missing-checkpoint pause", () => {
  const dispatched = reducePiSweRunner({ state: runner(), canonical: canonical(), event: { kind: "evaluate" }, nowMs: 2_000 });
  const paused = { ...dispatched.state, status: "paused" as const, terminalReason: "missing-checkpoint" as const };
  const recovered = reducePiSweRunner({
    state: paused,
    canonical: canonical(),
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1", dispatchToken: "run-1:1", ...identity, stage: "implement", outcome: "completed", evidence,
    } },
    nowMs: 3_000,
  });

  assert.deepEqual(recovered.action, { kind: "none", reason: "checkpoint-accepted" });
  assert.equal(recovered.state.status, "running");
  assert.equal(recovered.state.terminalReason, undefined);
  assert.equal(recovered.state.pendingDispatch, undefined);
  assert.equal(recovered.state.lastAcceptedDispatchSequence, 1);

  const operatorPaused = { ...dispatched.state, status: "paused" as const, terminalReason: "operator-paused" as const };
  const refused = reducePiSweRunner({
    state: operatorPaused,
    canonical: canonical(),
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1", dispatchToken: "run-1:1", ...identity, stage: "implement", outcome: "completed", evidence,
    } },
    nowMs: 3_000,
  });
  assert.deepEqual(refused.action, { kind: "none", reason: "runner-not-active" });
});

test("pi-swe runner treats an accepted duplicate checkpoint as an idempotent no-op and stale identity as blocked", () => {
  const dispatched = reducePiSweRunner({ state: runner(), canonical: canonical(), event: { kind: "evaluate" }, nowMs: 2_000 });
  const checkpoint = {
    runId: "run-1",
    dispatchToken: "run-1:1",
    ...identity,
    stage: "implement" as const,
    outcome: "completed" as const,
    evidence,
  };
  const accepted = reducePiSweRunner({ state: dispatched.state, canonical: canonical(), event: { kind: "checkpoint", checkpoint }, nowMs: 3_000 });
  const duplicate = reducePiSweRunner({ state: accepted.state, canonical: canonical(), event: { kind: "checkpoint", checkpoint }, nowMs: 4_000 });
  assert.deepEqual(duplicate.action, { kind: "none", reason: "duplicate-checkpoint" });
  assert.deepEqual(duplicate.state, accepted.state);

  const contradictoryDuplicate = reducePiSweRunner({
    state: accepted.state,
    canonical: canonical(),
    event: { kind: "checkpoint", checkpoint: { ...checkpoint, outcome: "blocked", blockedCase: "unsafe-operation" } },
    nowMs: 4_000,
  });
  assert.equal(contradictoryDuplicate.action.kind, "blocked-handoff");
  assert.equal(contradictoryDuplicate.state.terminalReason, "invalid-checkpoint");

  const stale = reducePiSweRunner({
    state: dispatched.state,
    canonical: canonical(),
    event: { kind: "checkpoint", checkpoint: { ...checkpoint, contractHash: `sha256:${"c".repeat(64)}` } },
    nowMs: 3_000,
  });
  assert.equal(stale.action.kind, "blocked-handoff");
  assert.equal(stale.state.terminalReason, "invalid-checkpoint-identity");
});

test("pi-swe runner keeps turn, retry, elapsed, and provider budgets isolated", () => {
  const cases = [
    { state: { ...runner(), turnCount: 4 }, canonical: canonical(), nowMs: 2_000, reason: "turn-budget-exhausted" },
    { state: runner(), canonical: canonical(), nowMs: 61_001, reason: "time-budget-exhausted" },
    { state: runner(), canonical: canonical("implement", { providerUnitsUsed: 11 }), nowMs: 2_000, reason: "provider-budget-exhausted" },
    { state: { ...runner(), retryCount: 2 }, canonical: canonical("verify"), nowMs: 2_000, reason: undefined },
  ] as const;

  for (const entry of cases) {
    const result = reducePiSweRunner({ state: entry.state, canonical: entry.canonical, event: { kind: "evaluate" }, nowMs: entry.nowMs });
    if (entry.reason) {
      assert.equal(result.action.kind, "pause");
      assert.equal(result.state.terminalReason, entry.reason);
    } else {
      assert.equal(result.action.kind, "dispatch-stage");
    }
  }
});

test("pi-swe runner applies retry transitions and human-only return-to-plan without duplicating lifecycle tables", () => {
  const verifying = reducePiSweRunner({ state: runner(), canonical: canonical("verify"), event: { kind: "evaluate" }, nowMs: 2_000 });
  const retry = reducePiSweRunner({
    state: verifying.state,
    canonical: canonical("verify"),
    event: {
      kind: "checkpoint",
      checkpoint: {
        runId: "run-1", dispatchToken: "run-1:1", ...identity, stage: "verify", outcome: "retry",
        failureSignature: "focused-test-failed", evidence,
      },
    },
    nowMs: 3_000,
  });
  assert.deepEqual(retry.action, { kind: "none", reason: "checkpoint-accepted" });
  assert.equal(retry.state.retryCount, 1);

  const isolatedStart = runner({ policy: { maxTurns: 4, maxRetries: 1, maxElapsedMs: 60_000 } });
  const isolatedDispatchA = reducePiSweRunner({ state: isolatedStart, canonical: canonical("verify"), event: { kind: "evaluate" }, nowMs: 2_000 });
  const isolatedRetryA = reducePiSweRunner({
    state: isolatedDispatchA.state,
    canonical: canonical("verify"),
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1", dispatchToken: "run-1:1", ...identity, stage: "verify", outcome: "retry",
      failureSignature: "failure-a", evidence,
    } },
    nowMs: 3_000,
  });
  const isolatedDispatchB = reducePiSweRunner({ state: isolatedRetryA.state, canonical: canonical("verify"), event: { kind: "evaluate" }, nowMs: 4_000 });
  const isolatedRetryB = reducePiSweRunner({
    state: isolatedDispatchB.state,
    canonical: canonical("verify"),
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1", dispatchToken: "run-1:2", ...identity, stage: "verify", outcome: "retry",
      failureSignature: "failure-b", evidence,
    } },
    nowMs: 5_000,
  });
  assert.deepEqual(isolatedRetryB.action, { kind: "none", reason: "checkpoint-accepted" });

  const repeatedDispatch = reducePiSweRunner({ state: isolatedRetryA.state, canonical: canonical("verify"), event: { kind: "evaluate" }, nowMs: 4_000 });
  const repeatedFailure = reducePiSweRunner({
    state: repeatedDispatch.state,
    canonical: canonical("verify"),
    event: { kind: "checkpoint", checkpoint: {
      runId: "run-1", dispatchToken: "run-1:2", ...identity, stage: "verify", outcome: "retry",
      failureSignature: "failure-a", evidence,
    } },
    nowMs: 5_000,
  });
  assert.equal(repeatedFailure.action.kind, "blocked-handoff");
  assert.equal(repeatedFailure.state.terminalReason, "retry-budget-exhausted");

  const reviewing = reducePiSweRunner({ state: runner(), canonical: canonical("implementation-review"), event: { kind: "evaluate" }, nowMs: 2_000 });
  const replan = reducePiSweRunner({
    state: reviewing.state,
    canonical: canonical("implementation-review"),
    event: {
      kind: "checkpoint",
      checkpoint: {
        runId: "run-1", dispatchToken: "run-1:1", ...identity, stage: "implementation-review", outcome: "return-to-plan", evidence,
      },
    },
    nowMs: 3_000,
  });
  assert.equal(replan.action.kind, "pause");
  assert.equal(replan.state.terminalReason, "human-plan-revision-required");
});

test("pi-swe runner fails closed for every canonical or safety hard stop", () => {
  for (const reason of [
    "ambiguous-initiative", "stale-plan", "dependency-blocked", "missing-verifier", "missing-capability",
    "scope-drift", "conflicting-changes", "unsafe-operation", "external-side-effect", "human-only-decision",
  ] as const) {
    const result = reducePiSweRunner({ state: runner(), canonical: canonical("blocked-handoff", { hardStop: reason }), event: { kind: "evaluate" }, nowMs: 2_000 });
    assert.equal(result.action.kind, "blocked-handoff", reason);
    assert.equal(result.state.terminalReason, reason);
  }
});

test("pi-swe runner honors contract versus initiative stopping and explicit operator controls", () => {
  const disposed = canonical("finalize", { identity: undefined });
  const contractResult = reducePiSweRunner({ state: runner(), canonical: disposed, event: { kind: "evaluate" }, nowMs: 2_000 });
  assert.deepEqual(contractResult.action, { kind: "stop", reason: "contract-dispositioned" });

  const initiativeResult = reducePiSweRunner({ state: runner({ until: "initiative" }), canonical: disposed, event: { kind: "evaluate" }, nowMs: 2_000 });
  assert.deepEqual(initiativeResult.action, { kind: "finalize" });

  const paused = reducePiSweRunner({ state: runner(), canonical: canonical(), event: { kind: "pause" }, nowMs: 2_000 });
  assert.deepEqual(paused.action, { kind: "pause", reason: "operator-paused" });
  const stopped = reducePiSweRunner({ state: runner(), canonical: canonical(), event: { kind: "stop" }, nowMs: 2_000 });
  assert.deepEqual(stopped.action, { kind: "stop", reason: "operator-stopped" });
});
