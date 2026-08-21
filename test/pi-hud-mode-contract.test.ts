import assert from "node:assert/strict";
import { test } from "node:test";

import { applyHud } from "../extensions/pi-hud/src/pi/adapter.ts";
import { DEFAULT_DISPLAY_MODE, resetConfig, resolveDisplayModeConfig, setDisplayMode, state } from "../extensions/pi-hud/src/app/state.ts";
import { openModal } from "../extensions/pi-hud/src/ui/surfaces/modal.ts";
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
      ui: {
        setFooter(value: unknown) { calls.push({ method: "setFooter", value }); },
        setWidget(_id: string, value: unknown) { calls.push({ method: "setWidget", value }); },
        setStatus(_id: string, value: unknown) { calls.push({ method: "setStatus", value }); },
        setWorkingIndicator(value: unknown) { calls.push({ method: "setWorkingIndicator", value }); },
        custom() { calls.push({ method: "custom" }); },
        notify() {},
      },
    },
  };
}

test("pi-hud display configuration validates current, absent, and legacy fixtures", () => {
  assert.equal(resolveDisplayModeConfig(undefined), "widget-first");
  assert.equal(resolveDisplayModeConfig({}), "widget-first");
  assert.equal(resolveDisplayModeConfig({ displayMode: "off" }), "off");
  assert.equal(resolveDisplayModeConfig({ displayMode: "widget-first" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ displayMode: "footer" }), "footer");
  assert.equal(resolveDisplayModeConfig({ enabled: false, placement: "footer" }), "off");
  assert.equal(resolveDisplayModeConfig({ enabled: true, placement: "widget" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ placement: "both" }), "widget-first");
  assert.equal(resolveDisplayModeConfig({ placement: "footer" }), "footer");

  for (const invalid of ["both-ish", 1, [], { displayMode: "modal" }, { enabled: "yes" }, { placement: 2 }]) {
    assert.throws(() => resolveDisplayModeConfig(invalid), /Invalid pi-hud/);
  }
});

test("pi-hud reset keeps footer replacement opt-in", () => {
  setDisplayMode("footer");
  resetConfig();
  assert.equal(DEFAULT_DISPLAY_MODE, "widget-first");
  assert.equal(state.displayMode, "widget-first");
});

for (const runtime of ["tui", "rpc", "json", "print"] as const) {
  for (const displayMode of ["off", "widget-first", "footer"] as const satisfies readonly DisplayMode[]) {
    test(`pi-hud routes ${displayMode} in ${runtime}`, () => {
      setDisplayMode(displayMode);
      const { ctx, calls } = contextFor(runtime);
      applyHud(ctx);

      const footerValues = calls.filter((call) => call.method === "setFooter").map((call) => call.value);
      const widgetValues = calls.filter((call) => call.method === "setWidget").map((call) => call.value);
      assert.equal(calls.some((call) => call.method === "custom" || call.method === "setWorkingIndicator" || call.method === "setStatus"), false);

      if (runtime === "json" || runtime === "print") {
        assert.deepEqual(calls, []);
      } else if (runtime === "rpc") {
        assert.deepEqual(footerValues, []);
        assert.equal(widgetValues[0], undefined);
        assert.equal(widgetValues.length, displayMode === "off" ? 1 : 2);
        if (displayMode !== "off") assert.equal(Array.isArray(widgetValues[1]), true);
      } else {
        assert.equal(footerValues[0], undefined);
        assert.equal(widgetValues[0], undefined);
        assert.equal(footerValues.filter((value) => value !== undefined).length, displayMode === "footer" ? 1 : 0);
        assert.equal(widgetValues.filter((value) => value !== undefined).length, displayMode === "widget-first" ? 1 : 0);
      }
    });
  }
}

test("pi-hud modal never invokes custom UI outside TUI mode", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    let customCalls = 0;
    await openModal({ mode, ui: { custom() { customCalls += 1; } } } as never);
    assert.equal(customCalls, 0);
  }
});
