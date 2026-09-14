import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TodoPublicItem, TodoPublicStatus } from "../contract.ts";
import type { TodoCoreState } from "../state-core.ts";
import { leftRight } from "./format.ts";
import type { TodoTheme } from "./theme.ts";

export type TodoDocketRenderOptions = {
  width?: number;
  includeDone?: boolean;
  limit?: number;
  selectedTodoId?: string;
  expandedTodoIds?: ReadonlySet<string>;
};

const statusRank: Record<TodoPublicStatus, number> = {
  in_progress: 0,
  ready: 1,
  external_blocked: 2,
  completed: 3,
};

export function orderedTodoItems(state: TodoCoreState, includeDone = false): TodoPublicItem[] {
  return state.order
    .map((id, index) => ({ todo: state.todos[id], index }))
    .filter((entry): entry is { todo: TodoPublicItem; index: number } => Boolean(entry.todo))
    .filter(({ todo }) => includeDone || todo.status !== "completed")
    .sort((left, right) => statusRank[left.todo.status] - statusRank[right.todo.status] || left.index - right.index)
    .map(({ todo }) => todo);
}

export function renderTodoProgress(state: TodoCoreState, theme: TodoTheme): string {
  const todos = state.order.map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
  if (!todos.length) return "";
  const done = todos.filter((todo) => todo.status === "completed").length;
  const blocks = todos.map((todo) => {
    if (todo.status === "completed") return theme.fg("success", "■");
    if (todo.status === "in_progress") return theme.fg("syntaxString", "▶");
    if (todo.status === "external_blocked") return theme.fg("warning", "⧗");
    return theme.fg("dim", "□");
  }).join("");
  return `${theme.fg("dim", "[")}${blocks}${theme.fg("dim", "]")} ${done}/${todos.length} ${Math.round((done / todos.length) * 100)}%`;
}

export function renderTodoDocketLines(
  state: TodoCoreState,
  theme: TodoTheme,
  options: TodoDocketRenderOptions = {},
): string[] {
  const width = Math.max(20, options.width ?? 80);
  const all = state.order.map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
  if (!all.length) return [];
  const rows = orderedTodoItems(state, options.includeDone).slice(0, options.limit ?? 8);
  const active = all.find((todo) => todo.status === "in_progress");
  const ready = all.filter((todo) => todo.status === "ready").length;
  const blocked = all.filter((todo) => todo.status === "external_blocked").length;
  const done = all.filter((todo) => todo.status === "completed").length;
  const open = all.length - done;
  const title = theme.bold ? theme.bold("TASKS") : "TASKS";
  const heading = `${theme.fg("accent", title)}${theme.fg("dim", " — ")}${theme.fg("accent", `Total ${all.length}`)}${theme.fg("dim", " · /todo open")}`;
  const stats = [
    theme.fg("dim", `Open ${open}`),
    active ? theme.fg("syntaxString", "Active 1") : undefined,
    blocked ? theme.fg("warning", `Blocked ${blocked}`) : undefined,
    done ? theme.fg("success", `Done ${done}`) : undefined,
    ready ? theme.fg("text", `Ready ${ready}`) : undefined,
  ].filter((value): value is string => Boolean(value)).join(theme.fg("dim", " | "));
  const focus = active ?? rows[0];
  const focusChip = focus
    ? theme.bg?.("selectedBg", theme.fg("accent", ` ${focus.title} `)) ?? theme.fg("accent", focus.title)
    : "";
  const lines = [
    ...leftRight(width, heading, stats),
    ...leftRight(width, focusChip, renderTodoProgress(state, theme)),
  ];

  for (const todo of rows) {
    const selected = options.selectedTodoId !== undefined;
    const pointer = selected ? theme.fg(todo.id === options.selectedTodoId ? "accent" : "dim", todo.id === options.selectedTodoId ? "› " : "  ") : "  ";
    const row = `${pointer}${theme.fg(statusColor(todo.status), statusChip(todo.status))} ${theme.fg(todo.status === "completed" ? "muted" : "text", todo.title)}`;
    lines.push(truncateToWidth(row, width, "…"));
    if (todo.status === "external_blocked" && todo.blockedReason) {
      lines.push(truncateToWidth(`${selected ? "  " : ""}    ${theme.fg("warning", "└─")} ${theme.fg("muted", todo.blockedReason)}`, width, "…"));
    }
    if (options.expandedTodoIds?.has(todo.id)) {
      lines.push(truncateToWidth(`${selected ? "  " : ""}    ${theme.fg("dim", "│")} ${theme.fg("accent", "Details")}`, width, "…"));
      lines.push(truncateToWidth(`${selected ? "  " : ""}    ${theme.fg("dim", "│")} id: ${todo.id}`, width, "…"));
      lines.push(truncateToWidth(`${selected ? "  " : ""}    ${theme.fg("dim", "│")} status: ${statusLabel(todo.status)}`, width, "…"));
    }
  }
  return lines;
}

export function createTodoDocketComponent(state: TodoCoreState, theme: TodoTheme) {
  return {
    render: (width: number) => renderTodoDocketLines(state, theme, { width, includeDone: true }),
    invalidate: () => undefined,
  };
}

function statusChip(status: TodoPublicStatus): string {
  if (status === "completed") return "[✓]";
  if (status === "in_progress") return "[~]";
  if (status === "external_blocked") return "[⧗]";
  return "[ ]";
}

function statusColor(status: TodoPublicStatus): string {
  if (status === "completed") return "success";
  if (status === "in_progress") return "syntaxString";
  if (status === "external_blocked") return "warning";
  return "text";
}

function statusLabel(status: TodoPublicStatus): string {
  return status === "in_progress" ? "in progress" : status === "external_blocked" ? "external blocked" : status;
}
