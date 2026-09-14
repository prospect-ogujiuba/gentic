import test from "node:test";
import assert from "node:assert/strict";

import { registerLightweightTodoSurface } from "../extensions/pi-todo/src/thin-surface.ts";

type RegisteredTool = {
  parameters: { properties: { action: { enum?: string[] } } };
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<{
    content: Array<{ text: string }>;
    details: { todo?: { id: string; status: string }; state?: { todos: Record<string, { status: string }> }; error?: { code: string } };
  }>;
};

type ToolCallHandler = (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

test("thin surface exposes essential tool, command, and status behavior through the branch core", async () => {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Function>();
  const branch: unknown[] = [];
  const statuses: unknown[] = [];
  const widgets: unknown[] = [];
  const notifications: string[] = [];
  let modalOutput = "";
  let sweActive = false;
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
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
  registerLightweightTodoSurface(pi as never, { hasActiveSweTask: () => sweActive });

  const tool = tools.get("todo");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.action.enum, ["create", "start", "finish", "block", "unblock", "list"]);
  const execute = (action: string, params: Record<string, unknown> = {}) =>
    tool.execute(action, { action, ...params }, new AbortController().signal, () => {}, ctx);

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

  sweActive = true;
  const hook = handlers.get("tool_call") as ToolCallHandler;
  const blocked = await hook({ toolName: "todo", input: { action: "create" } }, ctx) as { block?: boolean; reason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /pi-swe lifecycle ownership/);
  assert.equal(await hook({ toolName: "todo", input: { action: "list" } }, ctx), undefined);
});
