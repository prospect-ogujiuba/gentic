import type { TodoPublicItem } from "../contract.ts";
import { NO_TODO_CAPABILITIES, type TodoCapabilities, type TodoView } from "../provider.ts";
import type { TodoCoreState } from "../state-core.ts";
import {
  renderSharedDocketLines,
  visibleTodoViewItems,
  type SharedDocketRenderOptions,
} from "./shared-docket.ts";
import type { TodoTheme } from "./theme.ts";

export type TodoDocketRenderOptions = {
  width?: number;
  includeDone?: boolean;
  limit?: number;
  selectedTodoId?: string;
  expandedTodoIds?: ReadonlySet<string>;
};
export type TodoTreeRow = { todo: TodoPublicItem; depth: number };

export function projectStandaloneTodoView(state: TodoCoreState): TodoView {
  const rows = orderedTodoRows(state, true);
  return {
    provider: "standalone",
    scope: "session",
    authorityId: "current-session",
    items: rows.map(({ todo, depth }) => {
      const capabilities: TodoCapabilities = {
        ...NO_TODO_CAPABILITIES,
        create: true,
        move: true,
        delete: true,
        start: todo.status === "ready" && !state.activeTodoId,
        finish: todo.status === "in_progress",
        block: todo.status === "ready" || todo.status === "in_progress",
        unblock: todo.status === "external_blocked",
      };
      return {
        id: todo.id,
        scope: "session",
        authorityId: "current-session",
        title: todo.title,
        status: todo.status === "in_progress" ? "active" : todo.status === "external_blocked" ? "blocked" : todo.status === "completed" ? "complete" : "ready",
        rawStatus: todo.status,
        parentId: todo.parentTodoId,
        depth,
        blockedReason: todo.blockedReason,
        ready: todo.status === "ready",
        executable: true,
        capabilities,
      };
    }),
  };
}

export function orderedTodoRows(state: TodoCoreState, includeDone = false): TodoTreeRow[] {
  const ids = state.order.filter((id) => Boolean(state.todos[id]));
  const children = new Map<string | undefined, string[]>();
  for (const id of ids) {
    const todo = state.todos[id]!;
    const parentId = todo.parentTodoId && todo.parentTodoId !== id && state.todos[todo.parentTodoId] ? todo.parentTodoId : undefined;
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }
  const rows: TodoTreeRow[] = []; const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return; const todo = state.todos[id]; if (!todo) return;
    seen.add(id); rows.push({ todo, depth }); for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const id of children.get(undefined) ?? []) visit(id, 0);
  for (const id of ids) visit(id, 0);
  if (includeDone) return rows;
  const visibleIds = new Set(visibleTodoViewItems(projectStandaloneTodoViewFromRows(rows), false).map((item) => item.id));
  return rows.filter(({ todo }) => visibleIds.has(todo.id));
}

export function orderedTodoItems(state: TodoCoreState, includeDone = false): TodoPublicItem[] {
  return orderedTodoRows(state, includeDone).map(({ todo }) => todo);
}

export function renderTodoProgress(state: TodoCoreState, theme: TodoTheme): string {
  const todos = state.order.map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
  if (!todos.length) return "";
  const done = todos.filter((todo) => todo.status === "completed").length;
  const blocks = todos.map((todo) => todo.status === "completed" ? theme.fg("success", "■")
    : todo.status === "in_progress" ? theme.fg("syntaxString", "▶")
    : todo.status === "external_blocked" ? theme.fg("warning", "⧗") : theme.fg("dim", "□")).join("");
  return `${theme.fg("dim", "[")}${blocks}${theme.fg("dim", "]")} ${done}/${todos.length} ${Math.round((done / todos.length) * 100)}%`;
}

export function renderTodoDocketLines(state: TodoCoreState, theme: TodoTheme, options: TodoDocketRenderOptions = {}): string[] {
  return renderSharedDocketLines(projectStandaloneTodoView(state), theme, sharedOptions(options));
}

export function createTodoDocketComponent(state: TodoCoreState, theme: TodoTheme) {
  const view = projectStandaloneTodoView(state);
  return { render: (width: number) => renderSharedDocketLines(view, theme, { width, includeDone: true, limit: 8 }), invalidate: () => undefined };
}

function sharedOptions(options: TodoDocketRenderOptions): SharedDocketRenderOptions {
  return {
    width: options.width,
    includeDone: options.includeDone,
    limit: options.limit,
    selectedId: options.selectedTodoId,
    expandedIds: options.expandedTodoIds,
  };
}

function projectStandaloneTodoViewFromRows(rows: TodoTreeRow[]): TodoView {
  return {
    provider: "standalone",
    scope: "session",
    authorityId: "current-session",
    items: rows.map(({ todo, depth }) => ({
      id: todo.id, scope: "session", authorityId: "current-session", title: todo.title, depth, parentId: todo.parentTodoId, rawStatus: todo.status,
      status: todo.status === "in_progress" ? "active" : todo.status === "external_blocked" ? "blocked" : todo.status === "completed" ? "complete" : "ready",
      blockedReason: todo.blockedReason, ready: todo.status === "ready", executable: true, capabilities: NO_TODO_CAPABILITIES,
    })),
  };
}
