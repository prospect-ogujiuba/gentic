import assert from "node:assert/strict";
import { test } from "node:test";

import { applyHud } from "../extensions/pi-hud/src/pi/adapter.ts";
import { DEFAULT_DISPLAY_MODE, resetConfig, resolveDisplayModeConfig, setDisplayMode, state } from "../extensions/pi-hud/src/app/state.ts";
import { hudRuntime } from "../extensions/pi-hud/src/pi/runtime.ts";
import type { DisplayMode } from "../extensions/pi-hud/types.ts";

type RuntimeMode = "tui" | "rpc" | "json" | "print";
type UiCall = { method: string; value?: unknown };

function contextFor(mode: RuntimeMode): { ctx: any; calls: UiCall[] } {
  const calls: UiCall[] = [];
  return {
    calls,
    ctx: {
      cwd: process.cwd(),
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      model: undefined,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "",
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter(value: unknown) { calls.push({ method: "setFooter", value }); },
        setWidget(_id: string, value: unknown) { calls.push({ method: "setWidget", value }); },
        setStatus(_id: string, value: unknown) { calls.push({ method: "setStatus", value }); },
        custom() { calls.push({ method: "custom" }); },
        notify() {},
      },
    },
  };
}

test("pi-hud configuration supports one widget and migrates retired surfaces", () => {
  assert.equal(resolveDisplayModeConfig(undefined), "widget-first");
  assert.equal(resolveDisplayModeConfig({}), "widget-first");
  assert.equal(resolveDisplayModeConfig({ displayMode: "off" }), "off");
  assert.equal(resolveDisplayModeConfig({ displayMode: "widget-first" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ displayMode: "footer" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ enabled: false, placement: "footer" }), "off");
  assert.equal(resolveDisplayModeConfig({ placement: "widget" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ placement: "both" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ placement: "footer" }), "widget-first");
  for (const invalid of ["both-ish", 1, [], { displayMode: "modal" }, { enabled: "yes" }, { placement: 2 }]) {
    assert.throws(() => resolveDisplayModeConfig(invalid), /Invalid pi-hud/);
  }
  resetConfig();
  assert.equal(DEFAULT_DISPLAY_MODE, "widget-first");
  assert.equal(state.displayMode, "widget-first");
});

for (const runtime of ["tui", "rpc", "json", "print"] as const) {
  for (const displayMode of ["off", "widget-first"] as const satisfies readonly DisplayMode[]) {
    test(`pi-hud routes ${displayMode} in ${runtime} without retired UI`, () => {
      const { ctx, calls } = contextFor(runtime);
      hudRuntime.start(ctx);
      setDisplayMode(displayMode);
      try {
        applyHud(ctx);
        assert.equal(calls.some((call) => call.method === "setFooter" || call.method === "custom" || call.method === "setStatus"), false);
        if (runtime === "json" || runtime === "print") assert.deepEqual(calls, []);
        else {
          assert.equal(calls.every((call) => call.method === "setWidget"), true);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].value === undefined, displayMode === "off");
        }
      } finally {
        hudRuntime.shutdown(ctx);
      }
    });
  }
}
