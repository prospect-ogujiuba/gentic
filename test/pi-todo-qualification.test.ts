import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";

import piSwe from "../extensions/pi-swe/index.ts";
import piTodo from "../extensions/pi-todo/index.ts";

function registrations(extension: (pi: never) => void) {
  const handlers = new Map<string, Function[]>();
  const values = { tools: [] as string[], commands: [] as string[] };
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { values.tools.push(tool.name); },
    registerCommand(name: string) { values.commands.push(name); },
    appendEntry() {},
    sendMessage() {},
  };
  extension(pi as never);
  return { handlers, values };
}

test("pi-todo is independently discovered and reconstructs status from the session branch", async () => {
  const { handlers, values } = registrations(piTodo);
  const statuses: unknown[] = [];
  let branchReads = 0;
  const ctx = {
    cwd: "/tmp/pi-todo-qualification",
    hasUI: true,
    sessionManager: {
      getBranch: () => { branchReads += 1; return []; },
      getEntries: () => [],
    },
    ui: { setStatus: (_key: string, value: unknown) => statuses.push(value), notify() {} },
  };

  assert.deepEqual(values, { tools: ["todo"], commands: ["todo"] });
  assert.deepEqual([...handlers.keys()].sort(), ["session_start", "session_tree"]);
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.equal(branchReads, 1);
  assert.deepEqual(statuses, [undefined]);
});

test("pi-swe and pi-todo entrypoints own disjoint public registrations", async () => {
  assert.deepEqual(registrations(piSwe).values, { tools: ["swe"], commands: ["swe"] });
  await access(new URL("../extensions/pi-todo/index.ts", import.meta.url));
  await assert.rejects(access(new URL("../src/lifecycle-coordination.ts", import.meta.url)));

  const todoFiles = (await readdir(new URL("../extensions/pi-todo/src/", import.meta.url), { recursive: true }))
    .filter((path) => path.endsWith(".ts"));
  for (const path of ["pi/register.ts", "pi/todo-surface.ts", "pi/command-adapter.ts", "domain/state-core.ts", "app/project-store.ts", "app/project-backend.ts", "ui/docket.ts", "ui/modal.ts"]) {
    assert.ok(todoFiles.includes(path), `Todo owns ${path}`);
  }
  await assert.rejects(access(new URL("../src/pi-todo/", import.meta.url)));
  await access(new URL("../src/todo-contracts/workflow-integration.ts", import.meta.url));
  await access(new URL("../src/ui/todo-view/modal.ts", import.meta.url));

  const register = await readFile(new URL("../extensions/pi-swe/src/pi/register.ts", import.meta.url), "utf8");
  assert.doesNotMatch(register, /registerLightweightTodoSurface|BranchTodoCore|ProjectTodoStore/);
  const sweEntrypoint = await readFile(new URL("../extensions/pi-swe/index.ts", import.meta.url), "utf8");
  const todoEntrypoint = await readFile(new URL("../extensions/pi-todo/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sweEntrypoint, /registerLightweightTodoSurface/);
  assert.match(todoEntrypoint, /registerTodo/);
  assert.match(todoEntrypoint, /\.\/src\/pi\/register\.ts/);
  const todoRegister = await readFile(new URL("../extensions/pi-todo/src/pi/register.ts", import.meta.url), "utf8");
  assert.match(todoRegister, /registerLightweightTodoSurface/);
  assert.doesNotMatch(todoEntrypoint, /extensions\/pi-swe|\.\.\/pi-swe/);
  assert.doesNotMatch(register, /lifecycle-coordination|registerSweActivityProbe/);
});
