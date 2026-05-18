import { isFailureStatus, isSuccessStatus, isTerminalStatus } from "../domain/lifecycle.ts";
import { ineligibleReasons, openChildIds, openDependencyIds, readyToClose, type EligibilityOptions } from "../domain/policy.ts";
import type { Todo, TodoState } from "../domain/types.ts";
export { summarizeTodos, type TodoCounts } from "./projection.ts";

export function orderedTodos(state: TodoState, includeDone = true): Todo[] {
  return state.order.map((id) => state.todos[id]).filter((todo): todo is Todo => Boolean(todo) && (includeDone || !isTerminalStatus(todo.status)));
}

function isActiveDocketTodo(todo: Todo): boolean {
  return todo.status === "in_progress" || todo.status === "claimed";
}

function hasActiveDocketWork(todo: Todo, state: TodoState, seen = new Set<string>()): boolean {
  if (seen.has(todo.id)) return false;
  seen.add(todo.id);
  if (isActiveDocketTodo(todo)) return true;
  return todo.children.some((childId) => {
    const child = state.todos[childId];
    return child ? hasActiveDocketWork(child, state, seen) : false;
  });
}

function orderedDocketChildIds(todo: Todo, state: TodoState): string[] {
  return todo.children
    .filter((childId) => Boolean(state.todos[childId]))
    .map((childId, index) => ({ childId, index, active: hasActiveDocketWork(state.todos[childId], state) }))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.index - right.index)
    .map(({ childId }) => childId);
}

function collectTodoGroupRows(todo: Todo, state: TodoState, seen: Set<string>): Todo[] {
  if (seen.has(todo.id)) return [];
  seen.add(todo.id);
  const rows = [todo];
  for (const childId of orderedDocketChildIds(todo, state)) {
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
