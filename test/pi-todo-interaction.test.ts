import assert from "node:assert/strict";
import test from "node:test";

import piTodo from "../extensions/pi-todo/index.ts";
import { checkTodoDocketAtAgentEnd, checkTodoDocketAtMessageStart, checkTodoDocketBeforeFinalMessage, executeTodoAction, todoState, todoStatusText, updateTodoWidget } from "../extensions/pi-todo/src/pi/actions.ts";
import { openTodoModal } from "../extensions/pi-todo/src/ui/modal.ts";
import { plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";

function harness(mode: "tui" | "rpc" | "json" | "print") {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const uiCalls: Array<{ method: string; value?: unknown }> = [];
  const notifications: string[] = [];
  const sentMessages: unknown[] = [];
  let sessionName = "";
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool() {},
    registerCommand() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message: unknown, options?: unknown) { sentMessages.push({ message, options }); },
    getSessionName() { return sessionName; },
    setSessionName(value: string) { sessionName = value; },
  };
  const ctx = {
    sessionId: `session-${mode}`,
    cwd: `/tmp/gentic-todo-${mode}`,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: { getBranch: () => entries, getSessionId: () => `session-${mode}` },
    ui: {
      setStatus(_key: string, value: unknown) { uiCalls.push({ method: "setStatus", value }); },
      setWidget(_key: string, value: unknown) { uiCalls.push({ method: "setWidget", value }); },
      setTitle(value: string) { uiCalls.push({ method: "setTitle", value }); },
      notify(message: string) { notifications.push(message); },
      custom() { uiCalls.push({ method: "custom" }); },
    },
  };
  return { pi, ctx, handlers, entries, uiCalls, notifications, sentMessages, getSessionName: () => sessionName };
}

async function emit(h: ReturnType<typeof harness>, event: string, payload: Record<string, unknown> = {}): Promise<void> {
  for (const handler of h.handlers.get(event) ?? []) await handler({ type: event, ...payload }, h.ctx);
}

function lastCall(h: ReturnType<typeof harness>, method: string) {
  return h.uiCalls.filter((call) => call.method === method).at(-1);
}

test("todo status shows semantic titles without internal ids", async () => {
  const readyHarness = harness("tui");
  const ready = await executeTodoAction(readyHarness.pi as never, readyHarness.ctx as never, { action: "create", title: "Implement exact reminder" });
  assert.equal(todoStatusText(await todoState(readyHarness.pi as never, readyHarness.ctx as never)), "todo next Implement exact reminder · start");

  await executeTodoAction(readyHarness.pi as never, readyHarness.ctx as never, { action: "start", todoId: ready.details.todo.id, reason: "atomic" });
  assert.equal(todoStatusText(await todoState(readyHarness.pi as never, readyHarness.ctx as never)), "todo active Implement exact reminder · finish/block");

  const blockedHarness = harness("tui");
  const blocked = await executeTodoAction(blockedHarness.pi as never, blockedHarness.ctx as never, { action: "create", title: "Wait for external approval" });
  await executeTodoAction(blockedHarness.pi as never, blockedHarness.ctx as never, { action: "block", todoId: blocked.details.todo.id, reason: "external approval" });
  assert.equal(todoStatusText(await todoState(blockedHarness.pi as never, blockedHarness.ctx as never)), "todo blocked Wait for external approval · unblock/cancel");

  const completedHarness = harness("tui");
  const completed = await executeTodoAction(completedHarness.pi as never, completedHarness.ctx as never, { action: "create", title: "Finish interaction policy" });
  await executeTodoAction(completedHarness.pi as never, completedHarness.ctx as never, { action: "complete", todoId: completed.details.todo.id, evidence: [{ type: "manual_note", note: "done" }] });
  assert.equal(todoStatusText(await todoState(completedHarness.pi as never, completedHarness.ctx as never)), "todo completed Finish interaction policy · verify");
});

test("todo graph text uses titles while structured details retain operational ids", async () => {
  const h = harness("tui");
  const first = await executeTodoAction(h.pi as never, h.ctx as never, { action: "create", title: "Prepare report" });
  await executeTodoAction(h.pi as never, h.ctx as never, { action: "create", title: "Publish report", dependsOn: [first.details.todo.id] });

  const result = await executeTodoAction(h.pi as never, h.ctx as never, { action: "graph" });
  const text = result.content.map((item: { text: string }) => item.text).join("\n");
  assert.match(text, /Prepare report/);
  assert.match(text, /Publish report/);
  assert.doesNotMatch(text, /todo_[a-z0-9_]+/i);
  assert.equal(result.details.graph.nodes.every((node: { id: string }) => node.id.startsWith("todo_")), true);
});

test("todo display policy uses TUI factories, RPC string widgets, and no UI in JSON or print", async () => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    const h = harness(mode);
    await updateTodoWidget(h.pi as never, h.ctx as never);
    if (mode === "json" || mode === "print") {
      assert.deepEqual(h.uiCalls, [], mode);
    } else {
      assert.equal(lastCall(h, "setStatus")?.value, undefined, mode);
      assert.equal(lastCall(h, "setWidget")?.value, undefined, mode);
    }

    await executeTodoAction(h.pi as never, h.ctx as never, { action: "create", title: `${mode} actionable task` });
    if (mode === "tui") {
      const widgetFactory = lastCall(h, "setWidget")?.value as ((tui: object, theme: typeof plainTodoTheme) => { render: (width: number) => string[] });
      assert.equal(typeof widgetFactory, "function");
      assert.doesNotMatch(widgetFactory({}, plainTodoTheme).render(100).join("\n"), /todo_[a-z0-9_]+/i);
    } else if (mode === "rpc") {
      const widget = lastCall(h, "setWidget")?.value as string[];
      assert.equal(Array.isArray(widget), true);
      assert.doesNotMatch(widget.join("\n"), /todo_[a-z0-9_]+/i);
    } else assert.deepEqual(h.uiCalls, []);
    if (mode === "tui" || mode === "rpc") {
      assert.doesNotMatch(String(lastCall(h, "setStatus")?.value), /todo_[a-z0-9_]+/i);
      assert.doesNotMatch(String(lastCall(h, "setTitle")?.value), /todo_[a-z0-9_]+/i);
      assert.doesNotMatch(h.getSessionName(), /todo_[a-z0-9_]+/i);
    }
    assert.equal(h.uiCalls.some((call) => call.method === "custom"), false);
  }
});

test("todo modal is never constructed outside TUI mode", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const h = harness(mode);
    await openTodoModal(h.pi as never, h.ctx as never);
    assert.equal(h.uiCalls.some((call) => call.method === "custom"), false);
  }
});

test("display-only reminders never mutate todo state or enqueue duplicate turns across reload and settled replay", async () => {
  const h = harness("tui");
  piTodo(h.pi as never);
  await emit(h, "session_start", { reason: "startup" });
  const created = await executeTodoAction(h.pi as never, h.ctx as never, { action: "create", title: "Close active reminder task" });
  await executeTodoAction(h.pi as never, h.ctx as never, { action: "start", todoId: created.details.todo.id, reason: "atomic" });
  const eventCount = h.entries.length;

  await checkTodoDocketBeforeFinalMessage(h.pi as never, h.ctx as never);
  await checkTodoDocketAtMessageStart(h.pi as never, h.ctx as never, { message: { role: "assistant" } });
  await checkTodoDocketAtAgentEnd(h.pi as never, h.ctx as never);
  await checkTodoDocketAtAgentEnd(h.pi as never, h.ctx as never);
  assert.equal(h.notifications.length, 1);
  assert.doesNotMatch(h.notifications[0], /todo_[a-z0-9_]+/i);
  assert.match(h.notifications[0], /pi-todo: \[in_progress\] Close active reminder task/);
  assert.match(h.notifications[0], /next_call: todo\(\{"action":"list"\}\)/);
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.entries.length, eventCount);

  await emit(h, "session_shutdown", { reason: "reload" });
  await emit(h, "session_start", { reason: "reload" });
  await emit(h, "agent_settled");
  assert.equal(h.notifications.length, 1);
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.entries.length, eventCount);
  await emit(h, "session_shutdown", { reason: "quit" });
});
