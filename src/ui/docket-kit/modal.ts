import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padAnsi } from "./format.ts";

export type DocketTheme = { fg(color: string, text: string): string };
export type DocketIntent = "close" | "next" | "previous" | "expand" | "expand-all" | "filter" | "page-next" | "page-previous";
export type DocketRenderState = {
  width: number;
  includeDone: boolean;
  limit: number;
  selectedId?: string;
  expandedIds: ReadonlySet<string>;
};
export type DocketModalOptions = {
  rows(includeDone: boolean): readonly { id: string }[];
  renderContent(state: DocketRenderState): string[];
  title: string;
  noun: string;
  theme: DocketTheme;
  requestRender(): void;
  close(): void;
  terminalRows(): number;
  onIntent?(intent: DocketIntent): void;
};

export function docketIntent(data: string): DocketIntent | undefined {
  if (data === "q" || matchesKey(data, Key.escape)) return "close";
  if (data === "j" || matchesKey(data, Key.down)) return "next";
  if (data === "k" || matchesKey(data, Key.up)) return "previous";
  if (data === " " || matchesKey(data, Key.enter)) return "expand";
  if (data === "x") return "expand-all";
  if (data === "a") return "filter";
  if (data === "\x1b[6~") return "page-next";
  if (data === "\x1b[5~") return "page-previous";
  return undefined;
}

/** Presentation state only. Adapters supply rows, content, and external effects. */
export class DocketModal {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private showAll = true;
  private readonly expanded = new Set<string>();
  private readonly options: DocketModalOptions;
  constructor(options: DocketModalOptions) { this.options = options; }

  handleInput(data: string): void {
    const intent = docketIntent(data);
    if (!intent) return;
    this.options.onIntent?.(intent);
    const rows = this.rows();
    if (intent === "close") { this.options.close(); return; }
    if (intent === "next" || intent === "page-next") this.selectedIndex += intent === "next" ? 1 : 5;
    else if (intent === "previous" || intent === "page-previous") this.selectedIndex -= intent === "previous" ? 1 : 5;
    else if (intent === "expand") {
      const id = rows[this.selectedIndex]?.id;
      if (id) this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
    } else if (intent === "expand-all") {
      if (rows.every((item) => this.expanded.has(item.id))) this.expanded.clear();
      else for (const item of rows) this.expanded.add(item.id);
    } else if (intent === "filter") {
      const selected = rows[this.selectedIndex]?.id;
      this.showAll = !this.showAll;
      this.selectedIndex = Math.max(0, selected ? this.rows().findIndex((item) => item.id === selected) : 0);
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.rows().length - 1)));
    this.options.requestRender();
  }

  render(width: number): string[] {
    const { theme, noun } = this.options;
    const boundedWidth = Math.max(0, Math.floor(width));
    const inner = Math.max(0, boundedWidth - 2);
    const rows = this.rows();
    const content = [
      theme.fg("dim", `${this.showAll ? "all" : "open"} ${noun} · ↑↓/j/k select · enter/space expand · x expand all · a all/open`),
      ...this.options.renderContent({ width: inner, includeDone: this.showAll, limit: rows.length, selectedId: rows[this.selectedIndex]?.id, expandedIds: this.expanded }),
      theme.fg("dim", "a all/open · x expand/collapse · pgup/pgdn scroll · q close"),
    ];
    const maxBody = Math.max(6, Math.floor(this.options.terminalRows() * 0.8) - 2);
    const capacity = Math.max(1, maxBody - (content.length > maxBody ? 2 : 0));
    const selectedLine = content.findIndex((line) => line.includes("›"));
    if (selectedLine >= 0) {
      if (selectedLine < this.scrollOffset) this.scrollOffset = selectedLine;
      else if (selectedLine >= this.scrollOffset + capacity) this.scrollOffset = selectedLine - capacity + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, content.length - capacity)));
    const body = content.slice(this.scrollOffset, this.scrollOffset + capacity);
    if (this.scrollOffset > 0) body.unshift(theme.fg("dim", "↑ more"));
    if (this.scrollOffset + capacity < content.length) body.push(theme.fg("dim", "↓ more"));
    return frame(theme, boundedWidth, this.options.title, body);
  }

  invalidate(): void {}
  private rows() { return this.options.rows(this.showAll); }
}

export function frame(theme: DocketTheme, width: number, title: string, body: readonly string[]): string[] {
  width = Math.max(0, Math.floor(width));
  if (width < 2) return ["", ...body, ""].map((line) => truncateToWidth(line, width, ""));
  const inner = width - 2;
  const label = truncateToWidth(` ${title} `, inner, "");
  const remaining = inner - visibleWidth(label);
  const left = Math.floor(remaining / 2);
  return [
    theme.fg("border", `╭${"─".repeat(left)}${label}${"─".repeat(remaining - left)}╮`),
    ...body.map((line) => `${theme.fg("border", "│")}${padAnsi(line, inner)}${theme.fg("border", "│")}`),
    theme.fg("border", `╰${"─".repeat(inner)}╯`),
  ];
}
