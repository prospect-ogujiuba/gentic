import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import piTodo from "../extensions/pi-todo/index.ts";

test("pi-todo entrypoint registers only the thin runtime and reconstructs status from the branch", async () => {
  const handlers = new Map<string, Function[]>();
  const registrations = { tools: [] as string[], commands: [] as string[] };
  const statuses: unknown[] = [];
  let branchReads = 0;
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { registrations.tools.push(tool.name); },
    registerCommand(name: string) { registrations.commands.push(name); },
    appendEntry() {},
  };
  const ctx = {
    cwd: "/tmp/pi-todo-qualification",
    hasUI: true,
    sessionManager: { getBranch: () => { branchReads += 1; return []; } },
    ui: { setStatus: (_key: string, value: unknown) => statuses.push(value), notify() {} },
  };

  piTodo(pi as never);
  assert.deepEqual(registrations, { tools: ["todo"], commands: ["todo"] });
  assert.deepEqual([...handlers.keys()].sort(), ["session_start", "session_tree", "tool_call"]);

  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
  assert.equal(branchReads, 1);
  assert.deepEqual(statuses, [undefined]);
});

test("pi-todo package contains no competing legacy runtime", async () => {
  const root = new URL("../extensions/pi-todo/", import.meta.url);
  const sourceFiles = [
    "index.ts",
    ...(await readdir(new URL("src/", root), { recursive: true }))
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `src/${path.replaceAll("\\", "/")}`),
  ].sort();
  assert.deepEqual(sourceFiles, [
    "index.ts",
    "src/command-adapter.ts",
    "src/contract.ts",
    "src/state-core.ts",
    "src/thin-surface.ts",
    "src/ui/docket.ts",
    "src/ui/format.ts",
    "src/ui/modal.ts",
    "src/ui/theme.ts",
  ]);

  const entrypoint = await readFile(new URL("index.ts", root), "utf8");
  assert.doesNotMatch(entrypoint, /scheduler|lease|split|artifact|modal|turn_end|agent_settled/);
  assert.match(entrypoint, /registerLightweightTodoSurface/);

  const surface = await readFile(new URL("src/thin-surface.ts", root), "utf8");
  assert.doesNotMatch(surface, /pi-swe\/src|workflow\.json|activeWorkflowTopics/);
  assert.match(surface, /coordinatedActiveSwe/);
});
