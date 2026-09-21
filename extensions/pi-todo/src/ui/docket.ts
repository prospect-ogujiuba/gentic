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

export type TodoTreeRow = { todo: TodoPublicItem; depth: number };

export function orderedTodoRows(state: TodoCoreState, includeDone = false): TodoTreeRow[] {
  const ids = state.order.filter((id) => Boolean(state.todos[id]));
  const children = new Map<string | undefined, string[]>();
  for (const id of ids) {
    const todo = state.todos[id]!;
    const parentId = todo.parentTodoId && todo.parentTodoId !== id && state.todos[todo.parentTodoId]
      ? todo.parentTodoId
      : undefined;
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }

  const rows: TodoTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    const todo = state.todos[id];
    if (!todo) return;
    seen.add(id);
    rows.push({ todo, depth });
    for (const childId of children.get(id) ?? []) visit(childId, depth + 1);
  };
  for (const id of children.get(undefined) ?? []) visit(id, 0);
  for (const id of ids) visit(id, 0);
  if (includeDone) return rows;

  const visible = new Set(rows.filter(({ todo }) => todo.status !== "completed").map(({ todo }) => todo.id));
  for (const id of [...visible]) {
    let parentId = state.todos[id]?.parentTodoId;
    const ancestors = new Set<string>();
    while (parentId && state.todos[parentId] && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      visible.add(parentId);
      parentId = state.todos[parentId]?.parentTodoId;
    }
  }
  return rows.filter(({ todo }) => visible.has(todo.id));
}

export function orderedTodoItems(state: TodoCoreState, includeDone = false): TodoPublicItem[] {
  return orderedTodoRows(state, includeDone).map(({ todo }) => todo);
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
  const rows = orderedTodoRows(state, options.includeDone).slice(0, options.limit ?? 8);
  const active = all.find((todo) => todo.status === "in_progress");
  const ready = all.filter((todo) => todo.status === "ready").length;
  const blocked = all.filter((todo) => todo.status === "external_blocked").length;
  const done = all.filter((todo) => todo.status === "completed").length;
  const open = all.length - done;
  const title = theme.bold ? theme.bold("TASKS") : "TASKS";
  const subtaskCount = all.filter((todo) => todo.parentTodoId).length;
  const heading = `${theme.fg("accent", title)}${theme.fg("dim", " — ")}${theme.fg("accent", `Total ${all.length}`)}${subtaskCount ? theme.fg("dim", ` · ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}`) : ""}${theme.fg("dim", " · /todo open")}`;
  const stats = [
    theme.fg("dim", `Open ${open}`),
    active ? theme.fg("syntaxString", "Active 1") : undefined,
    blocked ? theme.fg("warning", `Blocked ${blocked}`) : undefined,
    done ? theme.fg("success", `Done ${done}`) : undefined,
    ready ? theme.fg("text", `Ready ${ready}`) : undefined,
  ].filter((value): value is string => Boolean(value)).join(theme.fg("dim", " | "));
  const focus = active ?? rows[0]?.todo;
  const focusLabel = focus ? todoPath(state, focus) : "";
  const focusChip = focus
    ? theme.bg?.("selectedBg", theme.fg("accent", ` ${focusLabel} `)) ?? theme.fg("accent", focusLabel)
    : "";
  const lines = [
    ...leftRight(width, heading, stats),
    ...leftRight(width, focusChip, renderTodoProgress(state, theme)),
  ];

  for (const { todo, depth } of rows) {
    const selected = options.selectedTodoId !== undefined;
    const pointer = selected ? theme.fg(todo.id === options.selectedTodoId ? "accent" : "dim", todo.id === options.selectedTodoId ? "› " : "  ") : "  ";
    const indent = depth ? `${"  ".repeat(depth - 1)}${theme.fg("dim", "└─")} ` : "";
    const rail = `${selected ? "  " : ""}  ${"  ".repeat(depth)}  `;
    const row = `${pointer}${indent}${theme.fg(statusColor(todo.status), statusChip(todo.status))} ${theme.fg(todo.status === "completed" ? "muted" : "text", todo.title)}`;
    lines.push(truncateToWidth(row, width, "…"));
    if (todo.status === "external_blocked" && todo.blockedReason) {
      lines.push(truncateToWidth(`${rail}${theme.fg("warning", "└─")} ${theme.fg("muted", todo.blockedReason)}`, width, "…"));
    }
    if (options.expandedTodoIds?.has(todo.id)) {
      lines.push(truncateToWidth(`${rail}${theme.fg("dim", "│")} ${theme.fg("accent", "Details")}`, width, "…"));
      lines.push(truncateToWidth(`${rail}${theme.fg("dim", "│")} id: ${todo.id}`, width, "…"));
      lines.push(truncateToWidth(`${rail}${theme.fg("dim", "│")} status: ${statusLabel(todo.status)}`, width, "…"));
      if (todo.parentTodoId) lines.push(truncateToWidth(`${rail}${theme.fg("dim", "│")} parent: ${todo.parentTodoId}`, width, "…"));
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

function todoPath(state: TodoCoreState, todo: TodoPublicItem): string {
  const titles = [todo.title];
  const seen = new Set([todo.id]);
  let parentId = todo.parentTodoId;
  while (parentId && state.todos[parentId] && !seen.has(parentId)) {
    seen.add(parentId);
    titles.unshift(state.todos[parentId]!.title);
    parentId = state.todos[parentId]!.parentTodoId;
  }
  return titles.join(" → ");
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
