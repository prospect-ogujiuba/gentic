import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  createContextPressureState,
  evaluateContextPressure,
  reduceContextPressure,
} from "../extensions/pi-context/src/domain/index.ts";

const exact = (remainingPercent: number) => ({
  tokens: 100 - remainingPercent,
  contextWindow: 100,
  percent: 100 - remainingPercent,
  tokenConfidence: "exact" as const,
});

test("pressure classification uses exact warning and critical boundaries", () => {
  assert.equal(evaluateContextPressure(exact(26)).level, "normal");
  assert.equal(evaluateContextPressure(exact(25)).level, "warning");
  assert.equal(evaluateContextPressure(exact(11)).level, "warning");
  assert.equal(evaluateContextPressure(exact(10)).level, "critical");
  assert.equal(evaluateContextPressure(exact(0)).level, "critical");
});

test("missing and estimated usage is unavailable and never notifies", () => {
  const missing = reduceContextPressure(createContextPressureState(), undefined);
  const estimated = reduceContextPressure(createContextPressureState(), {
    percent: 95,
    tokenConfidence: "estimated",
  });

  assert.deepEqual(missing.evaluation, { available: false, level: "unavailable", shouldNotify: false, reason: "usage-unavailable" });
  assert.equal(estimated.evaluation.available, false);
  assert.equal(estimated.evaluation.shouldNotify, false);
  assert.equal(estimated.state.level, "normal");
});

test("transition reducer suppresses duplicates and rearms beyond hysteresis", () => {
  let state = createContextPressureState();
  let result = reduceContextPressure(state, exact(25), DEFAULT_CONTEXT_PRESSURE_POLICY, 1_000);
  assert.equal(result.evaluation.notification, "warning");
  state = result.state;

  result = reduceContextPressure(state, exact(24), DEFAULT_CONTEXT_PRESSURE_POLICY, 2_000);
  assert.equal(result.evaluation.shouldNotify, false);
  state = result.state;

  result = reduceContextPressure(state, exact(10), DEFAULT_CONTEXT_PRESSURE_POLICY, 3_000);
  assert.equal(result.evaluation.notification, "critical");
  state = result.state;

  result = reduceContextPressure(state, exact(16), DEFAULT_CONTEXT_PRESSURE_POLICY, 4_000);
  assert.equal(result.evaluation.level, "warning");
  assert.equal(result.evaluation.shouldNotify, false);
  state = result.state;

  result = reduceContextPressure(state, exact(10), DEFAULT_CONTEXT_PRESSURE_POLICY, 5_000);
  assert.equal(result.evaluation.notification, "critical", "critical rearms above 15% remaining");
  state = result.state;

  result = reduceContextPressure(state, exact(30), DEFAULT_CONTEXT_PRESSURE_POLICY, 6_000);
  assert.equal(result.evaluation.level, "warning", "warning recovers only beyond its hysteresis boundary");
  state = result.state;

  result = reduceContextPressure(state, exact(31), DEFAULT_CONTEXT_PRESSURE_POLICY, 7_000);
  assert.equal(result.evaluation.level, "normal");
  state = result.state;

  result = reduceContextPressure(state, exact(25), DEFAULT_CONTEXT_PRESSURE_POLICY, 8_000);
  assert.equal(result.evaluation.notification, "warning");
});

test("remaining percentage is derived from exact token counts when percent is absent", () => {
  const result = evaluateContextPressure({ tokens: 75, contextWindow: 100, tokenConfidence: "exact" });
  assert.equal(result.available, true);
  assert.equal(result.remainingPercent, 25);
  assert.equal(result.level, "warning");
});
