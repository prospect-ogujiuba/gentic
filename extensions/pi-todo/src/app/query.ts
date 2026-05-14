import { TODO_STATUSES, isFailureStatus, isSuccessStatus, isTerminalStatus } from "../domain/lifecycle.ts";
import { ineligibleReasons, openChildIds, openDependencyIds, readyToClose, type EligibilityOptions } from "../domain/policy.ts";
import type { Todo, TodoState, TodoStatus } from "../domain/types.ts";

export type TodoCounts = { total: number; open: number; terminal: number; byStatus: Record<TodoStatus, number> };

export function orderedTodos(state: TodoState, includeDone = true): Todo[] {
  return state.order.map((id) => state.todos[id]).filter((todo): todo is Todo => Boolean(todo) && (includeDone || !isTerminalStatus(todo.status)));
}

function isActiveDocketTodo(todo: Todo): boolean {
  return todo.status === "in_progress" || todo.status === "claimed";
}

function collectTodoGroupRows(todo: Todo, state: TodoState, seen: Set<string>): Todo[] {
  if (seen.has(todo.id)) return [];
  seen.add(todo.id);
  const rows = [todo];
  for (const childId of todo.children) {
    const child = state.todos[childId];
    if (child) rows.push(...collectTodoGroupRows(child, state, seen));
  }
  return rows;
}

export function orderedDocketTodos(state: TodoState, includeDone = true): Todo[] {
  const ordered = orderedTodos(state, true);
  const groupedIds = new Set<string>();
  const groups: { rows: Todo[]; active: boolean; index: number }[] = [];

  for (const todo of ordered) {
    if (todo.parentId && state.todos[todo.parentId]) continue;
    const groupSeen = new Set<string>();
    const groupRows = collectTodoGroupRows(todo, state, groupSeen);
    for (const row of groupRows) groupedIds.add(row.id);
    const rows = groupRows.filter((row) => includeDone || !isTerminalStatus(row.status));
    if (rows.length > 0) groups.push({ rows, active: groupRows.some(isActiveDocketTodo), index: groups.length });
  }

  for (const todo of ordered) {
    if (groupedIds.has(todo.id)) continue;
    const groupSeen = new Set<string>();
    const groupRows = collectTodoGroupRows(todo, state, groupSeen);
    for (const row of groupRows) groupedIds.add(row.id);
    const rows = groupRows.filter((row) => includeDone || !isTerminalStatus(row.status));
    if (rows.length > 0) groups.push({ rows, active: groupRows.some(isActiveDocketTodo), index: groups.length });
  }

  return groups
    .sort((left, right) => Number(right.active) - Number(left.active) || left.index - right.index)
    .flatMap((group) => group.rows);
}

export function summarizeTodos(state: TodoState): TodoCounts {
  const byStatus = Object.fromEntries(TODO_STATUSES.map((status) => [status, 0])) as Record<TodoStatus, number>;
  for (const todo of Object.values(state.todos)) byStatus[todo.status] = (byStatus[todo.status] ?? 0) + 1;
  const terminal = Object.values(state.todos).filter((todo) => isTerminalStatus(todo.status)).length;
  return { total: Object.keys(state.todos).length, open: Object.keys(state.todos).length - terminal, terminal, byStatus };
}

export function activeTodo(state: TodoState): Todo | undefined {
  return orderedTodos(state).find((todo) => todo.status === "in_progress");
}

export function nextTodo(state: TodoState, options: EligibilityOptions = {}): Todo | undefined {
  return activeTodo(state) || orderedTodos(state, false).find((todo) => ineligibleReasons(todo, state, options).length === 0);
}

export function todoSessionTitle(state: TodoState): string | undefined {
  const active = activeTodo(state);
  if (active) return active.title;
  const latestClosed = orderedTodos(state, true).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).find((todo) => isSuccessStatus(todo.status) || isFailureStatus(todo.status));
  return latestClosed?.title || nextTodo(state)?.title || orderedTodos(state, false)[0]?.title;
}

export { ineligibleReasons, openChildIds, openDependencyIds, readyToClose };
