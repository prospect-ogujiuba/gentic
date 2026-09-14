import assert from "node:assert/strict";
import { test } from "node:test";

import { registerHudCommand, registerHudEventHandlers } from "../extensions/pi-hud/src/pi/adapter.ts";
import { resolveDisplayModeConfig, state } from "../extensions/pi-hud/src/app/state.ts";
import { hudRuntime } from "../extensions/pi-hud/src/pi/runtime.ts";

test("legacy footer configuration migrates to the widget without replacing Pi's footer", async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  const calls: string[] = [];
  registerHudCommand({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never);
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter() { calls.push("setFooter"); },
      setWidget() { calls.push("setWidget"); },
      setStatus() { calls.push("setStatus"); },
      custom() { calls.push("custom"); },
      notify() { calls.push("notify"); },
    },
  };

  assert.equal(resolveDisplayModeConfig({ displayMode: "footer" }), "widget-first");
  hudRuntime.start(ctx);
  try {
    await handler("mode footer", ctx);
    await handler("", ctx);
    assert.equal(calls.includes("setFooter"), false);
    assert.equal(calls.includes("custom"), false);
    assert.equal(calls.includes("setWidget"), true);
  } finally {
    hudRuntime.shutdown(ctx);
  }
});

test("registration and state retain no modal, timer, or event-history service", () => {
  const events: string[] = [];
  registerHudEventHandlers({ on(name: string) { events.push(name); } } as never);

  assert.equal("recentEvents" in state, false);
  assert.equal("workTimer" in state, false);
  assert.equal(events.includes("message_end"), false);
  assert.equal(events.includes("tool_result"), false);
  assert.equal(events.includes("thinking_level_select"), false);
});
