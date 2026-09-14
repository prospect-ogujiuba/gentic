#!/usr/bin/env node
import { performance } from "node:perf_hooks";

import piCatalog from "../extensions/pi-catalog/index.ts";
import piCommands from "../extensions/pi-commands/index.ts";
import piContext from "../extensions/pi-context/index.ts";
import piGit from "../extensions/pi-git/index.ts";
import piHud from "../extensions/pi-hud/index.ts";
import piPrimitives from "../extensions/pi-primitives/index.ts";
import piSwe from "../extensions/pi-swe/index.ts";
import piTodo from "../extensions/pi-todo/index.ts";
import { createPiContextHudSnapshot } from "../extensions/pi-context/src/app/hud-adapter.ts";
import { createSnapshot } from "../extensions/pi-hud/src/app/snapshot.ts";
import { HudRuntimeOwner } from "../extensions/pi-hud/src/pi/runtime.ts";
import { renderHudWidgetLines } from "../extensions/pi-hud/src/ui/surfaces/widget.ts";
import type { HudSnapshot, Theme } from "../extensions/pi-hud/types.ts";
import { lightweightTodoParameters } from "../extensions/pi-todo/src/thin-surface.ts";
import { generateGenticInventory } from "../src/release/inventory.ts";

const root = new URL("..", import.meta.url).pathname;
const budgets = {
  contextHudIterations: 5_000,
  contextHudMs: 1_000,
  widgetIterations: 2_000,
  widgetMs: 1_000,
  hudSnapshotIterations: 2_000,
  hudSnapshotMs: 1_000,
  hudLifecycleIterations: 100,
  hudLifecycleMs: 1_000,
  extensionStartupMs: 1_500,
  inventoryMs: 750,
  toolSchemaBytes: 65_536,
} as const;
const failures: string[] = [];
const measure = (label: string, budget: number, run: () => void): number => {
  const started = performance.now();
  run();
  const duration = performance.now() - started;
  if (duration > budget) failures.push(`${label} ${duration.toFixed(1)}ms exceeds ${budget}ms`);
  return duration;
};

const contextMs = measure("context HUD hot path", budgets.contextHudMs, () => {
  for (let index = 0; index < budgets.contextHudIterations; index += 1) createPiContextHudSnapshot(undefined, { capturedAt: "2026-08-21T00:00:00.000Z" });
});
const theme: Theme = { fg: (_color: unknown, text: string) => text };
const snapshot: HudSnapshot = {
  modelId: "provider/model",
  worktreeId: "/repo/gentic",
  activeTools: [{ id: "1", toolName: "bash" }],
  activity: "executing",
};
const widgetMs = measure("HUD widget hot path", budgets.widgetMs, () => {
  for (let index = 0; index < budgets.widgetIterations; index += 1) renderHudWidgetLines(snapshot, theme, 100);
});
let usageReads = 0;
let branchReads = 0;
const hudContext = {
  cwd: root,
  mode: "rpc",
  model: { provider: "provider", id: "model" },
  getContextUsage: () => { usageReads += 1; return { tokens: 50, contextWindow: 100, percent: 50 }; },
  getSystemPrompt: () => "not scanned",
  sessionManager: { getBranch: () => { branchReads += 1; return []; } },
  ui: { setWidget() {} },
};
const hudSnapshotMs = measure("HUD snapshot hot path", budgets.hudSnapshotMs, () => {
  for (let index = 0; index < budgets.hudSnapshotIterations; index += 1) createSnapshot(hudContext as never);
});
if (usageReads !== budgets.hudSnapshotIterations || branchReads !== 0) failures.push(`HUD snapshot reads usage=${usageReads} branch=${branchReads}`);

const lifecycleSnapshots = {
  generation: 0,
  cwd: undefined as string | undefined,
  reset(cwd: string) { this.generation += 1; this.cwd = cwd; },
  dispose() { this.generation += 1; this.cwd = undefined; },
  requestRefresh() { return Promise.resolve({ status: "unavailable" as const, generation: this.generation }); },
  currentGeneration() { return this.generation; },
  isCurrent(generation: number, cwd: string) { return generation === this.generation && cwd === this.cwd; },
};
const runtime = new HudRuntimeOwner(lifecycleSnapshots);
const hudLifecycleMs = measure("HUD lifecycle hot path", budgets.hudLifecycleMs, () => {
  for (let index = 0; index < budgets.hudLifecycleIterations; index += 1) {
    runtime.start(hudContext as never);
    runtime.update(hudContext as never);
    runtime.shutdown(hudContext as never);
  }
});

const schemas: unknown[] = [];
const handlers = new Map<string, unknown[]>();
const capabilities = new Map<string, unknown>();
const pi = new Proxy({ capabilities }, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    if (key === "on") return (event: string, handler: unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    if (key === "events") return { on() {} };
    if (key === "registerTool") return (tool: { parameters?: unknown }) => { if (tool.parameters) schemas.push(tool.parameters); };
    if (typeof key === "string" && key.startsWith("register")) return () => undefined;
    if (key === "getCommands" || key === "getAllTools" || key === "getActiveTools") return () => [];
    return () => undefined;
  },
});
const extensions = [piCatalog, piCommands, piContext, piGit, piHud, piPrimitives, piSwe, piTodo];
const startupStarted = performance.now();
for (const extension of extensions) await extension(pi as never);
const startupMs = performance.now() - startupStarted;
if (startupMs > budgets.extensionStartupMs) failures.push(`extension startup ${startupMs.toFixed(1)}ms exceeds ${budgets.extensionStartupMs}ms`);
schemas.push(lightweightTodoParameters);
const schemaBytes = Buffer.byteLength(JSON.stringify(schemas));
if (schemaBytes > budgets.toolSchemaBytes) failures.push(`tool schemas ${schemaBytes} bytes exceeds ${budgets.toolSchemaBytes}`);
const inventoryMs = measure("inventory generation", budgets.inventoryMs, () => { generateGenticInventory(root); });

console.log(`performance: context=${contextMs.toFixed(1)}ms/${budgets.contextHudIterations} widget=${widgetMs.toFixed(1)}ms/${budgets.widgetIterations} hud-snapshot=${hudSnapshotMs.toFixed(1)}ms/${budgets.hudSnapshotIterations} hud-lifecycle=${hudLifecycleMs.toFixed(1)}ms/${budgets.hudLifecycleIterations} startup=${startupMs.toFixed(1)}ms inventory=${inventoryMs.toFixed(1)}ms schemas=${schemaBytes}B`);
if (failures.length) {
  for (const failure of failures) console.error(`performance: ${failure}`);
  process.exitCode = 1;
} else console.log("performance: budgets passed");
