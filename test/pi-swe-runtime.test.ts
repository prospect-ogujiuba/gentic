import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_PI_SWE_CONFIG } from "../extensions/pi-swe/src/config.ts";
import { emitWarnings, formatAdvisoryChips, resetTurnRuntime, SWE_ADVISORY_WIDGET_KEY, type PiSweRuntime } from "../extensions/pi-swe/src/runtime.ts";
import { createSweState } from "../extensions/pi-swe/src/state.ts";

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
    todoEvidence: [],
    warnings: [],
  };
}

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
