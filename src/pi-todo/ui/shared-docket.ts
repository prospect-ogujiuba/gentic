import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TodoView, TodoViewItem, TodoViewStatus } from "../provider.ts";
import { leftRight } from "./format.ts";
import type { TodoTheme } from "./theme.ts";

export type SharedDocketRenderOptions = {
  width?: number;
  includeDone?: boolean;
  limit?: number;
  selectedId?: string;
  expandedIds?: ReadonlySet<string>;
};

export function visibleTodoViewItems(view: TodoView, includeDone = false): TodoViewItem[] {
  if (includeDone) return view.items;
  const byId = new Map(view.items.map((item) => [item.id, item]));
  const visible = new Set(view.items.filter((item) => item.status !== "complete").map((item) => item.id));
  for (const id of [...visible]) {
    let parentId = byId.get(id)?.parentId;
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId); visible.add(parentId); parentId = byId.get(parentId)?.parentId;
    }
  }
  return view.items.filter((item) => visible.has(item.id));
}

export function renderSharedDocketLines(view: TodoView, theme: TodoTheme, options: SharedDocketRenderOptions = {}): string[] {
  const width = Math.max(20, options.width ?? 80);
  if (!view.items.length) return [];
  const executable = view.items.filter((item) => item.executable);
  const done = executable.filter((item) => item.status === "complete").length;
  const active = executable.filter((item) => item.status === "active").length;
  const blocked = executable.filter((item) => item.status === "blocked").length;
  const implemented = executable.filter((item) => item.status === "implemented").length;
  const ready = executable.filter((item) => item.status === "ready" && item.ready).length;
  const label = view.provider === "workflow" ? "SWE WORK"
    : view.provider === "project" ? "PROJECT TASKS"
    : view.provider === "combined" ? "ALL TASKS"
    : "SESSION TASKS";
  const subtaskCount = view.items.filter((item) => item.parentId).length;
  const authority = `${view.authorityId} · Total ${view.items.length}${subtaskCount ? ` · ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}` : ""}`;
  const heading = `${theme.fg("accent", theme.bold ? theme.bold(label) : label)}${theme.fg("dim", " — ")}${theme.fg("accent", authority)}`;
  const stats = view.provider !== "workflow"
    ? [`Open ${executable.length - done}`, active ? `Active ${active}` : "", blocked ? `Blocked ${blocked}` : "", done ? `Done ${done}` : "", ready ? `Ready ${ready}` : ""].filter(Boolean).join(" | ")
    : [`${done}/${executable.length} complete`, active ? `${active} active` : "", implemented ? `${implemented} implemented` : "", blocked ? `${blocked} blocked` : "", ready ? `${ready} ready` : ""].filter(Boolean).join(" · ");
  const revision = view.revision ? `r${view.revision} · ` : "";
  const lines = [...leftRight(width, heading, theme.fg("dim", `${revision}${stats}`))];
  if (view.provider === "standalone" || view.provider === "project") lines.push(...leftRight(width, focusPath(view), renderProgress(view, theme)));

  const rows = visibleTodoViewItems(view, options.includeDone).slice(0, Math.max(0, options.limit ?? 8));
  for (const item of rows) {
    const selected = options.selectedId !== undefined;
    const pointer = selected ? theme.fg(item.id === options.selectedId ? "accent" : "dim", item.id === options.selectedId ? "› " : "  ") : "  ";
    const indent = item.depth ? `${"  ".repeat(item.depth - 1)}${theme.fg("dim", "└─")} ` : "";
    const rail = `${selected ? "  " : ""}  ${"  ".repeat(item.depth)}  `;
    const wait = waitingLabel(item);
    const scopedId = item.id.startsWith(`${item.scope}:`) ? item.id : `${item.scope}:${item.id}`;
    const prefixIdentity = view.provider === "workflow" ? `${theme.fg("accent", item.id)} ` : "";
    const suffixIdentity = view.provider === "workflow" ? "" : theme.fg("dim", ` (${scopedId})`);
    const row = `${pointer}${indent}${theme.fg(statusColor(item.status), statusChip(item.status, item.ready))} ${prefixIdentity}${theme.fg(item.status === "complete" ? "muted" : "text", item.title)}${suffixIdentity}${view.provider === "workflow" && wait ? theme.fg("dim", ` — ${wait}`) : ""}`;
    lines.push(truncateToWidth(row, width, "…"));
    if (item.status === "blocked" && item.blockedReason) lines.push(truncateToWidth(`${rail}${theme.fg("warning", "└─")} ${theme.fg("muted", item.blockedReason)}`, width, "…"));
    if (options.expandedIds?.has(item.id)) {
      const allowed = Object.entries(item.capabilities).filter(([, value]) => value).map(([key]) => key).join(", ") || "inspect only";
      for (const detail of [`authority: ${item.scope} · ${item.authorityId}`, `id: ${item.id}`, `scoped id: ${item.scope}:${item.id}`, `status: ${item.rawStatus}`, `capabilities: ${allowed}`]) {
        lines.push(truncateToWidth(`${rail}${theme.fg("dim", "│")} ${detail}`, width, "…"));
      }
    }
  }
  const visible = visibleTodoViewItems(view, options.includeDone);
  if (visible.length > rows.length) lines.push(truncateToWidth(theme.fg("dim", `… ${visible.length - rows.length} more`), width, "…"));
  return lines;
}

export function createSharedDocketComponent(view: TodoView, theme: TodoTheme) {
  return { render: (width: number) => renderSharedDocketLines(view, theme, { width, limit: 8 }), invalidate: () => undefined };
}

function renderProgress(view: TodoView, theme: TodoTheme): string {
  const items = view.items.filter((item) => item.executable);
  if (!items.length) return "";
  const done = items.filter((item) => item.status === "complete").length;
  const blocks = items.map((item) => item.status === "complete" ? theme.fg("success", "■")
    : item.status === "active" ? theme.fg("syntaxString", "▶")
    : item.status === "blocked" ? theme.fg("warning", "⧗")
    : item.status === "implemented" ? theme.fg("accent", "◇") : theme.fg("dim", "□")).join("");
  return `${theme.fg("dim", "[")}${blocks}${theme.fg("dim", "]")} ${done}/${items.length} ${Math.round((done / items.length) * 100)}%`;
}

function focusPath(view: TodoView): string {
  const byId = new Map(view.items.map((item) => [item.id, item]));
  const item = view.items.find((candidate) => candidate.status === "active") ?? view.items[0];
  if (!item) return "";
  const titles = [item.title]; let parentId = item.parentId; const seen = new Set([item.id]);
  while (parentId && byId.has(parentId) && !seen.has(parentId)) { seen.add(parentId); const parent = byId.get(parentId)!; titles.unshift(parent.title); parentId = parent.parentId; }
  return titles.join(" → ");
}

function statusChip(status: TodoViewStatus, ready: boolean): string {
  if (status === "group") return "◆";
  if (status === "complete") return "[✓]";
  if (status === "active") return "[~]";
  if (status === "implemented") return "[◇]";
  if (status === "blocked") return "[⧗]";
  return ready ? "[ ]" : "[·]";
}
function statusColor(status: TodoViewStatus): string {
  if (status === "complete") return "success";
  if (status === "active") return "syntaxString";
  if (status === "implemented") return "accent";
  if (status === "blocked") return "warning";
  return status === "group" ? "accent" : "text";
}
function waitingLabel(item: TodoViewItem): string {
  if (item.status === "group") return item.rawStatus === "phase" ? "phase" : "group";
  if (item.status === "implemented") return "implemented; verification required";
  if (item.status === "ready" && item.ready) return "pending; ready";
  if (item.status === "ready" && !item.ready) return item.waitingOn?.length ? `pending; waiting on ${item.waitingOn.join(", ")}` : "pending; waiting on dependencies";
  return item.rawStatus;
}
