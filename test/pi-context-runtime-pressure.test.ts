import assert from "node:assert/strict";
import test from "node:test";

import { getSessionState, resetSessionState } from "../extensions/pi-context/src/app/index.ts";
import { DEFAULT_PI_CONTEXT_CONFIG } from "../extensions/pi-context/src/config/index.ts";
import { registerPiContext } from "../extensions/pi-context/src/pi/index.ts";

test("runtime pressure notifications are transition-only, typed, private, and lifecycle-safe", () => {
  resetSessionState("test", "2026-05-13T01:00:00.000Z");
  const handlers = new Map<string, Function>();
  const notifications: Array<{ text: string; type: string }> = [];
  let configLoads = 0;
  let nowMs = 1_000;
  let usage: { tokens?: number; contextWindow?: number; percent?: number } = measured(40);

  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as never, {
    now: () => nowMs++,
    loadConfig: () => {
      configLoads += 1;
      return {
        config: DEFAULT_PI_CONTEXT_CONFIG,
        diagnostics: [],
        paths: { global: "/private/global.json", project: "/repo/.pi/pi-context.json" },
      };
    },
  });

  const ctx = {
    cwd: "/repo/private-project",
    model: { id: "m", provider: "mock", contextWindow: 100 },
    sessionManager: {
      getSessionId: () => "private-session-id",
      getSessionFile: () => "/private/session.jsonl",
      getSessionDir: () => "/private",
      getCwd: () => "/repo/private-project",
    },
    getContextUsage: () => usage,
    ui: { notify: (text: string, type: string) => notifications.push({ text, type }) },
  };

  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  assert.equal(configLoads, 1);

  usage = measured(25);
  handlers.get("turn_start")?.({ turnIndex: 1 }, ctx);
  usage = measured(24);
  handlers.get("turn_end")?.({}, ctx);
  usage = measured(10);
  handlers.get("context")?.({}, ctx);
  handlers.get("context")?.({}, ctx);

  handlers.get("session_before_compact")?.({}, ctx);
  usage = measured(50);
  handlers.get("session_compact")?.({}, ctx);
  usage = { percent: 95 };
  handlers.get("context")?.({}, ctx);
  usage = measured(25);
  handlers.get("context")?.({}, ctx);

  assert.deepEqual(notifications.map(({ type }) => type), ["warning", "error", "warning"]);
  assert.match(notifications[0]?.text ?? "", /warning: 25% remaining/i);
  assert.match(notifications[1]?.text ?? "", /critical: 10% remaining/i);
  assert.equal(notifications.some(({ text }) => /private|session\.jsonl|repo/i.test(text)), false);
  assert.equal(configLoads, 1, "configuration is not reloaded by usage-bearing hooks");

  handlers.get("session_shutdown")?.({ reason: "shutdown" });
  assert.equal(getSessionState()?.active, false);
  usage = measured(10);
  handlers.get("session_start")?.({ reason: "resume" }, ctx);

  assert.equal(configLoads, 2, "a new session receives one fresh normalized configuration");
  assert.deepEqual(notifications.map(({ type }) => type), ["warning", "error", "warning", "error"]);
});

function measured(remainingPercent: number): { tokens: number; contextWindow: number; percent: number } {
  return {
    tokens: 100 - remainingPercent,
    contextWindow: 100,
    percent: 100 - remainingPercent,
  };
}
