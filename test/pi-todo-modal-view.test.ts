import test from "node:test";
import assert from "node:assert/strict";
import { reduceTodoState } from "../extensions/pi-todo/src/domain/reducer.ts";
import { renderTodoDocketLines } from "../extensions/pi-todo/src/ui/docket.ts";
import { createLiveTodoModalComponent } from "../extensions/pi-todo/src/ui/modal.ts";
import { plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

const baseTodo = (id: string, title: string, status: "pending" | "done", at: string) => ({ id, title, status, description: undefined, priority: "normal" as const, createdAt: at, updatedAt: at, dependsOn: [], children: [], blocks: [], blockers: [], tags: [], acceptanceCriteria: [], definitionOfDone: [], requiredCapabilities: [], constraints: [], scope: { paths: [], files: [], tools: [], commands: [], policyTags: [] }, inputs: { constraints: [] }, evidence: [], notes: [], revision: 0 });

test("todo docket can include closed tasks for modal all view", () => {
  const at = "2026-05-11T00:00:00.000Z";
  const state = reduceTodoState([
    { id: "e1", type: "todo.created", at, todo: baseTodo("todo_1", "Open task", "pending", at) },
    { id: "e2", type: "todo.created", at, todo: baseTodo("todo_2", "Closed task", "done", at) },
  ] satisfies TodoEvent[]);

  assert.doesNotMatch(renderTodoDocketLines(state, plainTodoTheme, { width: 100 }).join("\n"), /Closed task/);
  assert.match(renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true }).join("\n"), /Closed task/);
});

test("todo live modal refreshes from the ledger while open", async () => {
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
