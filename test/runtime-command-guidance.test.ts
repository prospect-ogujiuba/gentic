import test from "node:test";
import assert from "node:assert/strict";

import { registerPiCatalog } from "../extensions/pi-catalog/src/pi/register.ts";
import { completeScaffoldArgument } from "../extensions/pi-commands/commands/scaffold.ts";
import { completePiContextArgument } from "../extensions/pi-context/src/pi/register.ts";
import { completeHudArgument } from "../extensions/pi-hud/src/pi/adapter.ts";
import { getSweCommandCompletions } from "../extensions/pi-swe/src/pi/register.ts";
import { getTodoCommandCompletions } from "../extensions/pi-todo/src/thin-surface.ts";

type Completion = { value: string; label: string; description?: string };
type Command = { getArgumentCompletions?: (prefix: string) => Completion[] | null };

function assertDescribed(items: readonly Completion[]): void {
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.value && item.label && item.description?.trim()));
}

test("runtime command roots expose concise syntax-aware descriptions", () => {
  const scaffold = completeScaffoldArgument("");
  const context = completePiContextArgument("");
  const hud = completeHudArgument("");
  const swe = getSweCommandCompletions("");
  const todo = getTodoCommandCompletions("");

  for (const items of [scaffold, context, hud, swe, todo]) assertDescribed(items);
  assert.match(swe.find((item) => item.value === "status")!.description!, /\/swe status/);
  assert.match(hud.find((item) => item.value === "mode")!.description!, /<off\|widget-first>/);
});

test("nested completions preserve the full argument prefix and explain values", () => {
  assert.deepEqual(getSweCommandCompletions("st").map((item) => item.value), ["status", "start"]);
  assertDescribed(getSweCommandCompletions("st"));
  assert.deepEqual(completeHudArgument("mode w").map((item) => item.value), ["mode widget-first"]);
  assert.deepEqual(completeScaffoldArgument("extension demo --l").map((item) => item.value), ["extension demo --layered"]);
  assert.ok(!completeScaffoldArgument("extension demo --minimal ").some((item) => item.label === "--layered"));
  assert.ok(!completeScaffoldArgument("command demo --apply ").some((item) => item.label === "--dry-run"));
  assert.deepEqual(completePiContextArgument("summary sys").map((item) => item.value), ["summary system"]);
  assert.deepEqual(completePiContextArgument("help "), []);
});

test("registered catalog command describes its nested choices", () => {
  const commands = new Map<string, Command>();
  registerPiCatalog({
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as never);

  const catalogItems = commands.get("catalog")!.getArgumentCompletions!("")!;
  assert.deepEqual(catalogItems.map((item) => item.value), ["status", "search"]);
  assertDescribed(catalogItems);
});
