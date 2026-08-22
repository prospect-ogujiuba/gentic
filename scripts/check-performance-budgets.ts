#!/usr/bin/env node
import { performance } from "node:perf_hooks";

import gentic from "../extensions/gentic/index.ts";
import piCatalog from "../extensions/pi-catalog/index.ts";
import piCommands from "../extensions/pi-commands/index.ts";
import piContext from "../extensions/pi-context/index.ts";
import piGate from "../extensions/pi-gate/index.ts";
import piGit from "../extensions/pi-git/index.ts";
import piHud from "../extensions/pi-hud/index.ts";
import piPrimitives from "../extensions/pi-primitives/index.ts";
import piSwe from "../extensions/pi-swe/index.ts";
import piTodo from "../extensions/pi-todo/index.ts";
import { createPiContextHudSnapshot } from "../extensions/pi-context/src/app/hud-adapter.ts";
import { resetConfig } from "../extensions/pi-hud/src/app/state.ts";
import { renderFooterLines } from "../extensions/pi-hud/src/ui/surfaces/footer.ts";
import type { HudSnapshot, Theme } from "../extensions/pi-hud/types.ts";
import { todoToolParameters } from "../extensions/pi-todo/src/pi/schema.ts";
import { generateGenticInventory } from "../src/release/inventory.ts";

const root = new URL("..", import.meta.url).pathname;
const budgets = {
  contextHudIterations: 5_000,
  contextHudMs: 1_000,
  footerIterations: 2_000,
  footerMs: 1_000,
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
  thinkingLevel: "medium",
  worktreeId: "/repo/gentic",
  activeTools: [{ id: "1", toolName: "bash" }],
  toolCounts: { bash: 3, read: 2 },
  recentEvents: ["tool_execution_start", "message_end"],
};
resetConfig();
const footerMs = measure("HUD footer hot path", budgets.footerMs, () => {
  for (let index = 0; index < budgets.footerIterations; index += 1) renderFooterLines(snapshot, theme, 100);
});
const schemas: unknown[] = [];
const handlers = new Map<string, unknown[]>();
const capabilities = new Map<string, unknown>();
const pi = new Proxy({ capabilities }, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    if (key === "on") return (event: string, handler: unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    if (key === "registerTool") return (tool: { parameters?: unknown }) => { if (tool.parameters) schemas.push(tool.parameters); };
    if (typeof key === "string" && key.startsWith("register")) return () => undefined;
    if (key === "getCommands" || key === "getAllTools" || key === "getActiveTools") return () => [];
    return () => undefined;
  },
});
const extensions = [gentic, piCatalog, piCommands, piContext, piGate, piGit, piHud, piPrimitives, piSwe, piTodo];
const startupStarted = performance.now();
for (const extension of extensions) await extension(pi as never);
const startupMs = performance.now() - startupStarted;
if (startupMs > budgets.extensionStartupMs) failures.push(`extension startup ${startupMs.toFixed(1)}ms exceeds ${budgets.extensionStartupMs}ms`);
schemas.push(todoToolParameters);
const schemaBytes = Buffer.byteLength(JSON.stringify(schemas));
if (schemaBytes > budgets.toolSchemaBytes) failures.push(`tool schemas ${schemaBytes} bytes exceeds ${budgets.toolSchemaBytes}`);
const inventoryMs = measure("inventory generation", budgets.inventoryMs, () => { generateGenticInventory(root); });

console.log(`performance: context=${contextMs.toFixed(1)}ms/${budgets.contextHudIterations} footer=${footerMs.toFixed(1)}ms/${budgets.footerIterations} startup=${startupMs.toFixed(1)}ms inventory=${inventoryMs.toFixed(1)}ms schemas=${schemaBytes}B`);
if (failures.length) {
  for (const failure of failures) console.error(`performance: ${failure}`);
  process.exitCode = 1;
} else console.log("performance: budgets passed");
