import { TODO_STATUSES, isFailureStatus, isSuccessStatus, isTerminalStatus } from "../domain/lifecycle.ts";
import { ineligibleReasons, openChildIds, openDependencyIds, readyToClose, type EligibilityOptions } from "../domain/policy.ts";
import type { Todo, TodoState, TodoStatus } from "../domain/types.ts";

export type TodoCounts = { total: number; open: number; terminal: number; byStatus: Record<TodoStatus, number> };

export function orderedTodos(state: TodoState, includeDone = true): Todo[] {
  return state.order.map((id) => state.todos[id]).filter((todo): todo is Todo => Boolean(todo) && (includeDone || !isTerminalStatus(todo.status)));
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
