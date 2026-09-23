import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { TodoView } from "../provider.ts";
import { padAnsi } from "./format.ts";
import { renderSharedDocketLines, visibleTodoViewItems } from "./shared-docket.ts";
import type { TodoTheme } from "./theme.ts";

export type TodoDocketModalOptions = {
  view: TodoView;
  theme: TodoTheme;
  requestRender: () => void;
  close: () => void;
  terminalRows: () => number;
};

/** One keyboard/modal implementation for standalone and workflow providers. */
export class TodoDocketModal {
  private readonly view: TodoView;
  private readonly theme: TodoTheme;
  private readonly requestRender: () => void;
  private readonly closeModal: () => void;
  private readonly terminalRows: () => number;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private showAll = true;
  private readonly expanded = new Set<string>();

  constructor(options: TodoDocketModalOptions) {
    this.view = options.view; this.theme = options.theme; this.requestRender = options.requestRender;
    this.closeModal = options.close; this.terminalRows = options.terminalRows;
  }

  handleInput(data: string): void {
    const rows = this.rows();
    if (data === "q" || matchesKey(data, Key.escape)) { this.closeModal(); return; }
    if (data === "j" || matchesKey(data, Key.down)) this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 1);
    else if (data === "k" || matchesKey(data, Key.up)) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (data === " " || matchesKey(data, Key.enter)) {
      const id = rows[this.selectedIndex]?.id; if (id) this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
    } else if (data === "x") {
      if (rows.every((item) => this.expanded.has(item.id))) this.expanded.clear(); else for (const item of rows) this.expanded.add(item.id);
    } else if (data === "a") {
      const selected = rows[this.selectedIndex]?.id; this.showAll = !this.showAll;
      this.selectedIndex = Math.max(0, selected ? this.rows().findIndex((item) => item.id === selected) : 0);
    } else if (data === "\x1b[6~") this.selectedIndex = Math.min(Math.max(0, rows.length - 1), this.selectedIndex + 5);
    else if (data === "\x1b[5~") this.selectedIndex = Math.max(0, this.selectedIndex - 5);
    else return;
    this.clampSelection(); this.requestRender();
  }

  render(width: number): string[] {
    const inner = Math.max(30, width - 2); const rows = this.rows(); const selectedId = rows[this.selectedIndex]?.id;
    const noun = this.view.provider === "workflow" ? "work" : "tasks";
    const mode = this.theme.fg("dim", `${this.showAll ? "all" : "open"} ${noun} · ↑↓/j/k select · enter/space expand · x expand all · a all/open`);
    const content = [mode, ...renderSharedDocketLines(this.view, this.theme, {
      width: inner, includeDone: this.showAll, limit: rows.length, selectedId, expandedIds: this.expanded,
    }), this.theme.fg("dim", "a all/open · x expand/collapse · pgup/pgdn scroll · q close")];
    const maxBody = Math.max(6, Math.floor(this.terminalRows() * 0.8) - 2);
    const overflowing = content.length > maxBody; const capacity = Math.max(1, maxBody - (overflowing ? 2 : 0));
    const selectedLine = content.findIndex((line) => line.includes("›"));
    if (selectedLine >= 0) {
      if (selectedLine < this.scrollOffset) this.scrollOffset = selectedLine;
      else if (selectedLine >= this.scrollOffset + capacity) this.scrollOffset = selectedLine - capacity + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, content.length - capacity)));
    const body = content.slice(this.scrollOffset, this.scrollOffset + capacity);
    if (this.scrollOffset > 0) body.unshift(this.theme.fg("dim", "↑ more"));
    if (this.scrollOffset + capacity < content.length) body.push(this.theme.fg("dim", "↓ more"));
    return frame(this.theme, Math.max(32, width), this.view.provider === "workflow" ? "SWE WORK DOCKET" : "TODO DOCKET", body);
  }

  invalidate(): void {}
  private rows() { return visibleTodoViewItems(this.view, this.showAll); }
  private clampSelection(): void { this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.rows().length - 1))); }
}

function frame(theme: TodoTheme, width: number, title: string, body: string[]): string[] {
  const inner = Math.max(30, width - 2); const label = ` ${title} `;
  const left = Math.max(1, Math.floor((inner - label.length) / 2)); const right = Math.max(1, inner - label.length - left);
  return [
    theme.fg("border", `╭${"─".repeat(left)}${label}${"─".repeat(right)}╮`),
    ...body.map((line) => `${theme.fg("border", "│")}${padAnsi(truncateToWidth(line, inner, ""), inner)}${theme.fg("border", "│")}`),
    theme.fg("border", `╰${"─".repeat(inner)}╯`),
  ];
}
