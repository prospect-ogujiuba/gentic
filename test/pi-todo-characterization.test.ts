import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piTodo from "../extensions/pi-todo/index.ts";

type TodoState = {
  todos: Record<string, {
    id: string;
    title: string;
    status: string;
    blockedReason?: string;
  }>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { todo?: TodoState["todos"][string]; state?: TodoState; error?: { code?: string } };
};

type ToolCallHandler = (
  event: { type: "tool_call"; toolName: string; input?: Record<string, unknown> },
  ctx: unknown,
) => Promise<unknown>;

type RegisteredTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
};

async function withHarness(run: (harness: ReturnType<typeof createHarness>) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-todo-characterization-"));
  try {
    await run(createHarness(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createHarness(cwd: string, initialBranch: unknown[] = []) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, RegisteredTool>();
  const branch: unknown[] = structuredClone(initialBranch);
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: RegisteredTool & { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  const ctx = {
    cwd,
    sessionId: "characterization-session",
    hasUI: false,
    mode: "json",
    sessionManager: { getBranch: () => branch },
    ui: { setStatus() {}, setWidget() {}, setTitle() {}, notify() {} },
  };
  piTodo(pi as never);
  const todo = tools.get("todo");
  assert.ok(todo);
  const execute = (action: string, params: Record<string, unknown> = {}) =>
    todo.execute(action, { action, ...params }, new AbortController().signal, () => {}, ctx);
  return { branch, cwd, ctx, execute, handlers };
}

function onlyTodo(result: ToolResult): TodoState["todos"][string] {
  assert.ok(result.details.todo);
  return result.details.todo;
}

function stateOf(result: ToolResult): TodoState {
  assert.ok(result.details.state);
  return result.details.state;
}

test("black-box tool preserves create, start, block, list, and finish behavior", async () => {
  await withHarness(async ({ execute }) => {
    const created = onlyTodo(await execute("create", { title: "Characterize lifecycle" }));
    assert.equal(created.status, "ready");

    const started = onlyTodo(await execute("start", { todoId: created.id }));
    assert.equal(started.status, "in_progress");

    const blocked = onlyTodo(await execute("block", { todoId: created.id, reason: "waiting on user" }));
    assert.equal(blocked.status, "external_blocked");
    assert.equal(blocked.blockedReason, "waiting on user");

    const completable = onlyTodo(await execute("create", { title: "Finish characterization" }));
    await execute("start", { todoId: completable.id });
    const finished = onlyTodo(await execute("finish", { summary: "characterized" }));
    assert.equal(finished.id, completable.id);
    assert.equal(finished.status, "completed");

    const listed = stateOf(await execute("list"));
    assert.deepEqual(
      Object.values(listed.todos).map(({ title, status }) => ({ title, status })),
      [
        { title: "Characterize lifecycle", status: "external_blocked" },
        { title: "Finish characterization", status: "completed" },
      ],
    );
  });
});

test("tool state reconstructs exclusively from the active session branch", async () => {
  await withHarness(async ({ branch, execute }) => {
    const created = onlyTodo(await execute("create", { title: "Branch-owned active work" }));
    await execute("start", { todoId: created.id });
    const activeBranch = structuredClone(branch);

    await execute("finish", { todoId: created.id, summary: "future branch" });
    assert.equal(stateOf(await execute("list")).todos[created.id].status, "completed");

    branch.splice(0, branch.length, ...activeBranch);
    const reconstructed = stateOf(await execute("list"));
    assert.equal(reconstructed.todos[created.id].status, "in_progress");
  });
});

test("fresh runtime replays persisted session entries without writing during reads", async () => {
  await withHarness(async ({ cwd, branch, execute }) => {
    const created = onlyTodo(await execute("create", { title: "Survive restart" }));
    await execute("start", { todoId: created.id });
    const persisted = structuredClone(branch);
    const restarted = createHarness(cwd, persisted);

    const state = stateOf(await restarted.execute("list", { scope: "session" }));
    assert.equal(state.todos[created.id].status, "in_progress");
    assert.deepEqual(restarted.branch, persisted);

    await restarted.execute("finish", { scope: "session", todoId: created.id, summary: "after restart" });
    assert.equal(stateOf(await restarted.execute("list")).todos[created.id].status, "completed");
    assert.deepEqual(branch, persisted);
  });
});

test("forked runtimes preserve their shared prefix but isolate later mutations", async () => {
  await withHarness(async ({ cwd, branch, execute }) => {
    const created = onlyTodo(await execute("create", { title: "Shared prefix" }));
    const fork = createHarness(cwd, branch);
    await execute("start", { todoId: created.id });
    await fork.execute("block", { todoId: created.id, reason: "fork only" });

    assert.equal(stateOf(await execute("list")).todos[created.id].status, "in_progress");
    assert.equal(stateOf(await fork.execute("list")).todos[created.id].status, "external_blocked");
    const forkOnly = onlyTodo(await fork.execute("create", { title: "Fork-local work" }));
    assert.equal(stateOf(await execute("list")).todos[forkOnly.id], undefined);
  });
});

test("registered tool permits at most one active todo for the session owner", async () => {
  await withHarness(async ({ execute }) => {
    const first = onlyTodo(await execute("create", { title: "First active" }));
    const second = onlyTodo(await execute("create", { title: "Second ready" }));
    await execute("start", { todoId: first.id });

    const rejected = await execute("start", { todoId: second.id });
    assert.equal(rejected.details.error?.code, "ACTIVE_TODO_EXISTS");

    const state = stateOf(await execute("list"));
    assert.deepEqual(
      Object.values(state.todos).map(({ title, status }) => ({ title, status })),
      [
        { title: "First active", status: "in_progress" },
        { title: "Second ready", status: "ready" },
      ],
    );
  });
});

test("standalone pi-todo installs no workflow lifecycle observation hooks", async () => {
  await withHarness(async ({ handlers }) => {
    assert.equal(handlers.has("tool_call"), false);
    assert.equal(handlers.has("tool_result"), false);
    assert.deepEqual([...handlers.keys()].sort(), ["session_start", "session_tree"]);
  });
});
