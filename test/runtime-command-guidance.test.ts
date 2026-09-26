import test from "node:test";
import assert from "node:assert/strict";

import { registerPiCatalog } from "../extensions/pi-catalog/src/pi/register.ts";
import { clearCommand } from "../extensions/pi-commands/commands/clear.ts";
import { completeScaffoldArgument, scaffoldCommand } from "../extensions/pi-commands/commands/scaffold.ts";
import { completePiContextArgument } from "../extensions/pi-context/src/pi/register.ts";
import { registerPiGit } from "../extensions/pi-git/src/pi/register.ts";
import { completeHudArgument, registerHudCommand } from "../extensions/pi-hud/src/pi/adapter.ts";
import { getSweCommandCompletions } from "../extensions/pi-swe/src/pi/register.ts";
import { getTodoCommandCompletions } from "../extensions/pi-todo/src/pi/todo-surface.ts";

type Completion = { value: string; label: string; description?: string };
type Command = {
  getArgumentCompletions?: (prefix: string) => Completion[] | null;
  handler?: (args: string, ctx: any) => Promise<void> | void;
};

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

test("adopted command adapters render accurate invalid-input guidance", async () => {
  const notifications: string[] = [];
  const ctx = { cwd: process.cwd(), mode: "tui", ui: { notify: (message: string) => notifications.push(message) } };

  const catalog = new Map<string, Command>();
  registerPiCatalog({
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, command: Command) => catalog.set(name, command),
  } as never);
  await catalog.get("catalog")!.handler!("unknown", ctx);
  assert.match(notifications.pop() ?? "", /Usage: \/catalog status or \/catalog search <term>/);

  const hud = new Map<string, Command>();
  registerHudCommand({ registerCommand: (name: string, command: Command) => hud.set(name, command) } as never);
  await hud.get("pi-hud")!.handler!("mode invalid", ctx);
  assert.match(notifications.pop() ?? "", /Usage: \/pi-hud show or .*\/pi-hud mode <off\|widget-first>/);

  const scaffold = new Map<string, Command>();
  scaffoldCommand.register({ registerCommand: (name: string, command: Command) => scaffold.set(name, command) } as never);
  await scaffold.get("scaffold")!.handler!("unknown demo", ctx);
  assert.match(notifications.pop() ?? "", /Unknown scaffold kind: unknown[\s\S]*Usage: \/scaffold <kind>/);
});

test("order-independent and no-argument commands remain deliberately local", () => {
  assert.deepEqual(completePiContextArgument("summary art").map((item) => item.value), ["summary artifacts"]);

  const commands = new Map<string, Command>();
  clearCommand.register({ registerCommand: (name: string, command: Command) => commands.set(name, command) } as never);
  registerPiGit({
    registerTool: () => undefined,
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as never);
  assert.equal(commands.get("clear")?.getArgumentCompletions, undefined);
  assert.equal(commands.get("pi-git")?.getArgumentCompletions, undefined);
});
