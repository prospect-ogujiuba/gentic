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
      tokenConfidence: "exact",
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
    toolCounts: {},
    recentEvents: [],
    ...overrides,
  };
}

test("minimum HUD widget renders its four textual groups in priority order", () => {
  const line = renderHudWidgetLines(snapshot(), plainTheme, 160).join("\n");
  const labels = ["model claude-sonnet", "context warning", "git feature/轻量-hud", "activity testing"];
  for (const label of labels) assert.match(line, new RegExp(label));
  assert.ok(labels.map((label) => line.indexOf(label)).every((offset, index, offsets) => index === 0 || offset > offsets[index - 1]));
  assert.match(line, /24% left/);
  assert.match(line, /dirty/);
  assert.match(line, /stale/);
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
