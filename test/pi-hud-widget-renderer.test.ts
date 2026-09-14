import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderHudWidgetLines } from "../extensions/pi-hud/src/ui/surfaces/widget.ts";
import type { HudSnapshot, Theme } from "../extensions/pi-hud/types.ts";

const plainTheme: Theme = { fg: (_color: unknown, text: string) => text };
const ansiTheme: Theme = { fg: (_color: unknown, text: string) => `\x1b[35m${text}\x1b[0m` };

function snapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    modelId: "anthropic/claude-sonnet",
    worktreeId: "/repo/gentic",
    piContext: {
      schemaVersion: 1,
      available: true,
      capturedAt: "2026-09-14T00:00:00.000Z",
      totalTokens: 76_000,
      totalBytes: 1_000,
      contextWindowTokens: 100_000,
      remainingTokens: 24_000,
      pressure: { available: true, level: "warning", remainingPercent: 24 },
      tokenConfidence: "estimated",
      contributors: [],
      warnings: [],
      truncatedWarnings: 0,
    },
    git: {
      branch: "feature/轻量-hud",
      dirty: true,
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 0,
      upstream: "origin/main",
      remoteName: "origin",
      aheadCount: 2,
      behindCount: 1,
    },
    gitState: { status: "stale", generation: 1 },
    activeTools: [{ id: "tool-1", toolName: "testing" }],
    ...overrides,
  };
}

test("minimum HUD widget renders its four textual groups in priority order", () => {
  const line = renderHudWidgetLines(snapshot(), plainTheme, 160).join("\n");
  const labels = ["model claude-sonnet", "context warning", "git feature/轻量-hud", "activity testing"];
  for (const label of labels) assert.match(line, new RegExp(label));
  assert.ok(labels.map((label) => line.indexOf(label)).every((offset, index, offsets) => index === 0 || offset > offsets[index - 1]));
  assert.match(line, /context warning █{12}░{4} 76\.0k\/100\.0k 24% left/);
  assert.match(line, /git feature\/轻量-hud\(\*\) · origin · ↓\(1\)\|↑\(2\) · unstaged \(2\) · staged \(1\) · stale/);
});

test("rich Git status preserves branch, sync, divergence, and working-tree detail", () => {
  const line = renderHudWidgetLines(snapshot({ git: {
    branch: "master",
    dirty: true,
    stagedCount: 0,
    unstagedCount: 23,
    untrackedCount: 3,
    upstream: "origin/master",
    remoteName: "origin",
    aheadCount: 0,
    behindCount: 0,
  }, gitState: { status: "fresh", generation: 1 } }), plainTheme, 160).join("\n");
  assert.match(line, /git master\(\*\) · origin · synced · ↓\(0\)\|↑\(0\) · unstaged \(23\) · untracked \(3\)/);
});

test("medium widths preserve the context bar in a compact two-line widget", () => {
  const lines = renderHudWidgetLines(snapshot(), plainTheme, 120);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /model claude-sonnet.*context warning █{12}░{4} 76\.0k\/100\.0k 24% left/);
  assert.match(lines[1], /git feature\/轻量-hud.*activity testing/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("narrow widths retain all four groups without dangling separators", () => {
  const lines = renderHudWidgetLines(snapshot(), plainTheme, 40);
  const text = lines.join("\n");
  assert.match(text, /m claude-sonnet/);
  assert.match(text, /ctx warning/);
  assert.match(text, /git feature\/轻量-hud/);
  assert.match(text, /act testing/);
  assert.ok(lines.every((line) => !/·\s*$/.test(line)));
});

test("minimum HUD widget is pure, deterministic, and width-safe for ANSI and Unicode", () => {
  const value = snapshot();
  const before = structuredClone(value);
  for (const theme of [plainTheme, ansiTheme]) {
    for (const width of [0, 1, 8, 16, 24, 48, 80, 160]) {
      const first = renderHudWidgetLines(value, theme, width);
      const second = renderHudWidgetLines(value, theme, width);
      assert.deepEqual(first, second, `deterministic at width ${width}`);
      assert.ok(first.every((line) => visibleWidth(line) <= Math.max(0, width)), `bounded at width ${width}`);
    }
  }
  assert.deepEqual(value, before);
});

test("minimum HUD widget labels unavailable state and idle activity without color", () => {
  const line = renderHudWidgetLines(snapshot({
    modelId: undefined,
    piContext: undefined,
    usage: undefined,
    git: undefined,
    gitState: { status: "unavailable", generation: 1 },
    activeTools: [],
  }), plainTheme, 120).join("\n");

  assert.match(line, /model unknown/);
  assert.match(line, /context unavailable/);
  assert.match(line, /git unavailable/);
  assert.match(line, /activity idle/);
});
