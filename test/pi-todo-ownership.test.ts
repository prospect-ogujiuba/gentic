import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSweSurface } from "../extensions/pi-swe/src/pi/register.ts";
import { registerLightweightTodoSurface } from "../extensions/pi-todo/src/public.ts";

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

test("Todo runtime is extension-local and shared modules cannot import extension implementations", () => {
  const project = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(existsSync(resolve(project, "src/pi-todo")), false);
  for (const file of ["domain/state-core.ts", "app/project-store.ts", "app/project-backend.ts", "pi/register.ts", "pi/todo-surface.ts", "pi/command-adapter.ts", "ui/docket.ts", "ui/modal.ts"]) {
    assert.ok(existsSync(resolve(project, "extensions/pi-todo/src", file)), file);
  }
  for (const directory of ["src", "extensions/pi-swe"]) {
    const root = resolve(project, directory);
    for (const path of readdirSync(root, { recursive: true }).filter((path) => String(path).endsWith(".ts"))) {
      const file = resolve(root, String(path));
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
        if (!match[1].startsWith(".")) continue;
        const target = relative(project, resolve(dirname(file), match[1]));
        assert.ok(!target.startsWith("extensions/pi-todo/"), `${file} imports private Todo implementation ${target}`);
        if (directory === "src") assert.ok(!target.startsWith("extensions/"), `${file} imports extension implementation ${target}`);
      }
    }
  }
});

test("shared Todo contracts and view adapters remain registration- and persistence-free", () => {
  for (const directory of ["../src/todo-contracts/", "../src/ui/todo-view/"]) {
    const root = new URL(directory, import.meta.url);
    for (const path of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith(".ts"))) {
      const source = readFileSync(new URL(String(path), root), "utf8");
      assert.doesNotMatch(source, /node:fs|registerTool|registerCommand|appendEntry|BranchTodoCore|ProjectTodoStore|SweService/, String(path));
    }
  }
});

test("Todo ownership has no SWE lifecycle, store, or verification imports", () => {
  const root = new URL("../extensions/pi-todo/src/", import.meta.url);
  for (const path of readdirSync(root, { recursive: true }).filter((p) => String(p).endsWith(".ts"))) {
    const source = readFileSync(new URL(String(path), root), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:pi-swe|app\/service|app\/store|verification)/, String(path));
  }
});
