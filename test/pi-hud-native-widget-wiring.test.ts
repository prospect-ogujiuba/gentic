import assert from "node:assert/strict";
import { test } from "node:test";

import { state } from "../extensions/pi-hud/src/app/state.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import type { GitSnapshotState } from "../extensions/pi-hud/types.ts";

const theme = { fg: (_color: unknown, text: string) => text };

class QuietSnapshots {
  generation = 0;
  cwd?: string;

  reset(cwd: string): void { this.generation += 1; this.cwd = cwd; }
  dispose(): void { this.generation += 1; this.cwd = undefined; }
  requestRefresh(): Promise<GitSnapshotState> { return Promise.resolve({ status: "unavailable", generation: this.generation }); }
  currentGeneration(): number { return this.generation; }
  isCurrent(generation: number, cwd: string): boolean { return generation === this.generation && cwd === this.cwd; }
}

test("runtime wires native model, bounded context adapter, and activity into a timer-free widget", () => {
  const snapshots = new QuietSnapshots();
  const runtime = new HudRuntimeOwner(snapshots);
  let widgetFactory: Function | undefined;
  let intervalStarts = 0;
  const originalSetInterval = globalThis.setInterval;
  (globalThis as any).setInterval = () => { intervalStarts += 1; return 1; };
  const ctx = {
    cwd: "/repo",
    mode: "tui" as const,
    model: { provider: "anthropic", id: "claude-sonnet" },
    getContextUsage: () => ({ tokens: 80, contextWindow: 100, percent: 80 }),
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter() {},
      setWidget(_id: string, value: unknown) { if (typeof value === "function") widgetFactory = value; },
      setStatus() {},
    },
  };

  try {
    runtime.start(ctx);
    state.agent = "thinking";
    runtime.apply(ctx);
    assert.ok(widgetFactory);
    const component = widgetFactory!({ requestRender() {} }, theme);
    const line = component.render(160).join("\n");

    assert.match(line, /model claude-sonnet/);
    assert.match(line, /context warning █{13}░{3} 80\/100 20% left/);
    assert.match(line, /git unavailable/);
    assert.match(line, /activity thinking/);
    assert.equal(intervalStarts, 0, "the widget must not create a polling timer");
    component.dispose?.();
  } finally {
    runtime.shutdown(ctx);
    globalThis.setInterval = originalSetInterval;
  }
});
