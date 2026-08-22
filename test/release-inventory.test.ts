import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
import { generateGenticInventory } from "../src/release/inventory.ts";

const root = new URL("..", import.meta.url).pathname;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

test("generated source/manifest inventory matches runtime registration smoke output", async () => {
  const inventory = generateGenticInventory(root);
  const checked = JSON.parse(readFileSync(`${root}/catalog/gentic-inventory.json`, "utf8"));
  assert.deepEqual(checked, inventory);

  const runtime = { commands: new Set<string>(), tools: new Set<string>(), events: new Set<string>() };
  const capabilities = new Map<string, unknown>();
  const pi = new Proxy({ capabilities }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === "on") return (event: string) => runtime.events.add(event);
      if (key === "registerCommand") return (name: string) => runtime.commands.add(name);
      if (key === "registerTool") return (tool: { name: string }) => runtime.tools.add(tool.name);
      if (typeof key === "string" && key.startsWith("register")) return () => undefined;
      if (key === "getCommands" || key === "getAllTools" || key === "getActiveTools") return () => [];
      return () => undefined;
    },
  });
  for (const extension of [gentic, piCatalog, piCommands, piContext, piGate, piGit, piHud, piPrimitives, piSwe, piTodo]) {
    await extension(pi as never);
  }

  const declared = {
    commands: sorted(inventory.extensions.flatMap((extension) => extension.registrations.commands)),
    tools: sorted(inventory.extensions.flatMap((extension) => extension.registrations.tools)),
    events: sorted(inventory.extensions.flatMap((extension) => extension.registrations.events)),
  };
  assert.deepEqual(sorted(runtime.commands), declared.commands);
  assert.deepEqual(sorted(runtime.tools), declared.tools);
  assert.deepEqual(sorted(runtime.events), declared.events);
});

test("core and full profiles use only manifest-native resource filters", () => {
  const inventory = generateGenticInventory(root);
  assert.deepEqual(inventory.profiles.map((profile) => profile.id), ["core", "full"]);
  const known = new Set(inventory.resources.extensions);
  for (const profile of inventory.profiles) {
    assert.ok(profile.extensions.length > 0);
    assert.ok(profile.extensions.every((path) => known.has(path.replace(/^\+/, ""))));
  }
});
