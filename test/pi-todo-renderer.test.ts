import test from "node:test";
import assert from "node:assert/strict";
import { emptyTodoState, reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
import { nextTodo, orderedDocketTodos } from "../extensions/pi-todo/src/app/query.ts";
import { formatTodoTitleForTui, renderTodoDocketLines, renderTodoProgress } from "../extensions/pi-todo/src/ui/docket.ts";
import { ansiTodoTheme, plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

test("todo docket stays hidden when there are no tasks", () => {
  const state = emptyTodoState();
  const lines = renderTodoDocketLines(state, plainTodoTheme, { width: 100 });

  assert.equal(renderTodoProgress(state, plainTodoTheme), "");
  assert.deepEqual(lines, []);
  assert.doesNotMatch(lines.join("\n"), /No tasks recorded yet|TASKS|0\/0/);
});

test("todo docket keeps legacy progress bar vocabulary", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Ready task", status: "pending" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Active task", status: "in_progress" } },
    { id: "e3", type: "todo.created", at, todo: { ...base, id: "todo_3", title: "Done task", status: "done" } },
  ] satisfies TodoEvent[]);

  assert.match(renderTodoProgress(state, plainTodoTheme), /\[□▶■\] 1\/3 33% S\/F 1\/0/);
  const lines = renderTodoDocketLines(state, plainTodoTheme, { width: 100 });
  assert.match(lines.join("\n"), /TASKS/);
  assert.match(lines.join("\n"), /\[~\] Active task/);
});

test("todo docket promotes an active child group and makes active work the top child", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_old", title: "Older parent", status: "ready" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_parent", title: "Second parent", status: "ready" } },
    { id: "e3", type: "todo.created", at, todo: { ...base, id: "todo_child_1", parentId: "todo_parent", title: "First split child", status: "ready" } },
    { id: "e4", type: "todo.created", at, todo: { ...base, id: "todo_child_2", parentId: "todo_parent", title: "Second split child active", status: "in_progress" } },
  ] satisfies TodoEvent[]);

  const rows = orderedDocketTodos(state, false).map((todo) => todo.id);
  assert.deepEqual(rows.slice(0, 3), ["todo_parent", "todo_child_2", "todo_child_1"]);
  assert.deepEqual(state.order, ["todo_old", "todo_parent", "todo_child_1", "todo_child_2"]);
  assert.deepEqual(state.todos.todo_parent.children, ["todo_child_1", "todo_child_2"]);
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, limit: 2 }).join("\n");
  assert.match(output, /Second parent/);
  assert.match(output, /Second split child active/);
  assert.doesNotMatch(output, /First split child/);
  assert.doesNotMatch(output, /Older parent/);
});

test("todo docket keeps sibling presentation order from parent children", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_parent", title: "Parent", status: "ready", children: ["todo_second", "todo_first"] } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_first", parentId: "todo_parent", title: "Created first", status: "ready" } },
    { id: "e3", type: "todo.created", at, todo: { ...base, id: "todo_second", parentId: "todo_parent", title: "Listed first", status: "ready" } },
  ] satisfies TodoEvent[]);

  assert.deepEqual(orderedDocketTodos(state, false).map((todo) => todo.id), ["todo_parent", "todo_second", "todo_first"]);
});

test("todo docket promotes flat active work without changing next scheduling", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_old", title: "Older ready", status: "ready" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_claimed", title: "Claimed current work", status: "claimed" } },
  ] satisfies TodoEvent[]);

  assert.deepEqual(orderedDocketTodos(state, false).map((todo) => todo.id), ["todo_claimed", "todo_old"]);
  assert.equal(nextTodo(state)?.id, "todo_old");
});

test("todo docket concises repeated scenario titles and shows dependencies", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Complex todo edge-case scenario: parent architecture effort", status: "pending", dependsOn: [] } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Complex todo edge-case scenario: implement renderer integration", status: "pending", dependsOn: ["todo_1"] } },
  ] satisfies TodoEvent[]);

  assert.equal(formatTodoTitleForTui("Complex todo edge-case scenario: implement renderer integration"), "implement renderer integration");
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /parent architecture effort/);
  assert.match(output, /↳ \[ \] implement renderer integration/);
  assert.match(output, /⧗ waits 1/);
});

test("todo compact docket omits noisy row metadata", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { description: undefined, priority: "high" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 2, id: "todo_1", title: "Declutter me", status: "completed" } },
  ] satisfies TodoEvent[]);
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true }).join("\n");

  assert.match(output, /\[✓\] Declutter me/);
  assert.match(output, /!/);
  assert.doesNotMatch(output, /completed \| high \| v2 \| 05-11/);
  assert.doesNotMatch(output, /v2/);
  assert.doesNotMatch(output, /05-11/);
});

test("todo summary docket keeps detailed row metadata for observability commands", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { description: undefined, priority: "high" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 2, id: "todo_1", title: "Summarize me", status: "completed" } },
  ] satisfies TodoEvent[]);
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true, detail: "summary" }).join("\n");

  assert.match(output, /completed \| high \| v2 \| 05-11/);
  assert.match(output, /\[✓\] Summarize me completed \| high/);
});

test("todo docket keeps redesigned layout with colored status stats", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Done task", status: "done" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Cancelled task", status: "cancelled" } },
  ] satisfies TodoEvent[]);
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");
  const narrowOutput = renderTodoDocketLines(state, plainTodoTheme, { width: 60 }).join("\n");

  assert.match(output, /TASKS - Total 2 · \/todo\s+Done 1\s+\|\s+History 2/);
  assert.match(output, /\[■!\] 1\/2 50% S\/F 1\/1/);
  assert.match(narrowOutput, /TASKS - Total 2 · \/todo\s+Done 1\s+\|\s+History 2/);
  assert.match(narrowOutput, /\[■!\] 1\/2 50% S\/F 1\/1/);
  assert.doesNotMatch(output, /Open 0/);
  assert.match(output, /Done 1/);
  assert.match(output, /History 2/);
  assert.doesNotMatch(output, /Total 2 · open 0/);
});

test("todo docket keeps latest closed work in focus chip when all tasks are closed", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Older done", status: "done", updatedAt: "2026-05-11T01:00:00.000Z" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Latest done", status: "done", updatedAt: "2026-05-11T02:00:00.000Z" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /Latest done/);
  assert.doesNotMatch(output, /\* Latest done/);
});

test("todo docket can hide closed-work focus chip for legacy all-closed behavior", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Done task", status: "done" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, showCompletedFocus: false }).join("\n");
  assert.doesNotMatch(output, /Done task/);
});

test("todo docket keeps progress visible when summary is too wide", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const events: TodoEvent[] = Array.from({ length: 10 }, (_, index) => ({
    id: `e${index}`,
    type: "todo.created",
    at,
    todo: { ...base, id: `todo_${index}`, title: `Very long task ${index}`, status: index < 8 ? "done" : index === 8 ? "in_progress" : "blocked" },
  }));
  const state = reduceTodoState(events);
  const lines = renderTodoDocketLines(state, plainTodoTheme, { width: 48 });

  assert.match(lines[0] ?? "", /TASKS/);
  const output = lines.join("\n");
  assert.match(output, /Open 1/);
  assert.match(output, /Active 1/);
  assert.match(output, /Blocked external 1/);
  assert.match(output, /\[■■■■■■■■▶⧗\] 8\/10 80% S\/F 8\/0/);
  assert.doesNotMatch(lines.join("\n"), /Cancelled 0/);
});

test("todo docket shows external blockers separately from actionable open work", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_ready", title: "Ready task", status: "ready" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_blocked", title: "External blocker", status: "external_blocked" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");

  assert.match(output, /Open 1/);
  assert.match(output, /Blocked external 1/);
  assert.match(output, /\[⧗\] External blocker/);
});

test("todo docket omits zero-count status stats", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Ready task", status: "ready" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, ansiTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /Open 1/);
  assert.match(output, /\x1b\[48;2;32;45;37m.* Open 1 /);
  assert.doesNotMatch(output, /Active 0|Done 0|History 0|Blocked external 0/);
});

test("todo docket emits legacy ANSI colors", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Active task", status: "in_progress" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Done task", status: "done" } },
    { id: "e3", type: "todo.created", at, todo: { ...base, id: "todo_3", title: "Cancelled task", status: "cancelled" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, ansiTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /\x1b\[48;5;108m\x1b\[30m Active task /);
  assert.match(output, /\x1b\[38;2;189;180;124m▶\x1b\[0m/);
  assert.match(output, /\x1b\[38;2;111;125;115m■\x1b\[0m/);
  assert.match(output, /\x1b\[48;2;32;45;37m\x1b\[38;2;201;133;120m History 2 /);
  assert.doesNotMatch(output, /\x1b\[38;2;143;191;154m History/);
});
