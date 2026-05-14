import test from "node:test";
import assert from "node:assert/strict";
import { reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
import { renderTodoDocketLines } from "../extensions/pi-todo/src/ui/docket.ts";
import { getTodoCommandCompletions } from "../extensions/pi-todo/src/pi/actions.ts";
import { createLiveTodoModalComponent } from "../extensions/pi-todo/src/ui/modal.ts";
import { plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

const baseTodo = (id: string, title: string, status: "pending" | "ready" | "done", at: string) => ({ id, title, status, description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], children: [], blocks: [], blockers: [], tags: [], acceptanceCriteria: [], definitionOfDone: [], requiredCapabilities: [], constraints: [], scope: { paths: [], files: [], tools: [], commands: [], policyTags: [] }, inputs: { constraints: [] }, evidence: [], notes: [], revision: 0 });

test("todo docket can include closed tasks for modal all view", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: baseTodo("todo_1", "Open task", "pending", at) },
    { id: "e2", type: "todo.created", at, todo: baseTodo("todo_2", "Closed task", "done", at) },
  ] satisfies TodoEvent[]);

  assert.doesNotMatch(renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n"), /Closed task/);
  assert.match(renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true }).join("\n"), /Closed task/);
});

test("todo command completions do not expose a nested mode command", () => {
  assert.deepEqual(getTodoCommandCompletions("inter"), []);
});

test("todo expanded detail wraps under its detail rail", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...baseTodo("todo_1", "Wrapped task", "ready", at), description: "Alpha bravo charlie delta echo foxtrot continuation-token" } },
  ] satisfies TodoEvent[]);
  const lines = renderTodoDocketLines(state, plainTodoTheme, { width: 42, includeDone: true, selectedTodoId: "todo_1", expandedTodoIds: new Set(["todo_1"]) });
  const continuation = lines.find((line) => line.includes("continuation-token"));

  assert.match(continuation ?? "", /^\s*│ /);
  assert.doesNotMatch(continuation ?? "", /^continuation-token/);
});

test("todo modal opens all-task navigable view by default", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: baseTodo("todo_1", "Open task", "pending", at) },
    { id: "e2", type: "todo.created", at, todo: baseTodo("todo_2", "Closed task", "done", at) },
  ] satisfies TodoEvent[]);
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state, requestRender: () => {}, closeModal: () => {}, getRows: () => 40, refreshState: async () => state, pollMs: 60 });

  const output = component.render(100).join("\n");
  assert.match(output, /all tasks/);
  assert.match(output, /› \[ \] Open task/);
  assert.match(output, /Closed task/);
  component.dispose();
});

test("todo modal supports navigation and expansion by default", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...baseTodo("todo_1", "First task", "ready", at), description: "First detail", acceptanceCriteria: ["show detail"] } },
    { id: "e2", type: "todo.created", at, todo: { ...baseTodo("todo_2", "Second task", "ready", at), description: "Second detail", acceptanceCriteria: ["navigate here"] } },
  ] satisfies TodoEvent[]);
  let renderCount = 0;
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state, requestRender: () => { renderCount += 1; }, closeModal: () => {}, getRows: () => 40, refreshState: async () => state, pollMs: 60 });

  const initial = component.render(100).join("\n");
  assert.match(initial, /all tasks/);
  assert.doesNotMatch(initial, /i live|i interactive/);
  assert.match(initial, /› \[ \] First task/);
  assert.doesNotMatch(initial, /First task ready \| normal/);
  component.handleInput("j");
  const selectedSecond = component.render(100).join("\n");
  assert.match(selectedSecond, /› \[ \] Second task/);
  assert.doesNotMatch(selectedSecond, /Second task ready \| normal/);
  component.handleInput(" ");
  const expanded = component.render(100).join("\n");
  assert.match(expanded, /Overview/);
  assert.match(expanded, /id: todo_2\s+status: ready v0/);
  assert.match(expanded, /priority: normal\s+updated: 2026-05-11 00:00/);
  assert.match(expanded, /Summary/);
  assert.match(expanded, /description: Second detail/);
  assert.match(expanded, /Acceptance/);
  assert.match(expanded, /• navigate here/);
  assert.doesNotMatch(component.render(100).join("\n"), /i live|i interactive/);
  assert.equal(renderCount, 2);
  component.dispose();
});

test("todo modal toggles expand collapse all", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...baseTodo("todo_1", "First task", "ready", at), description: "First detail" } },
    { id: "e2", type: "todo.created", at, todo: { ...baseTodo("todo_2", "Second task", "ready", at), description: "Second detail" } },
  ] satisfies TodoEvent[]);
  let renderCount = 0;
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state, requestRender: () => { renderCount += 1; }, closeModal: () => {}, getRows: () => 40, refreshState: async () => state, pollMs: 60 });

  assert.match(component.render(100).join("\n"), /x expand\/collapse all/);
  component.handleInput("x");
  const expanded = component.render(100).join("\n");
  assert.match(expanded, /description: First detail/);
  assert.match(expanded, /description: Second detail/);
  component.handleInput("x");
  const collapsed = component.render(100).join("\n");
  assert.doesNotMatch(collapsed, /description: First detail|description: Second detail/);
  assert.equal(renderCount, 2);
  component.dispose();
});

test("todo modal scrolls expanded content within max height", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const events: TodoEvent[] = Array.from({ length: 10 }, (_, index) => ({
    id: `e${index}`,
    type: "todo.created",
    at,
    todo: { ...baseTodo(`todo_${index}`, `Task ${index}`, "ready", at), description: `Detail ${index}`, acceptanceCriteria: [`criterion ${index}`] },
  }));
  const state = reduceTodoState(events);
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state, requestRender: () => {}, closeModal: () => {}, getRows: () => 12, refreshState: async () => state, pollMs: 60 });

  component.handleInput(" ");
  component.handleInput("j");
  component.handleInput(" ");
  for (let index = 0; index < 8; index += 1) component.handleInput("j");
  const lines = component.render(100);
  assert.ok(lines.length <= 10);
  assert.match(lines.join("\n"), /› \[ \] Task 9/);
  component.dispose();
});

test("todo modal height scales with terminal rows", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const events: TodoEvent[] = Array.from({ length: 40 }, (_, index) => ({
    id: `e${index}`,
    type: "todo.created",
    at,
    todo: baseTodo(`todo_${index}`, `Task ${index}`, "ready", at),
  }));
  const state = reduceTodoState(events);
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state, requestRender: () => {}, closeModal: () => {}, getRows: () => 60, refreshState: async () => state, pollMs: 60 });
  const lines = component.render(100);

  assert.ok(lines.length > 28);
  assert.ok(lines.length <= 51);
  component.dispose();
});

test("todo modal refreshes from the ledger while open", async () => {
  const at = "2026-05-11T00:00:00.000Z";
  const first = reduceTodoState([{ id: "e1", type: "todo.created", at, todo: baseTodo("todo_1", "Initial task", "pending", at) }] satisfies TodoEvent[]);
  const second = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: baseTodo("todo_1", "Initial task", "pending", at) },
    { id: "e2", type: "todo.created", at, todo: baseTodo("todo_2", "Live task", "pending", at) },
  ] satisfies TodoEvent[]);
  let renderCount = 0;
  const component = createLiveTodoModalComponent({ theme: plainTodoTheme, state: first, requestRender: () => { renderCount += 1; }, closeModal: () => {}, getRows: () => 40, refreshState: async () => second, pollMs: 60 });
  assert.doesNotMatch(component.render(100).join("\n"), /Live task/);
  await component.refresh();
  assert.match(component.render(100).join("\n"), /Live task/);
  assert.equal(renderCount, 1);
  component.dispose();
});
