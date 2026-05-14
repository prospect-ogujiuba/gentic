import test from "node:test";
import assert from "node:assert/strict";
import { emptyTodoState, reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
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
});

test("todo docket labels total and open counts accurately when all closed", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Done task", status: "done" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Cancelled task", status: "cancelled" } },
  ] satisfies TodoEvent[]);
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");

  assert.match(output, /Total 2 · open 0/);
  assert.doesNotMatch(output, /Open 0 total/);
  assert.match(output, /\[■!\] 1\/2 50% S\/F 1\/1/);
});

test("todo docket keeps latest closed work in focus chip when all tasks are closed", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Older done", status: "done", updatedAt: "2026-05-11T01:00:00.000Z" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Latest done", status: "done", updatedAt: "2026-05-11T02:00:00.000Z" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /\* Latest done/);
});

test("todo docket can hide closed-work focus chip for legacy all-closed behavior", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Done task", status: "done" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, showCompletedFocus: false }).join("\n");
  assert.doesNotMatch(output, /\* Done task/);
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

  assert.match(lines[1] ?? "", /TASKS/);
  assert.match(lines[2] ?? "", /\[■■■■■■■■▶!\] 8\/10 80% S\/F 8\/0/);
});

test("todo docket emits legacy ANSI colors", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Active task", status: "in_progress" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Done task", status: "done" } },
  ] satisfies TodoEvent[]);

  const output = renderTodoDocketLines(state, ansiTodoTheme, { width: 100 }).join("\n");
  assert.match(output, /\x1b\[48;5;108m\x1b\[30m \* Active task /);
  assert.match(output, /\x1b\[38;2;189;180;124m▶\x1b\[0m/);
  assert.match(output, /\x1b\[38;2;111;125;115m■\x1b\[0m/);
});
