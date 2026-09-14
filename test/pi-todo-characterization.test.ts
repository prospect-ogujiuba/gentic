import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function createHarness(cwd: string) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, RegisteredTool>();
  const branch: unknown[] = [];
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

test("tool-call ownership blocks competing todo activation while pi-swe is active", async () => {
  await withHarness(async ({ cwd, ctx, handlers }) => {
    const workflowDirectory = join(cwd, ".model-artifacts/initiatives/owned");
    await mkdir(workflowDirectory, { recursive: true });
    await writeFile(join(workflowDirectory, "workflow.json"), JSON.stringify({
      version: 1,
      topic: "owned",
      goal: "Own lifecycle",
      revision: 1,
      updatedAt: new Date().toISOString(),
      status: "active",
      activeTask: "T1",
      tasks: [{
        id: "T1",
        status: "active",
        approaches: [],
        approachReasons: {},
        assessmentStatus: "assessed",
        verificationCheckpoint: { revision: 1, at: new Date().toISOString() },
      }],
    }));
    const hook = handlers.get("tool_call") as ToolCallHandler;

    for (const action of ["create", "start", "finish"]) {
      const result = await hook({ type: "tool_call", toolName: "todo", input: { action } }, ctx) as { block?: boolean; reason?: string };
      assert.equal(result.block, true);
      assert.match(result.reason ?? "", /pi-swe lifecycle ownership/);
    }
    assert.equal(await hook({ type: "tool_call", toolName: "todo", input: { action: "list" } }, ctx), undefined);
    assert.equal(await hook({ type: "tool_call", toolName: "swe_workflow", input: { action: "status" } }, ctx), undefined);
    assert.equal(await hook({ type: "tool_call", toolName: "write" }, ctx), undefined);
  });
});
