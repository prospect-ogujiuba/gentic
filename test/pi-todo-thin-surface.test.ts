import test from "node:test";
import assert from "node:assert/strict";

import { getTodoCommandCompletions, registerLightweightTodoSurface } from "../extensions/pi-todo/src/pi/todo-surface.ts";

type RegisteredTool = {
  parameters: { properties: {
    action: { enum?: string[] };
    title?: { maxLength?: number };
    todoId?: { maxLength?: number };
    parentTodoId?: { maxLength?: number };
    beforeTodoId?: { maxLength?: number };
    afterTodoId?: { maxLength?: number };
    reason?: { maxLength?: number };
    summary?: { maxLength?: number };
  } };
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<{
    content: Array<{ text: string }>;
    details: {
      todo?: { id: string; status: string; parentTodoId?: string };
      deletedCount?: number;
      state?: { todos: Record<string, { status: string; parentTodoId?: string }>; order: string[] };
      error?: { code: string };
    };
    isError?: boolean;
  }>;
};

test("thin surface exposes essential tool, command, and status behavior through the branch core", async () => {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const branch: unknown[] = [];
  const statuses: unknown[] = [];
  const widgets: unknown[] = [];
  const notifications: string[] = [];
  let modalOutput = "";
  const pi = {
    on() {},
    registerTool(tool: RegisteredTool & { name: string }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
  };
  const ctx = {
    cwd: "/tmp/thin-surface",
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus: (_key: string, value: unknown) => statuses.push(value),
      setWidget: (_key: string, value: unknown) => widgets.push(value),
      notify: (message: string) => notifications.push(message),
      custom: async (factory: Function) => {
        const component = factory({ requestRender() {}, terminal: { rows: 40 } }, {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        }, {}, () => {});
        modalOutput = component.render(80).join("\n");
      },
    },
  };
  registerLightweightTodoSurface(pi as never);

  const tool = tools.get("todo");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.action.enum, ["create", "move", "delete", "start", "finish", "block", "unblock", "list"]);
  assert.deepEqual({
    title: tool.parameters.properties.title?.maxLength,
    todoId: tool.parameters.properties.todoId?.maxLength,
    parentTodoId: tool.parameters.properties.parentTodoId?.maxLength,
    beforeTodoId: tool.parameters.properties.beforeTodoId?.maxLength,
    afterTodoId: tool.parameters.properties.afterTodoId?.maxLength,
    reason: tool.parameters.properties.reason?.maxLength,
    summary: tool.parameters.properties.summary?.maxLength,
  }, { title: 256, todoId: 128, parentTodoId: 128, beforeTodoId: 128, afterTodoId: 128, reason: 2_048, summary: 2_048 });
  const execute = (action: string, params: Record<string, unknown> = {}) =>
    tool.execute(action, { action, ...params }, new AbortController().signal, () => {}, ctx);

  const invalid = await execute("create");
  assert.equal(invalid.details.error?.code, "INVALID_REQUEST");
  assert.equal(invalid.isError, true);

  const created = await execute("create", { title: "Thin lifecycle" });
  const todoId = created.details.todo?.id;
  assert.ok(todoId);
  assert.equal((await execute("start", { todoId })).details.todo?.status, "in_progress");
  assert.equal((await execute("block", { reason: "waiting" })).details.todo?.status, "external_blocked");
  assert.equal((await execute("unblock", { todoId })).details.todo?.status, "ready");
  assert.equal((await execute("start", { todoId })).details.todo?.status, "in_progress");
  assert.equal((await execute("finish", { summary: "done" })).details.todo?.status, "completed");
  assert.equal((await execute("list")).details.state?.todos[todoId].status, "completed");
  assert.ok(statuses.some((status) => String(status).includes("Thin lifecycle")));
  const widgetFactory = widgets.filter((value) => typeof value === "function").at(-1) as ((tui: unknown, theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string }) => { render(width: number): string[] });
  assert.equal(typeof widgetFactory, "function");
  const plainTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const widgetOutput = widgetFactory({}, plainTheme).render(100).join("\n");
  assert.match(widgetOutput, /TASKS/);
  assert.match(widgetOutput, /\[✓\] Thin lifecycle/);

  await commands.get("todo")?.handler("list", ctx);
  assert.match(notifications.at(-1) ?? "", /Thin lifecycle.*completed/);
  await commands.get("todo")?.handler("open", ctx);
  assert.match(modalOutput, /TODO DOCKET/);
  assert.match(modalOutput, /Thin lifecycle/);

  const parent = await execute("create", { title: "Parent" });
  const parentId = parent.details.todo?.id;
  assert.ok(parentId);
  const childA = await execute("create", { title: "Child A", parentTodoId: parentId });
  const childB = await execute("create", { title: "Child B", parentTodoId: parentId });
  assert.equal(childA.details.todo?.parentTodoId, parentId);
  await execute("move", { todoId: childB.details.todo?.id, beforeTodoId: childA.details.todo?.id });
  const hierarchical = await execute("list");
  assert.ok(hierarchical.content[0]!.text.indexOf("Child B") < hierarchical.content[0]!.text.indexOf("Child A"));
  assert.match(hierarchical.content[0]!.text, /  Child B \[ready\]/);
  await commands.get("todo")?.handler(`create Manual child --parent ${parentId}`, ctx);
  assert.match(notifications.at(-1) ?? "", /Created Manual child/);
  assert.match((await execute("list")).content[0]!.text, /  Manual child \[ready\]/);

  const childId = childA.details.todo?.id;
  assert.ok(childId);
  assert.equal((await execute("start", { todoId: childId })).details.todo?.status, "in_progress");
  await commands.get("todo")?.handler(`delete ${parentId}`, ctx);
  assert.match(notifications.at(-1) ?? "", /Deleted Parent \(4 todos\)/);
  const afterDelete = await execute("list");
  assert.equal(afterDelete.details.state?.todos[parentId], undefined);
  assert.equal(afterDelete.details.state?.todos[childId], undefined);
});

test("queued abort and backend resolution failure cannot mutate todo state", async () => {
  const tools = new Map<string, RegisteredTool>();
  const branch: unknown[] = [];
  let releaseFirst!: () => void;
  let resolutions = 0;
  const firstResolution = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool & { name: string }) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
  };
  const ctx = {
    cwd: "/tmp/queued-abort",
    hasUI: false,
    mode: "json",
    sessionManager: { getBranch: () => branch },
    ui: {},
  };
  registerLightweightTodoSurface(pi as never, {
    resolveWorkflowBackend: async () => { if (++resolutions === 1) await firstResolution; return undefined; },
  });
  const tool = tools.get("todo")!;
  const first = tool.execute("first", { action: "create", title: "first" }, new AbortController().signal, () => {}, ctx);
  const controller = new AbortController();
  const second = tool.execute("second", { action: "create", title: "second" }, controller.signal, () => {}, ctx);
  controller.abort(new Error("cancel queued call"));
  releaseFirst();
  assert.equal((await first).isError, undefined);
  await assert.rejects(second, /cancel queued call|abort/i);
  assert.equal(branch.length, 1);

  const failedTools = new Map<string, RegisteredTool>();
  registerLightweightTodoSurface({
    ...pi,
    registerTool(tool: RegisteredTool & { name: string }) { failedTools.set(tool.name, tool); },
  } as never, { resolveWorkflowBackend: () => { throw new Error("backend unavailable"); } });
  const failed = await failedTools.get("todo")!.execute(
    "failed",
    { action: "create", title: "must not append" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]!.text, /backend unavailable/i);
  assert.equal(branch.length, 1);
});

test("todo command completions expose the lightweight visual and lifecycle surface", () => {
  const completions = getTodoCommandCompletions("");
  assert.deepEqual(completions.map((item) => item.value), ["open", "list", "create", "move", "delete", "start", "finish", "block", "unblock"]);
  assert.ok(completions.every((item) => item.description.includes(`/todo ${item.value}`)));
  assert.deepEqual(getTodoCommandCompletions("st").map((item) => item.value), ["start"]);
  assert.deepEqual(getTodoCommandCompletions("start "), []);
});
