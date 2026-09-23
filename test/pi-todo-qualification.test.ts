import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";

import piSwe from "../extensions/pi-swe/index.ts";

test("pi-swe entrypoint registers the standalone todo runtime and reconstructs status from the branch", async () => {
  const handlers = new Map<string, Function[]>();
  const registrations = { tools: [] as string[], commands: [] as string[] };
  const statuses: unknown[] = [];
  let branchReads = 0;
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { registrations.tools.push(tool.name); },
    registerCommand(name: string) { registrations.commands.push(name); },
    appendEntry() {},
    sendMessage() {},
  };
  const ctx = {
    cwd: "/tmp/pi-todo-qualification",
    hasUI: true,
    sessionManager: {
      getBranch: () => { branchReads += 1; return []; },
      getEntries: () => [],
    },
    ui: { setStatus: (_key: string, value: unknown) => statuses.push(value), notify() {} },
  };

  piSwe(pi as never);
  assert.deepEqual(registrations, { tools: ["swe", "todo"], commands: ["swe", "todo"] });
  assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "context", "session_start", "session_tree", "tool_call", "tool_result"]);

  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.equal(branchReads, 1);
  assert.deepEqual(statuses, [undefined]);
});

test("independent pi-todo discovery and optional lifecycle bridge are retired", async () => {
  await assert.rejects(access(new URL("../extensions/pi-todo/index.ts", import.meta.url)));
  await assert.rejects(access(new URL("../src/lifecycle-coordination.ts", import.meta.url)));

  const todoFiles = (await readdir(new URL("../extensions/pi-swe/src/todo/", import.meta.url), { recursive: true }))
    .filter((path) => path.endsWith(".ts"));
  assert.ok(todoFiles.includes("thin-surface.ts"));
  assert.ok(todoFiles.includes("workflow-backend.ts"));
  assert.ok(todoFiles.includes("ui/shared-modal.ts"));

  const register = await readFile(new URL("../extensions/pi-swe/src/pi/register.ts", import.meta.url), "utf8");
  assert.match(register, /registerLightweightTodoSurface/);
  assert.doesNotMatch(register, /lifecycle-coordination|registerSweActivityProbe/);
});
