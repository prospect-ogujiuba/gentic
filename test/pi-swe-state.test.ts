import assert from "node:assert/strict";
import { test } from "node:test";

import { createSweEvidenceService, createVerificationEvidence } from "../extensions/pi-swe/src/app/evidence.ts";
import {
  createSweState,
  createSweStateService,
  normalizeSwePath,
  recordChangedPath,
  recordInspectedPath,
  recordVerification,
  resetTurnState,
  setActivePlan,
} from "../extensions/pi-swe/src/app/state.ts";

test("pi-swe state reset clears per-turn evidence and preserves active plan", () => {
  const state = recordVerification(
    recordChangedPath(recordInspectedPath(createSweState({ turnStartedAt: "t0", activePlan: { source: "todo", marker: " TASK-1 " } }), "./src/../src/a.ts"), "src/a.ts"),
    createVerificationEvidence({ kind: "command", command: "npm test", exitCode: 0, scope: "focused", timestamp: "t1" }),
  );

  const reset = resetTurnState(state, "t2");

  assert.equal(reset.turnStartedAt, "t2");
  assert.deepEqual(reset.activePlan, { source: "todo", marker: "TASK-1" });
  assert.deepEqual(reset.inspectedPaths, []);
  assert.deepEqual(reset.changedPaths, []);
  assert.deepEqual(reset.verification, []);
  assert.deepEqual(state.inspectedPaths, ["src/a.ts"]);
});

test("pi-swe state normalizes and deduplicates inspected and changed paths", () => {
  let state = createSweState();
  state = recordInspectedPath(state, "./src//a.ts");
  state = recordInspectedPath(state, "src/a.ts");
  state = recordChangedPath(state, "src\\b.ts");
  state = recordChangedPath(state, "./src/b.ts");

  assert.equal(normalizeSwePath(" ./src/../src/a.ts/ "), "src/a.ts");
  assert.deepEqual(state.inspectedPaths, ["src/a.ts"]);
  assert.deepEqual(state.changedPaths, ["src/b.ts"]);
});

test("pi-swe verification evidence represents command and manual scopes", () => {
  let state = createSweState();
  state = recordVerification(state, createVerificationEvidence({ kind: "command", command: "node --test test/unit.test.ts", exitCode: 1, scope: "focused", timestamp: "t1" }));
  state = recordVerification(state, createVerificationEvidence({ kind: "note", note: "reviewed adjacent renderer manually", scope: "nearby", timestamp: "t2" }));
  state = recordVerification(state, createVerificationEvidence({ kind: "command", command: "npm test", exitCode: 0, scope: "broad", timestamp: "t3" }));
  state = recordVerification(state, createVerificationEvidence({ kind: "note", note: "manual smoke check", scope: "manual", timestamp: "t4" }));

  assert.deepEqual(state.verification.map((evidence) => evidence.scope), ["focused", "nearby", "broad", "manual"]);
  assert.equal(state.verification[0].exitCode, 1);
  assert.equal(state.verification[1].note, "reviewed adjacent renderer manually");
});

test("pi-swe active plan markers support todo artifact and prompt sources", () => {
  const base = createSweState();

  assert.deepEqual(setActivePlan(base, { source: "todo", marker: " todo-1 " }).activePlan, { source: "todo", marker: "todo-1" });
  assert.deepEqual(setActivePlan(base, { source: "artifact", marker: " .model-artifacts/todo/pi-swe/plan.md " }).activePlan, { source: "artifact", marker: ".model-artifacts/todo/pi-swe/plan.md" });
  assert.deepEqual(setActivePlan(base, { source: "prompt", marker: "user request" }).activePlan, { source: "prompt", marker: "user request" });
  assert.equal(setActivePlan(base, undefined).activePlan, undefined);
});

test("pi-swe app state and evidence services use explicit clocks", () => {
  const stateService = createSweStateService({ now: () => "t-service" });
  const evidenceService = createSweEvidenceService({ now: () => "t-evidence" });

  const reset = stateService.resetTurn(createSweState({ turnStartedAt: "t0", activePlan: { source: "todo", marker: "todo-1" } }));
  const verified = stateService.recordVerification(reset, evidenceService.createCommandEvidence({ command: "npm run test:swe", exitCode: 0, scope: "focused" }));

  assert.equal(reset.turnStartedAt, "t-service");
  assert.deepEqual(reset.activePlan, { source: "todo", marker: "todo-1" });
  assert.deepEqual(verified.verification, [{ kind: "command", command: "npm run test:swe", exitCode: 0, scope: "focused", timestamp: "t-evidence" }]);
});
