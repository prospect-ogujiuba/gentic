import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piTodo from "../extensions/pi-todo/index.ts";
import { todoToolParameters } from "../extensions/pi-todo/src/pi/schema.ts";

type ToolCallHandler = (event: { type: "tool_call"; toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

type RegisteredTool = {
  executionMode?: "sequential" | "parallel";
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
  const entries: unknown[] = [];
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
    mode: "tui",
    sessionManager: { getBranch: () => entries },
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

test("todo tool uses Google-compatible enums and serializes concurrent mutation calls", async () => {
  await withTempProject(async (cwd) => {
    const { tools, ctx } = setupPiTodo(cwd);
    const tool = tools.get("todo")!;
    assert.equal(tool.executionMode, "sequential");
    assert.deepEqual((todoToolParameters.properties.action as { type?: string }).type, "string");
    assert.ok(Array.isArray((todoToolParameters.properties.action as { enum?: unknown[] }).enum));

    const signal = new AbortController().signal;
    const calls = Array.from({ length: 20 }, (_, index) => tool.execute(`call-${index}`, { action: "create", title: `retry ${index}`, commandId: "same-create" }, signal, () => {}, ctx));
    const results = await Promise.all(calls) as Array<{ details: { todo: { id: string } } }>;
    assert.equal(new Set(results.map((result) => result.details.todo.id)).size, 1);
  });
});

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

test("tool_call hook creates an active todo before blocking require-todo tools", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, tools, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    assert.equal(typeof result, "object");
    assert.match(String((result as { reason?: unknown }).reason), /created and started 'use bash on rm'/);
    assert.match(String((result as { reason?: unknown }).reason), /Retry the original bash call now; do not call todo begin\/list\/split first/);

    const active = await tools.get("todo")?.execute("list", { action: "list" }, new AbortController().signal, () => {}, ctx);
    assert.match(String((active as { content?: Array<{ text: string }> }).content?.[0]?.text), /use bash on rm/);
    assert.match(String((active as { content?: Array<{ text: string }> }).content?.[0]?.text), /in progress/);
  });
});

test("tool_call hook starts an existing ready todo instead of creating a duplicate", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, tools, ctx } = setupPiTodo(cwd);
    const todo = tools.get("todo")!;
    await todo.execute("create", { action: "create", title: "Fix the requested behavior" }, new AbortController().signal, () => {}, ctx);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    assert.match(String((result as { reason?: unknown }).reason), /started existing ready todo 'Fix the requested behavior'/);
    const listed = await todo.execute("list", { action: "list" }, new AbortController().signal, () => {}, ctx) as { details: { state: { todos: Record<string, { status: string; title: string }> } } };
    const todos = Object.values(listed.details.state.todos);
    assert.equal(todos.length, 1);
    assert.deepEqual(todos.map(({ status, title }) => ({ status, title })), [{ status: "in_progress", title: "Fix the requested behavior" }]);
  });
});

test("tool_call hook derives the guard todo title from the latest user request", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, tools, ctx } = setupPiTodo(cwd);
    (ctx.sessionManager.getBranch() as unknown[]).push({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "How do we get pi-todo to create actual titles?" }],
      },
    });

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    assert.equal(typeof result, "object");
    assert.match(String((result as { reason?: unknown }).reason), /created and started 'Get pi-todo to create actual titles'/);
    assert.doesNotMatch(String((result as { reason?: unknown }).reason), /use bash on rm/);

    const active = await tools.get("todo")?.execute("list", { action: "list" }, new AbortController().signal, () => {}, ctx);
    assert.match(String((active as { content?: Array<{ text: string }> }).content?.[0]?.text), /Get pi-todo to create actual titles/);
  });
});

test("tool_call hook removes injected skill content and caps semantic titles", async () => {
  await withTempProject(async (cwd) => {
    const { handlers, ctx } = setupPiTodo(cwd);
    (ctx.sessionManager.getBranch() as unknown[]).push({
      type: "message",
      message: {
        role: "user",
        content: `<skill name="workflow">${"implementation guidance ".repeat(20)}</skill> Please fix semantic todo titles and verify the behavior`,
      },
    });

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "write", input: { path: "output.txt" } }, ctx);
    const reason = String((result as { reason?: unknown }).reason);

    assert.match(reason, /created and started 'Fix semantic todo titles and verify the behavior'/);
    assert.doesNotMatch(reason, /implementation guidance|use write/);
  });
});

test("todo mutation output omits internal ids", async () => {
  await withTempProject(async (cwd) => {
    const { tools, ctx } = setupPiTodo(cwd);
    const result = await tools.get("todo")?.execute("create", { action: "create", title: "Align helpdesk systems" }, new AbortController().signal, () => {}, ctx);
    const text = String((result as { content?: Array<{ text: string }> }).content?.[0]?.text);

    assert.equal(text, "Created Align helpdesk systems - [ready]");
    assert.doesNotMatch(text, /todo_[a-z0-9_]+/i);
  });
});

test("tool_call hook still blocks mutating bash after creating guard todo", async () => {
  await withTempProject(async (cwd) => {
    await writeProjectConfig(cwd, {
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "bash", action: "requireTodo" }],
      },
    });
    const { handlers, ctx } = setupPiTodo(cwd);

    const result = await (handlers.get("tool_call") as ToolCallHandler)({ type: "tool_call", toolName: "bash", input: { command: "rm -rf tmp" } }, ctx);

    assert.equal(typeof result, "object");
    assert.match(String((result as { reason?: unknown }).reason), /created and started 'use bash on rm'/);
    assert.match(String((result as { reason?: unknown }).reason), /Retry the original bash call now/);
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
    assert.match(String((result as { reason?: unknown }).reason), /pi-todo enforcement: (?:requireTodo rule 'write'|default requireTodo policy)/);
    assert.match(String((result as { reason?: unknown }).reason), /Config diagnostics: .*invalid 'enforcement\.defaultAction'/);
    assert.match(String((result as { reason?: unknown }).reason), /defaultAction forced to 'requireTodo'/);
    assert.match(String((result as { reason?: unknown }).reason), /Retry the original write call now/);
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
