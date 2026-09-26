import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerSweSurface } from "../extensions/pi-swe/src/pi/register.ts";
import { registerLightweightTodoSurface } from "../src/pi-todo/public.ts";

function registrations(register: Function) {
  const tools: string[] = [];
  const commands: string[] = [];
  register({
    on() {},
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
  });
  return { tools, commands };
}

test("SWE and Todo register independently without taking each other's tools", () => {
  assert.deepEqual(registrations(registerSweSurface), { tools: ["swe"], commands: ["swe"] });
  assert.deepEqual(registrations(registerLightweightTodoSurface), { tools: ["todo"], commands: ["todo"] });
});

test("Todo ownership has no SWE lifecycle, store, or verification imports", () => {
  const root = new URL("../src/pi-todo/", import.meta.url);
  for (const path of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith(".ts"))) {
    const source = readFileSync(new URL(String(path), root), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:pi-swe|app\/service|app\/store|verification)/, String(path));
  }
});
