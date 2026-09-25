import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { registerHudCommand } from "../extensions/pi-hud/src/pi/adapter.ts";
import type { HudContextProvider } from "../extensions/pi-hud/src/app/context-provider.ts";
import { GitSnapshotService } from "../extensions/pi-hud/src/app/git-snapshot-service.ts";
import { createSnapshot, withLiveUsage } from "../extensions/pi-hud/src/app/snapshot.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import { renderHudWidgetLines } from "../extensions/pi-hud/src/ui/surfaces/widget.ts";
import type { GitSnapshotState, HudSnapshot, Theme } from "../extensions/pi-hud/types.ts";

const ansiTheme: Theme = { fg: (_color: unknown, text: string) => `\x1b[36m${text}\x1b[0m` };

class QualificationSnapshots {
  generation = 0;
  cwd?: string;
  disposeCalls = 0;
  reset(cwd: string): void { this.generation += 1; this.cwd = cwd; }
  dispose(): void { this.generation += 1; this.cwd = undefined; this.disposeCalls += 1; }
  requestRefresh(): Promise<GitSnapshotState> { return Promise.resolve({ status: "unavailable", generation: this.generation }); }
  currentGeneration(): number { return this.generation; }
  isCurrent(generation: number, cwd: string): boolean { return generation === this.generation && cwd === this.cwd; }
}

function hostileSnapshot(): HudSnapshot {
  return {
    modelId: `provider/${"模型🚀".repeat(80)}`,
    worktreeId: "/repo",
    piContext: {
      schemaVersion: 1,
      available: true,
      capturedAt: "2026-09-14T00:00:00.000Z",
      totalTokens: 95_000,
      totalBytes: 100,
      contextWindowTokens: 100_000,
      remainingTokens: 5_000,
      pressure: { available: true, level: "critical", remainingPercent: 5 },
      tokenConfidence: "estimated",
      contributors: [],
      warnings: [],
      truncatedWarnings: 0,
    },
    git: {
      branch: `修复/${"分支".repeat(80)}`,
      dirty: true,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
      aheadCount: 99,
      behindCount: 99,
    },
    gitState: { status: "stale", generation: 1 },
    activeTools: [{ id: "1", toolName: "testing" }],
    activity: "testing",
  };
}

test("all terminal widths remain ANSI-aware and bounded under hostile labels", () => {
  const snapshot = hostileSnapshot();
  for (let width = -2; width <= 200; width += 1) {
    const lines = renderHudWidgetLines(snapshot, ansiTheme, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= Math.max(0, width)), `width ${width}`);
  }
});

test("HUD reads native usage once, fails closed on thrown accessors, and projects live pressure", () => {
  let used = 20;
  let usageCalls = 0;
  let branchCalls = 0;
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    getContextUsage: () => {
      usageCalls += 1;
      return { tokens: used, contextWindow: 100, percent: used };
    },
    getSystemPrompt: () => "must not be measured",
    sessionManager: { getBranch: () => { branchCalls += 1; throw new Error("PRIVATE_BRANCH_MARKER"); } },
  };

  const initial = createSnapshot(ctx);
  assert.equal(usageCalls, 1);
  assert.equal(branchCalls, 0, "pressure-only HUD snapshots must not scan branch contributors");
  used = 95;
  const live = withLiveUsage(initial, ctx);
  assert.equal(usageCalls, 2);
  assert.deepEqual(live.piContext?.pressure, { available: true, level: "critical", remainingPercent: 5 });
  assert.equal(live.piContext?.totalTokens, 95);
  const liveLine = renderHudWidgetLines(live, { fg: (_color: unknown, text: string) => text }, 120).join("\n");
  assert.match(liveLine, /context critical.*95\/100 5% left/);

  const hostile = {
    ...ctx,
    getContextUsage: () => { throw new Error("PRIVATE_USAGE_MARKER"); },
    getSystemPrompt: () => { throw new Error("PRIVATE_PROMPT_MARKER"); },
  };
  const failed = createSnapshot(hostile);
  assert.equal(failed.usage, undefined);
  assert.deepEqual(failed.piContext?.pressure, { available: false, level: "unavailable" });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_/);
  assert.doesNotThrow(() => withLiveUsage(initial, hostile));
});

test("runtime consumes an injected stable context provider", () => {
  const snapshots = new QualificationSnapshots();
  const loaded: string[] = [];
  const observedUsage: Array<number | null | undefined> = [];
  const provider: HudContextProvider = {
    defaultPressurePolicy: { warningPercent: 25, criticalPercent: 10, hysteresisPercent: 5 },
    loadPressurePolicy(cwd) {
      loaded.push(cwd);
      return { warningPercent: 30, criticalPercent: 12, hysteresisPercent: 3 };
    },
    createHudSnapshot(usage, pressurePolicy, capturedAt) {
      observedUsage.push(usage?.tokens);
      assert.equal(pressurePolicy.warningPercent, 30);
      return {
        schemaVersion: 1,
        available: true,
        capturedAt: capturedAt ?? "2026-09-25T00:00:00.000Z",
        totalTokens: usage?.tokens ?? undefined,
        totalBytes: 0,
        contextWindowTokens: usage?.contextWindow ?? undefined,
        remainingTokens: 30,
        pressure: { available: true, level: "warning", remainingPercent: 30 },
        tokenConfidence: "estimated",
        contributors: [],
        warnings: [],
        truncatedWarnings: 0,
      };
    },
  };
  const rendered: string[][] = [];
  const ctx = {
    cwd: "/provider-repo",
    mode: "rpc" as const,
    model: undefined,
    getContextUsage: () => ({ tokens: 70, contextWindow: 100, percent: 70 }),
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] },
    ui: { setWidget(_id: string, value: string[] | undefined) { if (value) rendered.push(value); } },
  };
  const runtime = new HudRuntimeOwner(snapshots, provider);

  runtime.start(ctx as never);
  runtime.apply(ctx as never);
  runtime.shutdown(ctx as never);

  assert.deepEqual(loaded, ["/provider-repo"]);
  assert.deepEqual(observedUsage, [70, 70]);
  assert.match(rendered.at(-1)?.join("\n") ?? "", /context warning.*70\/100 30% left/);
});

test("JSON and print commands perform no UI calls", async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  registerHudCommand({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never);

  for (const mode of ["json", "print"] as const) {
    const calls: string[] = [];
    const snapshots = new QualificationSnapshots();
    const runtime = new HudRuntimeOwner(snapshots);
    const ctx = {
      cwd: "/repo",
      mode,
      model: undefined,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "",
      sessionManager: { getBranch: () => [] },
      ui: new Proxy({}, { get: (_target, key) => () => calls.push(String(key)) }),
    };
    runtime.start(ctx as never);
    try {
      for (const command of ["show", "hide", "reset", "mode widget-first", "mode invalid", "open"]) await handler(command, ctx);
      assert.deepEqual(calls, [], mode);
    } finally {
      runtime.shutdown(ctx as never);
    }
  }
});

test("refresh stays single-flight and responsive while shutdown cleanup is idempotent", async () => {
  let collections = 0;
  const service = new GitSnapshotService({
    debounceMs: 0,
    collector: async () => {
      collections += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return undefined;
    },
  });
  service.reset("/repo");
  const first = service.requestRefresh("/repo");
  for (let index = 0; index < 100; index += 1) assert.strictEqual(service.requestRefresh("/repo"), first);
  let ticked = false;
  await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 0));
  assert.equal(ticked, true);
  await first;
  assert.equal(collections, 1);
  service.dispose();

  const snapshots = new QualificationSnapshots();
  const runtime = new HudRuntimeOwner(snapshots);
  let widgetClears = 0;
  const ctx = {
    cwd: "/repo",
    mode: "tui" as const,
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] },
    ui: { setWidget(_id: string, value: unknown) { if (value === undefined) widgetClears += 1; } },
  };
  runtime.start(ctx as never);
  runtime.shutdown(ctx as never);
  runtime.shutdown(ctx as never);
  assert.equal(widgetClears, 1);
  assert.equal(snapshots.disposeCalls, 1);
});
