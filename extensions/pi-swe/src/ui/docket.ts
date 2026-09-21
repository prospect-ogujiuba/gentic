import { truncateToWidth } from "@earendil-works/pi-tui";

import { readyWork, type Initiative, type WorkKind, type WorkStatus } from "../domain/initiative.ts";
import { leftRight } from "./format.ts";
import type { SweTheme } from "./theme.ts";

export type SweDocketItem = {
  id: string;
  title: string;
  kind: WorkKind;
  status?: WorkStatus;
  depth: number;
  executable: boolean;
  ready: boolean;
  dependsOn: string[];
};

export type SweDocket = {
  initiativeId: string;
  initiativeStatus: Initiative["status"];
  revision: number;
  items: SweDocketItem[];
};

export type SweDocketRenderOptions = {
  width?: number;
  includeDone?: boolean;
  limit?: number;
  selectedWorkId?: string;
  expandedWorkIds?: ReadonlySet<string>;
};

export function projectSweDocket(initiative: Initiative): SweDocket {
  const byId = new Map(initiative.work.map((item) => [item.id, item]));
  const parents = new Set(initiative.work.flatMap((item) => item.parentId ? [item.parentId] : []));
  const ready = new Set(readyWork(initiative).map((item) => item.id));
  const items = initiative.work.slice(0, 1_000).map((item): SweDocketItem => {
    let depth = 0;
    let cursor = item;
    while (cursor.parentId) {
      depth += 1;
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      cursor = parent;
    }
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      depth,
      executable: item.kind !== "phase" && !parents.has(item.id),
      ready: ready.has(item.id),
      dependsOn: [...(item.dependsOn ?? [])],
    };
  });
  return { initiativeId: initiative.id, initiativeStatus: initiative.status, revision: initiative.revision, items };
}

export function visibleSweDocketItems(docket: SweDocket, includeDone = false): SweDocketItem[] {
  return docket.items.filter((item) => includeDone || item.status !== "complete");
}

export function renderSweDocketLines(docket: SweDocket, theme: SweTheme, options: SweDocketRenderOptions = {}): string[] {
  const width = Math.max(20, options.width ?? 80);
  const executable = docket.items.filter((item) => item.executable);
  const done = executable.filter((item) => item.status === "complete").length;
  const active = executable.filter((item) => item.status === "active").length;
  const implemented = executable.filter((item) => item.status === "implemented").length;
  const blocked = executable.filter((item) => item.status === "blocked").length;
  const title = theme.bold ? theme.bold("SWE WORK") : "SWE WORK";
  const heading = `${theme.fg("accent", title)}${theme.fg("dim", " — ")}${theme.fg("accent", docket.initiativeId)}`;
  const stats = [`${done}/${executable.length} complete`, active ? `${active} active` : "", implemented ? `${implemented} implemented` : "", blocked ? `${blocked} blocked` : ""]
    .filter(Boolean).join(" · ");
  const lines = [...leftRight(width, heading, theme.fg("dim", `r${docket.revision} · ${stats}`))];
  const visible = visibleSweDocketItems(docket, options.includeDone);
  const rows = visible.slice(0, Math.max(0, options.limit ?? 8));
  for (const item of rows) {
    const selectable = options.selectedWorkId !== undefined;
    const pointer = selectable ? (item.id === options.selectedWorkId ? theme.fg("accent", "› ") : "  ") : "";
    const indent = "  ".repeat(item.depth);
    const suffix = waitingLabel(item);
    const row = `${pointer}${indent}${theme.fg(statusColor(item), statusChip(item))} ${theme.fg("accent", item.id)} ${theme.fg(item.status === "complete" ? "muted" : "text", item.title)}${suffix ? theme.fg("dim", ` — ${suffix}`) : ""}`;
    lines.push(truncateToWidth(row, width, "…"));
    if (options.expandedWorkIds?.has(item.id)) {
      for (const detail of [`id: ${item.id}`, `kind: ${item.kind}`, `status: ${item.status ?? "group"}`]) {
        lines.push(truncateToWidth(`${pointer ? "  " : ""}${indent}    ${theme.fg("dim", "│")} ${detail}`, width, "…"));
      }
    }
  }
  if (visible.length > rows.length) lines.push(truncateToWidth(theme.fg("dim", `… ${visible.length - rows.length} more`), width, "…"));
  return lines;
}

export function createSweDocketComponent(docket: SweDocket, theme: SweTheme) {
  return { render: (width: number) => renderSweDocketLines(docket, theme, { width, limit: 8 }), invalidate: () => undefined };
}

function waitingLabel(item: SweDocketItem): string {
  if (item.kind === "phase") return "phase";
  if (item.status === "implemented") return "implemented; verification required";
  if (item.status === "pending" && !item.ready && item.dependsOn.length) return `pending; waiting on ${item.dependsOn.join(", ")}`;
  if (item.status === "pending" && item.ready) return "pending; ready";
  return item.status ?? "";
}

function statusChip(item: SweDocketItem): string {
  if (item.kind === "phase") return "◆";
  if (item.status === "complete") return "[✓]";
  if (item.status === "active") return "[~]";
  if (item.status === "implemented") return "[◇]";
  if (item.status === "blocked") return "[⧗]";
  return item.ready ? "[ ]" : "[·]";
}

function statusColor(item: SweDocketItem): string {
  if (item.status === "complete") return "success";
  if (item.status === "active") return "syntaxString";
  if (item.status === "implemented") return "accent";
  if (item.status === "blocked") return "warning";
  return item.ready ? "text" : "dim";
}
