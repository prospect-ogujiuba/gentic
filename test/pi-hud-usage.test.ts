import assert from "node:assert/strict";
import { test } from "node:test";
import piHud from "../extensions/pi-hud/index.ts";
import { renderUsageSummary } from "../extensions/pi-hud/src/ui/components/context.ts";
import { renderFooterLines } from "../extensions/pi-hud/src/ui/surfaces/footer.ts";
import { recordMessageUsage, resetConfig, resetSessionUsage, resetWorkTimer, state } from "../extensions/pi-hud/src/app/state.ts";
import type { Theme } from "../extensions/pi-hud/types.ts";

const plainTheme: Theme = {
  fg(_color: unknown, text: string) {
    return text;
  },
};

test("pi-hud footer renders representative layered HUD output", () => {
  resetConfig();
  resetSessionUsage();
  resetWorkTimer();
  state.recentEvents = ["tool_execution_started", "message_created"];
  state.activeTools = [{ id: "tool-1", toolName: "bash" }];
  state.toolCounts = { bash: 2, read: 1 };
  state.successCalls = 3;
  state.errorCalls = 0;
  state.warningCalls = 1;
  state.thinkingLevel = "medium";

  try {
    const lines = renderFooterLines({
      modelId: "anthropic/claude-sonnet",
      thinkingLevel: state.thinkingLevel,
      worktreeId: "/repo/gentic",
      usage: { input: 1234, output: 56, cost: 0.0123, totalTokens: 1290, contextTokens: 250, contextWindow: 1000, contextPct: 25 },
      piContext: {
        available: true,
        totalTokens: 120,
        remainingTokens: 880,
        contextWindowTokens: 1000,
        contributors: [{ label: "Tools", tokenCount: 80 }],
        warnings: [],
        truncatedWarnings: 0,
        largestGroup: { label: "Tools", tokenCount: 80 },
      },
      git: { branch: "main", dirty: true, stagedCount: 1, unstagedCount: 2, untrackedCount: 1, upstream: "origin/main", remoteName: "origin", aheadCount: 1, behindCount: 0 },
      activeTools: state.activeTools,
      toolCounts: state.toolCounts,
      recentEvents: state.recentEvents,
    }, plainTheme, 120);

    assert.equal(lines.length, 4);
    assert.match(lines[0], /claude-sonnet \(medium\).*250\/1\.0k 25%.*ledger 120 left 880 hot Tools.*IN 1\.2k\s+OUT 56\s+\$0\.0123/);
    assert.match(lines[1], /gentic · main\(\*\) · origin · ↓\(0\)\|↑\(1\) · unstaged \(2\) · untracked \(1\) · staged \(1\).*work: 0:00/);
    assert.match(lines[2], /\[bash 2\] \[read 1\].*err 0 · warn 1 · ok\/fail 3:0 · pending 1/);
    assert.match(lines[3], /Events \| ◆ tool_started ◇ msg_created/);
  } finally {
    state.successCalls = 0;
    state.errorCalls = 0;
    state.warningCalls = 0;
    state.activeTools = [];
    state.toolCounts = {};
    state.recentEvents = [];
    state.thinkingLevel = undefined;
  }
});

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

test("pi-hud footer includes nonzero startup prompt usage before provider usage arrives", async () => {
  resetConfig();
  resetSessionUsage();
  state.recentEvents = ["loaded"];
  state.activeTools = [];
  state.toolCounts = {};

  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: any) => unknown>>();
  let footerFactory: any;
  let usage = { tokens: 0, contextWindow: 1000, percent: 0 };
  const systemPrompt = "s".repeat(80);
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    model: { provider: "mock", id: "m", contextWindow: 1000 },
    getContextUsage: () => usage,
    getSystemPrompt: () => systemPrompt,
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
  try {
    assert.match(footer.render(120).join("\n"), /20\/1\.0k\s+2%/);

    usage = { tokens: 250, contextWindow: 1000, percent: 25 };
    assert.match(footer.render(120).join("\n"), /250\/1\.0k\s+25%/);
  } finally {
    footer.dispose?.();
  }
});
