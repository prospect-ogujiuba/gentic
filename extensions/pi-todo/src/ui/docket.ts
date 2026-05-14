import type { Todo, TodoState, TodoStatus } from "../domain/types.ts";
import { activeTodo, nextTodo, openDependencyIds, orderedTodos, readyToClose, summarizeTodos } from "../app/query.ts";
import { isTerminalStatus } from "../domain/lifecycle.ts";
import { leftRight, wrap } from "./format.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoTheme } from "./theme.ts";

function statusLabel(status: TodoStatus): string {
  if (status === "in_progress") return "in progress";
  return status;
}

function prioritySignal(priority: Todo["priority"], theme: TodoTheme): string | undefined {
  if (priority === "urgent" || priority === "critical") return theme.fg("error", "‼");
  if (priority === "high") return theme.fg("warning", "!");
  if (priority === "low") return theme.fg("dim", "↓");
  return undefined;
}

function statusColor(status: TodoStatus): string {
  if (["done", "completed", "verified"].includes(status)) return "syntaxComment";
  if (["blocked", "cancelled", "failed", "abandoned"].includes(status)) return "error";
  if (["in_progress", "claimed", "needs_review"].includes(status)) return "syntaxString";
  return "text";
}

function statusChip(status: TodoStatus): string {
  if (["done", "completed", "verified"].includes(status)) return "[✓]";
  if (status === "blocked") return "[!]";
  if (["cancelled", "abandoned"].includes(status)) return "[-]";
  if (status === "failed") return "[×]";
  if (["in_progress", "claimed"].includes(status)) return "[~]";
  if (["needs_review", "proposed"].includes(status)) return "[?]";
  return "[ ]";
}

function progressBlock(status: TodoStatus, theme: TodoTheme): string {
  if (["done", "completed", "verified"].includes(status)) return theme.fg("syntaxComment", "■");
  if (["cancelled", "abandoned", "failed"].includes(status)) return theme.fg("muted", "!");
  if (status === "blocked") return theme.fg("muted", "!");
  if (["in_progress", "claimed", "needs_review"].includes(status)) return theme.fg("syntaxString", "▶");
  return theme.fg("dim", "□");
}

export function renderTodoProgress(state: TodoState, theme: TodoTheme): string {
  const todos = orderedTodos(state, true);
  const counts = summarizeTodos(state);
  const resolved = counts.byStatus.completed + counts.byStatus.verified;
  const pct = counts.total > 0 ? Math.round((resolved / counts.total) * 100) : 0;
  const statColor = pct >= 100 ? "syntaxComment" : pct > 0 ? "accent" : "dim";
  const bar = `${theme.fg("dim", "[")}${todos.map((todo) => progressBlock(todo.status, theme)).join("")}${theme.fg("dim", "]")}`;
  return `${bar} ${theme.fg(statColor, `${resolved}/${counts.total}`)} ${theme.fg(statColor, `${pct}%`)} ${theme.fg("dim", "S/F")} ${theme.fg(counts.byStatus.cancelled > 0 ? "error" : "syntaxComment", `${resolved}/${counts.byStatus.cancelled + counts.byStatus.failed + counts.byStatus.abandoned}`)}`;
}

export function formatTodoTitleForTui(title: string, options: { commonPrefix?: string; maxWidth?: number } = {}): string {
  let value = title.trim();
  if (options.commonPrefix && value.startsWith(options.commonPrefix)) value = value.slice(options.commonPrefix.length).trim();
  if (value.length > 34) value = value.replace(/^[^:]{8,48}:\s+/, "");
  return truncateToWidth(value || title, options.maxWidth ?? 72, "…");
}

function commonColonPrefix(todos: Todo[]): string | undefined {
  const prefixes = todos.map((todo) => todo.title.match(/^([^:]{8,64}:)\s+/)?.[0]).filter((prefix): prefix is string => Boolean(prefix));
  if (prefixes.length < 2) return undefined;
  const [first] = prefixes;
  return prefixes.every((prefix) => prefix === first) ? first : undefined;
}

function dependencyBadge(todo: Todo, state: TodoState, theme: TodoTheme): string | undefined {
  const open = openDependencyIds(todo, state);
  if (open.length > 0) return theme.fg("warning", `⧗ waits ${open.length}`);
  if (todo.dependsOn.length > 0) return theme.fg("syntaxComment", "✓ deps");
  return undefined;
}

function todoDepth(todo: Todo, state: TodoState): number {
  let depth = 0;
  let parentId = todo.parentId;
  while (parentId && state.todos[parentId] && depth < 8) { depth += 1; parentId = state.todos[parentId].parentId; }
  return depth;
}

function rowPrefix(todo: Todo, state: TodoState): string {
  const indent = "  ".repeat(todoDepth(todo, state));
  const open = openDependencyIds(todo, state);
  if (open.length > 0) return `${indent}↳ `;
  if (todo.dependsOn.length > 0) return `${indent}└ `;
  return indent;
}

function renderSummaryLines(width: number, left: string, progress: string): string[] {
  if (visibleWidth(left) + 1 + visibleWidth(progress) <= width) return [leftRight(width, left, progress)];
  return [truncateToWidth(left, width, ""), truncateToWidth(progress, width, "")];
}

export type TodoDocketRenderOptions = { width?: number; limit?: number; includeDone?: boolean; detail?: "compact" | "summary"; showCompletedFocus?: boolean };

function latestTerminalTodo(state: TodoState): Todo | undefined {
  return orderedTodos(state, true)
    .filter((todo) => isTerminalStatus(todo.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function summaryTitle(state: TodoState, options: Pick<TodoDocketRenderOptions, "showCompletedFocus"> = {}): string | undefined {
  const active = activeTodo(state);
  const next = nextTodo(state);
  const rows = orderedTodos(state, false);
  const prefix = commonColonPrefix(rows);
  const focus = active || next || rows[0] || (options.showCompletedFocus ?? true ? latestTerminalTodo(state) : undefined);
  return focus ? formatTodoTitleForTui(focus.title, { commonPrefix: prefix, maxWidth: 80 }) : undefined;
}

export function renderTodoDocketLines(state: TodoState, theme: TodoTheme, options: TodoDocketRenderOptions = {}): string[] {
  const width = options.width ?? 80;
  const counts = summarizeTodos(state);
  const activeCount = counts.byStatus.in_progress + counts.byStatus.claimed;
  const doneCount = counts.byStatus.completed + counts.byStatus.verified;
  const failedCount = counts.byStatus.cancelled + counts.byStatus.failed + counts.byStatus.abandoned;
  const title = theme.bold ? theme.bold("TASKS") : "TASKS";
  const chip = (label: string, count: number, color: string) => count > 0 ? (theme.bg ? theme.bg("selectedBg", theme.fg(color, ` ${label} ${count} `)) : theme.fg(color, `[${label} ${count}]`)) : "";
  const totalSummary = `${theme.fg("accent", `Total ${counts.total}`)}${theme.fg("dim", ` · open ${counts.open}`)}`;
  const left = [theme.fg("accent", title), totalSummary, chip("Ready", counts.byStatus.ready, "text"), chip("Active", activeCount, "syntaxString"), chip("Blocked", counts.byStatus.blocked, "muted"), chip("Done", doneCount, "accent"), chip("Cancelled", failedCount, "error"), theme.fg("dim", "/todo")].filter(Boolean).join(theme.fg("dim", " - "));
  const lines: string[] = [];
  const focus = summaryTitle(state, options);
  if (focus) lines.push(`\x1b[48;5;108m\x1b[30m * ${focus} \x1b[0m`);
  lines.push(...renderSummaryLines(width, left, renderTodoProgress(state, theme)));

  const rows = orderedTodos(state, options.includeDone ?? false).slice(0, options.limit ?? 8);
  const prefix = commonColonPrefix(rows);
  for (const [index, todo] of rows.entries()) {
    const icon = theme.fg(statusColor(todo.status), statusChip(todo.status));
    const title = formatTodoTitleForTui(todo.title, { commonPrefix: prefix, maxWidth: Math.max(24, width - 28) });
    const titleText = theme.fg(todo.status === "cancelled" ? "muted" : "text", title);
    const deps = dependencyBadge(todo, state, theme);
    const close = readyToClose(todo, state) ? theme.fg("accent", "close") : undefined;
    const priority = prioritySignal(todo.priority, theme);
    const compactMeta = [close, deps, priority].filter(Boolean);
    const summaryMeta = [close && theme.fg("accent", "Ready to close"), statusLabel(todo.status), todo.priority, deps, `v${todo.revision}`, todo.updatedAt.slice(5, 16).replace("T", " ")].filter(Boolean);
    const metaParts = options.detail === "summary" ? summaryMeta : compactMeta;
    const meta = metaParts.length > 0 ? theme.fg("dim", metaParts.join(options.detail === "summary" ? " | " : " ")) : "";
    const line = meta ? leftRight(width, `${rowPrefix(todo, state)}${icon} ${titleText}`, meta) : `${rowPrefix(todo, state)}${icon} ${titleText}`;
    lines.push(...wrap(width, line));
  }
  if (counts.open === 0 && counts.total === 0) lines.push(theme.fg("dim", "No tasks recorded yet."));
  return lines;
}

export function createTodoDocketComponent(state: TodoState, options: Pick<TodoDocketRenderOptions, "showCompletedFocus"> = {}) {
  return (_tui: { requestRender?: () => void }, theme: TodoTheme) => ({
    dispose() {},
    invalidate() {},
    render(width: number): string[] {
      return renderTodoDocketLines(state, theme, { width, limit: 5, showCompletedFocus: options.showCompletedFocus });
    },
  });
}

export function renderTodoWidgetLines(state: TodoState, theme: TodoTheme, width = 92, options: Pick<TodoDocketRenderOptions, "showCompletedFocus"> = {}): string[] {
  return renderTodoDocketLines(state, theme, { width, limit: 5, showCompletedFocus: options.showCompletedFocus });
}
