import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createSnapshot } from "../extensions/pi-hud/src/app/snapshot.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import type { GitSnapshotState } from "../extensions/pi-hud/types.ts";

class LifecycleSnapshots {
  generation = 0;
  cwd?: string;
  resets = 0;
  disposals = 0;
  reset(cwd: string): void { this.generation += 1; this.cwd = cwd; this.resets += 1; }
  dispose(): void { this.generation += 1; this.cwd = undefined; this.disposals += 1; }
  requestRefresh(): Promise<GitSnapshotState> { return Promise.resolve({ status: "unavailable", generation: this.generation }); }
  currentGeneration(): number { return this.generation; }
  isCurrent(generation: number, cwd: string): boolean { return generation === this.generation && cwd === this.cwd; }
}

test("representative HUD snapshot and lifecycle hot paths stay within stable budgets", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-hud-performance-"));
  try {
    let usageReads = 0;
    let branchReads = 0;
    let widgetWrites = 0;
    const ctx = {
      cwd,
      mode: "rpc",
      model: { provider: "provider", id: "model" },
      getContextUsage: () => { usageReads += 1; return { tokens: 50, contextWindow: 100, percent: 50 }; },
      getSystemPrompt: () => "not read on the pressure-only path",
      sessionManager: { getBranch: () => { branchReads += 1; return []; } },
      ui: { setWidget: () => { widgetWrites += 1; } },
    };

    const snapshotStarted = performance.now();
    for (let index = 0; index < 2_000; index += 1) createSnapshot(ctx as never);
    const snapshotMs = performance.now() - snapshotStarted;
    assert.ok(snapshotMs < 1_000, `HUD snapshot hot path took ${snapshotMs.toFixed(1)}ms`);
    assert.equal(usageReads, 2_000);
    assert.equal(branchReads, 0);

    const snapshots = new LifecycleSnapshots();
    const runtime = new HudRuntimeOwner(snapshots);
    const lifecycleStarted = performance.now();
    for (let index = 0; index < 100; index += 1) {
      runtime.start(ctx as never);
      runtime.update(ctx as never);
      runtime.shutdown(ctx as never);
    }
    const lifecycleMs = performance.now() - lifecycleStarted;
    assert.ok(lifecycleMs < 1_000, `HUD lifecycle hot path took ${lifecycleMs.toFixed(1)}ms`);
    assert.equal(snapshots.resets, 100);
    assert.equal(snapshots.disposals, 100);
    assert.equal(widgetWrites, 200);
    assert.equal(branchReads, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
