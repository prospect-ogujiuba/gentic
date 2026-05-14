import assert from "node:assert/strict";
import { test } from "node:test";

import type { EffectivePiSweConfig } from "../extensions/pi-swe/src/config/index.ts";
import { DEFAULT_PI_SWE_CONFIG } from "../extensions/pi-swe/src/config/index.ts";
import { evaluateSwePolicy } from "../extensions/pi-swe/src/domain/policy.ts";
import { createSweState, recordChangedPath, recordInspectedPath, recordVerification, setActivePlan } from "../extensions/pi-swe/src/domain/state.ts";
import { createVerificationEvidence } from "../extensions/pi-swe/src/domain/evidence.ts";

function config(overrides: Partial<EffectivePiSweConfig> = {}): EffectivePiSweConfig {
  return {
    ...DEFAULT_PI_SWE_CONFIG,
    ...overrides,
    stages: { ...DEFAULT_PI_SWE_CONFIG.stages, ...(overrides.stages ?? {}) },
    surgicalChange: { ...DEFAULT_PI_SWE_CONFIG.surgicalChange, ...(overrides.surgicalChange ?? {}) },
  };
}

test("pi-swe policy warns about missing plan before code changes", () => {
  const result = evaluateSwePolicy({ state: createSweState(), facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }] });

  assert.equal(result.allowed, true);
  assert.equal(result.warnings.find((warning) => warning.code === "missing_plan")?.severity, "advisory");
});

test("pi-swe policy can disable missing-plan check", () => {
  const result = evaluateSwePolicy({
    config: config({ stages: { plan: { enabled: false } } }),
    state: createSweState(),
    facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }],
  });

  assert.equal(result.warnings.some((warning) => warning.code === "missing_plan"), false);
});

test("pi-swe policy warns before editing an existing file that was not inspected", () => {
  const state = setActivePlan(createSweState(), { source: "todo", marker: "todo-1" });

  const result = evaluateSwePolicy({ state, facts: [{ kind: "code_change", toolName: "edit", path: "./src/../src/a.ts", writeMode: "existing" }] });

  assert.deepEqual(result.warnings.map((warning) => warning.code), ["missing_inspection"]);
  assert.match(result.warnings[0].message, /src\/a\.ts/);
});

test("pi-swe policy accepts inspected existing files and new writes", () => {
  const inspected = recordInspectedPath(setActivePlan(createSweState(), { source: "todo", marker: "todo-1" }), "src/a.ts");

  assert.deepEqual(evaluateSwePolicy({ state: inspected, facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }] }).warnings, []);
  assert.deepEqual(evaluateSwePolicy({ state: setActivePlan(createSweState(), { source: "todo", marker: "todo-1" }), facts: [{ kind: "code_change", toolName: "write", path: "src/new.ts", writeMode: "new" }] }).warnings, []);
});

test("pi-swe policy can disable missing-inspection check", () => {
  const result = evaluateSwePolicy({
    config: config({ stages: { read: { enabled: false } } }),
    state: setActivePlan(createSweState(), { source: "todo", marker: "todo-1" }),
    facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }],
  });

  assert.deepEqual(result.warnings, []);
});

test("pi-swe policy warns when normalized changed paths exceed surgical maxFiles", () => {
  let state = createSweState({ activePlan: { source: "todo", marker: "todo-1" } });
  state = recordChangedPath(state, "./src/a.ts");
  state = recordChangedPath(state, "src/b.ts");

  const result = evaluateSwePolicy({ config: config({ surgicalChange: { maxFiles: 1 } }), state });

  assert.equal(result.warnings[0].code, "scope_too_broad");
  assert.match(result.warnings[0].message, /src\/a\.ts, src\/b\.ts/);
});

test("pi-swe policy can disable scope check", () => {
  let state = createSweState();
  state = recordChangedPath(state, "src/a.ts");
  state = recordChangedPath(state, "src/b.ts");

  const result = evaluateSwePolicy({ config: config({ stages: { scope: { enabled: false } }, surgicalChange: { maxFiles: 1 } }), state });

  assert.deepEqual(result.warnings, []);
});

test("pi-swe policy warns before finalization or todo completion without verification", () => {
  assert.equal(evaluateSwePolicy({ state: { ...createSweState(), activeStage: "finalize" } }).warnings[0].code, "missing_verification");
  assert.equal(evaluateSwePolicy({ state: createSweState(), facts: [{ kind: "todo_completion_attempt", toolName: "todo", todoId: "todo-1" }] }).warnings[0].code, "missing_verification");
});

test("pi-swe policy can disable verification check and accepts verification evidence", () => {
  const finalizing = { ...createSweState(), activeStage: "finalize" as const };
  const verified = recordVerification(finalizing, createVerificationEvidence({ kind: "command", command: "npm test", exitCode: 0, scope: "broad" }));

  assert.deepEqual(evaluateSwePolicy({ config: config({ stages: { verification: { enabled: false } } }), state: finalizing }).warnings, []);
  assert.deepEqual(evaluateSwePolicy({ state: verified }).warnings, []);
});

test("pi-swe policy defaults never block and global off disables checks", () => {
  const result = evaluateSwePolicy({ state: createSweState(), facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }] });
  const off = evaluateSwePolicy({ config: config({ enabled: false, mode: "off" }), state: createSweState(), facts: [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }] });

  assert.equal(result.allowed, true);
  assert.ok(result.warnings.every((warning) => warning.severity === "advisory"));
  assert.deepEqual(off.warnings, []);
});
