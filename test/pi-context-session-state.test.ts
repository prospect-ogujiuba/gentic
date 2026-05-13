import test from "node:test";
import assert from "node:assert/strict";
import {
  getSessionState,
  resetSessionState,
  startSessionState,
  updateSessionState,
} from "../extensions/pi-context/src/app/index.ts";

test("session_start initializes an empty ledger before provider requests", () => {
  const state = startSessionState({
    reason: "startup",
    at: "2026-05-13T01:00:00.000Z",
    metadata: { sessionId: "s-1", cwd: "/repo", modelId: "m", contextWindow: 200000 },
    usageSnapshot: { tokens: 42, contextWindow: 200000, percent: 0.021, tokenConfidence: "estimated" },
  });

  assert.equal(state.active, true);
  assert.equal(state.metadata.sessionId, "s-1");
  assert.deepEqual(state.ledgerEntries, []);
  assert.equal(state.beforeFirstProviderRequest, true);
  assert.equal(state.usageSnapshots.length, 1);
  assert.equal(state.usageSnapshots[0]?.event, "session_start");
});

test("before_provider_request marks the first request without adding ledger entries", () => {
  startSessionState({ reason: "startup", at: "2026-05-13T01:00:00.000Z", metadata: { sessionId: "s-1" } });
  const state = updateSessionState({ event: "before_provider_request", at: "2026-05-13T01:00:01.000Z" });

  assert.equal(state.beforeFirstProviderRequest, false);
  assert.equal(state.firstProviderRequestAt, "2026-05-13T01:00:01.000Z");
  assert.deepEqual(state.ledgerEntries, []);
});

test("session reset prevents entries and metadata leaking across sessions", () => {
  startSessionState({ reason: "startup", at: "2026-05-13T01:00:00.000Z", metadata: { sessionId: "old", cwd: "/old" } });
  const reset = resetSessionState("fork", "2026-05-13T01:00:02.000Z");

  assert.equal(reset.active, false);
  assert.equal(reset.resetReason, "fork");
  assert.deepEqual(reset.metadata, {});
  assert.deepEqual(reset.ledgerEntries, []);

  const next = startSessionState({ reason: "fork", at: "2026-05-13T01:00:03.000Z", metadata: { sessionId: "new", cwd: "/new" } });
  assert.equal(next.metadata.sessionId, "new");
  assert.equal(next.metadata.cwd, "/new");
  assert.notEqual(next.generation, reset.generation);
});

test("compact clears in-memory ledger observations for the continuing session", () => {
  startSessionState({ reason: "startup", at: "2026-05-13T01:00:00.000Z", metadata: { sessionId: "s-1" } });
  const state = updateSessionState({ event: "session_compact", at: "2026-05-13T01:00:04.000Z" });

  assert.equal(state.active, true);
  assert.deepEqual(state.ledgerEntries, []);
  assert.equal(getSessionState()?.lifecycleEvents.at(-1)?.type, "session_compact");
});
