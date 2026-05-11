import test from "node:test";
import assert from "node:assert/strict";
import { reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
import { renderTodoDocketLines } from "../extensions/pi-todo/src/ui/docket.ts";
import { plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

test("todo docket can include closed tasks for modal all view", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const base = { description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], tags: [], acceptanceCriteria: [], evidence: [], notes: [], revision: 0 };
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: { ...base, id: "todo_1", title: "Open task", status: "pending" } },
    { id: "e2", type: "todo.created", at, todo: { ...base, id: "todo_2", title: "Closed task", status: "done" } },
  ] satisfies TodoEvent[]);

  assert.doesNotMatch(renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n"), /Closed task/);
  assert.match(renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true }).join("\n"), /Closed task/);
});
