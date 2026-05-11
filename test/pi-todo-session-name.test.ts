import test from "node:test";
import assert from "node:assert/strict";
import { reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
import { todoSessionTitle } from "../extensions/pi-todo/src/app/query.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

function todo(id: string, title: string, status: "pending" | "in_progress" | "done", updatedAt: string) {
  return { id, title, status, priority: "normal" as const, createdAt: updatedAt, updatedAt, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
}

test("todo session title prefers active work", () => {
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at: "2026-05-11T00:00:00.000Z", todo: todo("todo_1", "Finished thing", "done", "2026-05-11T02:00:00.000Z") },
    { id: "e2", type: "todo.created", at: "2026-05-11T00:00:00.000Z", todo: todo("todo_2", "Current thing", "in_progress", "2026-05-11T01:00:00.000Z") },
  ] satisfies TodoEvent[]);

  assert.equal(todoSessionTitle(state), "Current thing");
});

test("todo session title falls back to latest completed work", () => {
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at: "2026-05-11T00:00:00.000Z", todo: todo("todo_1", "Older done", "done", "2026-05-11T01:00:00.000Z") },
    { id: "e2", type: "todo.created", at: "2026-05-11T00:00:00.000Z", todo: todo("todo_2", "Latest done", "done", "2026-05-11T02:00:00.000Z") },
    { id: "e3", type: "todo.created", at: "2026-05-11T00:00:00.000Z", todo: todo("todo_3", "Pending next", "pending", "2026-05-11T03:00:00.000Z") },
  ] satisfies TodoEvent[]);

  assert.equal(todoSessionTitle(state), "Latest done");
});
