import assert from "node:assert/strict";
import { test } from "node:test";
import piHud from "../extensions/pi-hud/index.ts";
import { renderUsageSummary } from "../extensions/pi-hud/components/context.ts";
import { recordMessageUsage, resetConfig, resetSessionUsage, state } from "../extensions/pi-hud/state.ts";
import type { Theme } from "../extensions/pi-hud/types.ts";

const plainTheme: Theme = {
  fg(_color: unknown, text: string) {
    return text;
  },
};

test("pi-hud usage summary records assistant token and cost usage", () => {
  resetSessionUsage();

  recordMessageUsage({
    role: "assistant",
    provider: "anthropic",
    model: "claude",
    timestamp: 1,
    usage: {
      input: 1234,
      output: 56,
      totalTokens: 1290,
      cost: { input: 0.01, output: 0.0023, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    },
  });

  assert.equal(renderUsageSummary({ worktreeId: ".", usage: state.usage, activeTools: [], toolCounts: {}, recentEvents: [] }, plainTheme), "IN 1.2k  OUT 56  $0.0123");
});

test("pi-hud usage summary deduplicates repeated message events", () => {
  resetSessionUsage();
  const message = {
    role: "assistant",
    provider: "openai",
    model: "gpt",
    timestamp: 2,
    usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
  };

  recordMessageUsage(message);
  recordMessageUsage(message);

  assert.deepEqual(state.usage, { input: 10, output: 20, cost: 0.5, totalTokens: 30 });
});

test("pi-hud footer reads live context usage after session_start without another event", async () => {
  resetConfig();
  resetSessionUsage();
  state.recentEvents = ["loaded"];
  state.activeTools = [];
  state.toolCounts = {};

  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: any) => unknown>>();
  let footerFactory: any;
  let usage = { tokens: 0, contextWindow: 1000, percent: 0 };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    model: { provider: "mock", id: "m", contextWindow: 1000 },
    getContextUsage: () => usage,
    ui: {
      setFooter(value: unknown) { footerFactory = value; },
      setWidget() {},
      notify() {},
    },
  };

  piHud({
    on(event: string, handler: (event: Record<string, unknown>, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
  } as never);

  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "test" }, ctx);
  const footer = footerFactory({ requestRender() {} }, plainTheme);
  assert.match(footer.render(120).join("\n"), /0\/1\.0k\s+0%/);

  usage = { tokens: 250, contextWindow: 1000, percent: 25 };
  assert.match(footer.render(120).join("\n"), /250\/1\.0k\s+25%/);
  footer.dispose?.();
});
