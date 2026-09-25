import assert from "node:assert/strict";
import { test } from "node:test";

import piHud from "../extensions/pi-hud/index.ts";
import { state } from "../extensions/pi-hud/src/app/state.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import type { GitSnapshotState } from "../extensions/pi-hud/types.ts";

class FakeSnapshots {
  generation = 0;
  active = false;
  cwd?: string;
  resetCalls = 0;
  disposeCalls = 0;
  pending: Array<{ generation: number; resolve(state: GitSnapshotState): void }> = [];

  reset(cwd: string): void { this.generation += 1; this.active = true; this.cwd = cwd; this.resetCalls += 1; }
  dispose(): void { this.generation += 1; this.active = false; this.cwd = undefined; this.disposeCalls += 1; }
  requestRefresh(): Promise<GitSnapshotState> {
    const generation = this.generation;
    return new Promise((resolve) => this.pending.push({ generation, resolve }));
  }
  currentGeneration(): number { return this.generation; }
  isCurrent(generation: number, cwd: string): boolean { return this.active && generation === this.generation && cwd === this.cwd; }
  complete(index: number): void {
    const pending = this.pending[index];
    pending.resolve({ status: "unavailable", generation: pending.generation });
  }
}

function lifecycleContext() {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const ctx = {
    cwd: process.cwd(),
    mode: "tui" as const,
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget(_id: string, value: unknown) { calls.push({ method: "setWidget", value }); },
      notify() {},
    },
  };
  return { ctx, calls };
}

test("widget runtime cleanup is idempotent and rejects late refresh generations", async () => {
  const snapshots = new FakeSnapshots();
  const runtime = new HudRuntimeOwner(snapshots);
  const oldHarness = lifecycleContext();
  const newHarness = lifecycleContext();

  assert.doesNotThrow(() => runtime.shutdown(oldHarness.ctx));
  runtime.start(oldHarness.ctx);
  state.agent = "testing";
  state.activeTools = [{ id: "old", toolName: "bash" }];
  runtime.update(oldHarness.ctx, true);
  assert.equal(snapshots.pending.length, 1);

  runtime.shutdown(oldHarness.ctx);
  const oldCalls = oldHarness.calls.length;
  runtime.shutdown(oldHarness.ctx);
  assert.equal(oldHarness.calls.length, oldCalls);

  runtime.start(newHarness.ctx);
  const newCalls = newHarness.calls.length;
  snapshots.complete(0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(newHarness.calls.length, newCalls);
  assert.equal(state.agent, "idle");
  assert.deepEqual(state.activeTools, []);
  runtime.shutdown(newHarness.ctx);
  assert.equal(snapshots.resetCalls, 2);
  assert.equal(snapshots.disposeCalls, 2);
});

test("refresh provider failures stay contained within the HUD lifecycle", async () => {
  const snapshots = new FakeSnapshots();
  snapshots.requestRefresh = () => Promise.reject(new Error("provider unavailable"));
  const runtime = new HudRuntimeOwner(snapshots);
  const harness = lifecycleContext();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    runtime.start(harness.ctx);
    runtime.update(harness.ctx, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(runtime.isActive(), true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    runtime.shutdown(harness.ctx);
  }
});

test("registered lifecycle remains singular and excludes retired history events", () => {
  const handlers = new Map<string, unknown[]>();
  piHud({
    on(event: string, handler: unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand() {},
  } as never);

  for (const event of ["session_start", "session_shutdown", "agent_settled", "tool_execution_start", "tool_execution_end"]) {
    assert.equal(handlers.get(event)?.length, 1);
  }
  for (const retired of ["session_info_changed", "thinking_level_select", "tool_result", "message_end"]) {
    assert.equal(handlers.has(retired), false);
  }
});
