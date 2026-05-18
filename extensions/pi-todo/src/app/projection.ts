import { TODO_STATUSES, isTerminalStatus } from "../domain/lifecycle.ts";
import type { Todo, TodoState, TodoStatus } from "../domain/types.ts";

export type TodoCounts = {
  total: number;
  open: number;
  terminal: number;
  active: number;
  blockedExternal: number;
  completedHistory: number;
  byStatus: Record<TodoStatus, number>;
};
export type TodoProjectionWarning = { todoId: string; kind: "open_dependencies" | "ready_to_close"; count?: number };
export type TodoTuiProjection = { todos: Todo[]; counts: TodoCounts; warnings: TodoProjectionWarning[] };

export function summarizeTodos(state: TodoState): TodoCounts {
  const byStatus = Object.fromEntries(TODO_STATUSES.map((status) => [status, 0])) as Record<TodoStatus, number>;
  for (const todo of Object.values(state.todos)) byStatus[todo.status] = (byStatus[todo.status] ?? 0) + 1;
  const todos = Object.values(state.todos);
  const terminal = todos.filter((todo) => isTerminalStatus(todo.status)).length;
  const blockedExternal = byStatus.external_blocked;
  const active = byStatus.claimed + byStatus.in_progress;
  const completedHistory = byStatus.completed + byStatus.verified + byStatus.cancelled + byStatus.failed + byStatus.superseded;
  return { total: todos.length, open: todos.length - terminal - blockedExternal, terminal, active, blockedExternal, completedHistory, byStatus };
}

export function todoTuiProjection(state: TodoState, todos: Todo[]): TodoTuiProjection {
  const warnings: TodoProjectionWarning[] = [];
  for (const todo of todos) {
    const openDependencies = todo.dependsOn.filter((id) => !state.todos[id] || !isTerminalStatus(state.todos[id].status));
    if (openDependencies.length > 0) warnings.push({ todoId: todo.id, kind: "open_dependencies", count: openDependencies.length });
    if ((todo.children ?? []).length > 0 && todo.children.every((childId) => state.todos[childId] && isTerminalStatus(state.todos[childId].status)) && !isTerminalStatus(todo.status)) {
      warnings.push({ todoId: todo.id, kind: "ready_to_close" });
    }
  }
  return { todos, counts: summarizeTodos(state), warnings };
}
