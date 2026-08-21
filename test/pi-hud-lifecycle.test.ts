import assert from "node:assert/strict";
import { test } from "node:test";

import piHud from "../extensions/pi-hud/index.ts";
import { setDisplayMode, state } from "../extensions/pi-hud/src/app/state.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import { openModal } from "../extensions/pi-hud/src/ui/surfaces/modal.ts";
import type { GitSnapshotState, HudModalHandle } from "../extensions/pi-hud/types.ts";

const theme = { fg: (_color: unknown, text: string) => text };

class FakeSnapshots {
  generation = 0;
  active = false;
  cwd?: string;
  resetCalls = 0;
  disposeCalls = 0;
  pending: Array<{ generation: number; resolve(state: GitSnapshotState): void }> = [];

  reset(cwd: string): void {
    this.generation += 1;
    this.active = true;
    this.cwd = cwd;
    this.resetCalls += 1;
  }

  dispose(): void {
    this.generation += 1;
    this.active = false;
    this.cwd = undefined;
    this.disposeCalls += 1;
  }

  requestRefresh(): Promise<GitSnapshotState> {
    const generation = this.generation;
    return new Promise((resolve) => this.pending.push({ generation, resolve }));
  }

  currentGeneration(): number {
    return this.generation;
  }

  isCurrent(generation: number, cwd: string): boolean {
    return this.active && this.generation === generation && this.cwd === cwd;
  }

  complete(index: number): void {
    const pending = this.pending[index];
    pending.resolve({ status: "unavailable", generation: pending.generation });
  }
}

function lifecycleContext(options: { failFooterFactory?: boolean } = {}) {
  const calls: Array<{ method: string; value?: unknown }> = [];
  let footer: any;
  let widget: any;
  let disposedComponents = 0;
  const tui = { requestRender() {}, terminal: { rows: 40 } };
  const footerData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["pi-test", "ready"]]),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
  const dispose = (component: any) => {
    if (!component) return;
    component.dispose?.();
    disposedComponents += 1;
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    ui: {
      setFooter(value: unknown) {
        calls.push({ method: "setFooter", value });
        dispose(footer);
        footer = undefined;
        if (options.failFooterFactory && typeof value === "function") throw new Error("footer setup failed");
        if (typeof value === "function") footer = value(tui, theme, footerData);
      },
      setWidget(_id: string, value: unknown) {
        calls.push({ method: "setWidget", value });
        dispose(widget);
        widget = undefined;
        if (typeof value === "function") widget = value(tui, theme);
      },
      setStatus(_id: string, value: unknown) { calls.push({ method: "setStatus", value }); },
      notify() {},
    },
  };

  return {
    ctx,
    calls,
    activeComponents: () => Number(Boolean(footer)) + Number(Boolean(widget)),
    disposedComponents: () => disposedComponents,
  };
}

test("runtime cleanup is idempotent and owns surfaces, status, timers, modal, and snapshot disposal", () => {
  const snapshots = new FakeSnapshots();
  const runtime = new HudRuntimeOwner(snapshots as never);
  const harness = lifecycleContext();
  let modalDisposals = 0;
  const modal: HudModalHandle = { update() {}, dispose() { modalDisposals += 1; } };

  assert.doesNotThrow(() => runtime.shutdown(harness.ctx as never));
  assert.equal(harness.calls.length, 0);
  assert.equal(snapshots.disposeCalls, 0);
  runtime.start(harness.ctx as never);
  runtime.attachModal(modal);
  runtime.apply(harness.ctx as never);
  assert.equal(harness.activeComponents(), 1);

  runtime.shutdown(harness.ctx as never);
  const callCount = harness.calls.length;
  runtime.shutdown(harness.ctx as never);

  assert.equal(runtime.isActive(), false);
  assert.equal(harness.activeComponents(), 0);
  assert.equal(harness.disposedComponents() >= 1, true);
  assert.equal(harness.calls.some((call) => call.method === "setStatus" && call.value === undefined), true);
  assert.equal(harness.calls.length, callCount);
  assert.equal(modalDisposals, 1);
  assert.equal(snapshots.disposeCalls, 1);
  assert.equal(state.workTimer.active, false);
});

test("session start fully resets state and late refresh completion cannot update a replacement generation", async () => {
  const snapshots = new FakeSnapshots();
  const runtime = new HudRuntimeOwner(snapshots as never);
  const oldHarness = lifecycleContext();
  const newHarness = lifecycleContext();

  runtime.start(oldHarness.ctx as never);
  setDisplayMode("footer");
  state.components.git = false;
  state.agent = "testing";
  state.turn = 9;
  state.activeTools = [{ id: "old", toolName: "bash" }];
  state.toolCounts = { bash: 4 };
  state.successCalls = 3;
  state.errorCalls = 2;
  state.warningCalls = 1;
  state.thinkingLevel = "high";
  state.usage = { input: 100 };
  state.usageMessageKeys.add("old");
  state.workTimer = { active: true, startedAt: 1, elapsedMs: 50, lastRunMs: 50 };
  runtime.recordEvent(oldHarness.ctx as never, "agent_settled");
  assert.equal(snapshots.pending.length, 1);

  runtime.shutdown(oldHarness.ctx as never);
  runtime.start(newHarness.ctx as never);
  const newCalls = newHarness.calls.length;
  snapshots.complete(0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(newHarness.calls.length, newCalls);
  assert.equal(state.displayMode, "widget-first");
  assert.equal(Object.values(state.components).every(Boolean), true);
  assert.equal(state.agent, "idle");
  assert.equal(state.turn, 0);
  assert.deepEqual(state.activeTools, []);
  assert.deepEqual(state.toolCounts, {});
  assert.equal(state.successCalls, 0);
  assert.equal(state.errorCalls, 0);
  assert.equal(state.warningCalls, 0);
  assert.equal(state.thinkingLevel, undefined);
  assert.equal(state.usage, undefined);
  assert.equal(state.usageMessageKeys.size, 0);
  assert.deepEqual(state.workTimer, { active: false, elapsedMs: 0, lastRunMs: 0 });
  runtime.shutdown(newHarness.ctx as never);
});

test("partial surface setup failure can be cleaned and restarted", () => {
  const snapshots = new FakeSnapshots();
  const runtime = new HudRuntimeOwner(snapshots as never);
  const broken = lifecycleContext({ failFooterFactory: true });
  const healthy = lifecycleContext();

  runtime.start(broken.ctx as never);
  setDisplayMode("footer");
  assert.throws(() => runtime.apply(broken.ctx as never), /footer setup failed/);
  assert.doesNotThrow(() => runtime.shutdown(broken.ctx as never));
  assert.doesNotThrow(() => runtime.shutdown(broken.ctx as never));

  runtime.start(healthy.ctx as never);
  setDisplayMode("footer");
  assert.doesNotThrow(() => runtime.apply(healthy.ctx as never));
  assert.equal(healthy.activeComponents(), 1);
  runtime.shutdown(healthy.ctx as never);
  assert.equal(snapshots.resetCalls, 2);
  assert.equal(snapshots.disposeCalls, 2);
});

test("modal open, shutdown disposal, restart, close, and reopen never reuse a component", async () => {
  const snapshots = new FakeSnapshots();
  const runtime = new HudRuntimeOwner(snapshots as never);
  const components: any[] = [];
  const harness = lifecycleContext();
  (harness.ctx.ui as any).custom = (factory: Function) => new Promise<void>((resolve) => {
    const component = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, resolve);
    components.push(component);
  });

  runtime.start(harness.ctx as never);
  const firstOpen = openModal(harness.ctx as never, runtime);
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.shutdown(harness.ctx as never);
  await firstOpen;

  runtime.start(harness.ctx as never);
  const secondOpen = openModal(harness.ctx as never, runtime);
  await new Promise((resolve) => setTimeout(resolve, 0));
  components[1].close();
  await secondOpen;
  runtime.shutdown(harness.ctx as never);

  assert.equal(components.length, 2);
  assert.notStrictEqual(components[0], components[1]);
});

test("registered lifecycle handlers remain singular across reload/new/resume/fork/clone sequences", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const calls: Array<{ method: string; value?: unknown }> = [];
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    ui: {
      setFooter(value: unknown) { calls.push({ method: "setFooter", value }); },
      setWidget(_id: string, value: unknown) { calls.push({ method: "setWidget", value }); },
      setStatus(_id: string, value: unknown) { calls.push({ method: "setStatus", value }); },
      notify() {},
    },
  };

  piHud({
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
  } as never);

  for (const event of ["session_start", "session_shutdown", "session_info_changed", "agent_settled"]) assert.equal(handlers.get(event)?.length, 1);
  const sequences = [
    { start: "startup", shutdown: "reload" },
    { start: "reload", shutdown: "new" },
    { start: "new", shutdown: "resume" },
    { start: "resume", shutdown: "fork" },
    { start: "fork", shutdown: "fork" }, // clone is reported as fork by session_start/session_shutdown.
  ];

  for (const sequence of sequences) {
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: sequence.start }, ctx);
    state.turn = 7;
    for (const handler of handlers.get("session_info_changed") ?? []) await handler({ type: "session_info_changed", name: "renamed" }, ctx);
    for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
    const callsBeforeShutdown = calls.length;
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: sequence.shutdown }, ctx);
    assert.equal(state.turn, 0);
    assert.deepEqual(state.recentEvents, ["loaded"]);
    assert.equal(calls.length > callsBeforeShutdown, true);
  }

  const callsAfterShutdown = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, callsAfterShutdown);
  for (const event of ["session_start", "session_shutdown", "session_info_changed", "agent_settled"]) assert.equal(handlers.get(event)?.length, 1);
});
