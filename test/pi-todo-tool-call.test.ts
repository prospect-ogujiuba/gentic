import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piTodo from "../extensions/pi-todo/index.ts";

type ToolCallHandler = (event: { type: "tool_call"; toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

type RegisteredTool = {
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<unknown>;
};

async function withTempProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-todo-tool-call-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function setupPiTodo(cwd: string) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, RegisteredTool>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const uiCalls: Array<{ method: string; key: string; value: unknown }> = [];

  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  const ctx = {
    cwd,
    sessionId: "pi-todo-tool-call-test",
    hasUI: true,
    sessionManager: { getEntries: () => entries },
    ui: {
      setStatus: (key: string, value: unknown) => uiCalls.push({ method: "setStatus", key, value }),
      setWidget: (key: string, value: unknown) => uiCalls.push({ method: "setWidget", key, value }),
      setTitle: () => {},
      notify: () => {},
    },
  };

  piTodo(pi as never);
  return { handlers, tools, ctx, uiCalls };
}

async function writeProjectConfig(cwd: string, config: unknown): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-todo.json"), JSON.stringify(config));
}

test("tool_call hook allows configured tools without an active todo", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, { enforcement: { rules: [{ pattern: "read", action: "allow" }] } });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "read" }, ctx);

    assert.equal(result, undefined);
  });
});

test("tool_call hook allows configured read-only bash without an active todo", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "pwd && ls" } }, ctx);

    assert.equal(result, undefined);
  });
});

test("tool_call hook blocks configured require-todo tools with repair text", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash" }, ctx);

    assert.deepEqual(result, {
      block: true,
      reason: 'pi-todo enforcement: requireTodo rule \'bash\'; no active todo. Call todo({ "action": "begin" }) then retry the blocked tool.',
    });
  });
});

test("tool_call hook still blocks mutating bash without an active todo", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    assert.deepEqual(result, {
      block: true,
      reason: 'pi-todo enforcement: requireTodo rule \'bash\'; no active todo. Call todo({ "action": "begin" }) then retry the blocked tool.',
    });
  });
});

test("tool_call hook preserves todo and active-todo short-circuit behavior", async () => {
  await withTempProject(async (cwd) => {
    const { handlers, tools, ctx } = setupPiTodo(cwd);
    const toolCall = handlers.get("tool_call") as ToolCallHandler;

    assert.equal(await toolCall({ type: "tool_call", toolName: "todo" }, ctx), undefined);

    const todo = tools.get("todo");
    assert.ok(todo);
    await todo.execute("create", { action: "create", title: "active fixture" }, new AbortController().signal, () => {}, ctx);
    await todo.execute("begin", { action: "begin" }, new AbortController().signal, () => {}, ctx);

    assert.equal(await toolCall({ type: "tool_call", toolName: "bash" }, ctx), undefined);
  });
});

test("tool_call hook surfaces invalid config diagnostics while falling back safely", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, { enforcement: { defaultAction: "bogus" } });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "write" }, ctx);

    assert.equal(typeof result, "object");
    assert.match(String((result as { reason?: unknown }).reason), /requireTodo rule 'write'/);
    assert.match(String((result as { reason?: unknown }).reason), /Config diagnostics: .*invalid 'enforcement\.defaultAction'/);
    assert.match(String((result as { reason?: unknown }).reason), /defaultAction forced to 'requireTodo'/);
    assert.match(String((result as { reason?: unknown }).reason), /Call todo\(\{ "action": "begin" \}\)/);
  });
});

test("tool_call hook blocks invalid relaxed enforcement instead of silently allowing tools", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "edit", action: "require" }],
      },
    });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "edit" }, ctx);

    assert.equal(typeof result, "object");
    assert.match(String((result as { reason?: unknown }).reason), /default requireTodo policy/);
    assert.match(String((result as { reason?: unknown }).reason), /invalid 'enforcement\.rules\[0\]\.action'/);
    assert.match(String((result as { reason?: unknown }).reason), /defaultAction forced to 'requireTodo'/);
  });
});
