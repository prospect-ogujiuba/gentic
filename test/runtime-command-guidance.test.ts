import test from "node:test";
import assert from "node:assert/strict";

import { completeGenticArgument } from "../extensions/gentic/src/pi/register.ts";
import { registerArtifactsCommand } from "../extensions/pi-artifacts/src/pi/commands.ts";
import { registerPiCatalog } from "../extensions/pi-catalog/src/pi/register.ts";
import { completeScaffoldArgument } from "../extensions/pi-commands/commands/scaffold.ts";
import { completePiContextArgument } from "../extensions/pi-context/src/pi/register.ts";
import { completeHudArgument } from "../extensions/pi-hud/src/pi/adapter.ts";
import { completeSweArgument } from "../extensions/pi-swe/src/pi/commands.ts";
import { getTodoCommandCompletions } from "../extensions/pi-todo/src/pi/actions.ts";

type Completion = { value: string; label: string; description?: string };
type Command = { getArgumentCompletions?: (prefix: string) => Completion[] | null };

function assertDescribed(items: readonly Completion[]): void {
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.value && item.label && item.description?.trim()));
}

test("runtime command roots expose concise syntax-aware descriptions", () => {
  const gentic = completeGenticArgument({ getCommands: () => [] } as never, "");
  const scaffold = completeScaffoldArgument("");
  const context = completePiContextArgument("");
  const hud = completeHudArgument("");
  const swe = completeSweArgument("");
  const todo = getTodoCommandCompletions("");

  for (const items of [gentic, scaffold, context, hud, swe, todo]) assertDescribed(items);
  assert.match(swe.find((item) => item.value === "work")!.description!, /\/swe work/);
  assert.match(hud.find((item) => item.value === "mode")!.description!, /<off\|widget-first\|footer>/);
});

test("nested completions preserve the full argument prefix and explain values", () => {
  assert.deepEqual(completeSweArgument("work start demo --mode ").map((item) => item.value), [
    "work start demo --mode guided",
    "work start demo --mode autonomous",
  ]);
  assertDescribed(completeSweArgument("work start demo --mode "));
  assert.deepEqual(completeSweArgument("work start demo --until i").map((item) => item.value), [
    "work start demo --until initiative",
  ]);
  assert.deepEqual(completeHudArgument("mode w").map((item) => item.value), ["mode widget-first"]);
  assert.deepEqual(completeScaffoldArgument("extension demo --l").map((item) => item.value), ["extension demo --layered"]);
  assert.ok(!completeScaffoldArgument("extension demo --minimal ").some((item) => item.label === "--layered"));
  assert.ok(!completeScaffoldArgument("command demo --apply ").some((item) => item.label === "--dry-run"));
  assert.deepEqual(completePiContextArgument("summary sys").map((item) => item.value), ["summary system"]);
  assert.deepEqual(completePiContextArgument("help "), []);
});

test("registered artifact and catalog commands describe their nested choices", () => {
  const commands = new Map<string, Command>();
  registerArtifactsCommand({ registerCommand: (name: string, command: Command) => commands.set(name, command) } as never);
  registerPiCatalog({
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as never);

  const artifactItems = commands.get("artifacts")!.getArgumentCompletions!("a")!;
  assert.deepEqual(artifactItems.map((item) => item.value), ["apply", "audit"]);
  assertDescribed(artifactItems);

  const catalogItems = commands.get("catalog")!.getArgumentCompletions!("")!;
  assert.ok(catalogItems.some((item) => item.value === "summary"));
  assertDescribed(catalogItems);
});

test("gentic run completion describes and inserts extension commands", () => {
  const pi = {
    getCommands: () => [
      { name: "swe", source: "extension", description: "/swe <...> — manage SWE", sourceInfo: { path: "/repo/extensions/pi-swe/index.ts" } },
      { name: "model", source: "builtin", description: "Select model" },
    ],
  };
  assert.deepEqual(completeGenticArgument(pi as never, "run sw"), [
    { value: "run swe", label: "swe", description: "/swe <...> — manage SWE" },
  ]);
});
