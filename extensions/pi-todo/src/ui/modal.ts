import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { TodoService } from "../app/service.ts";
import type { TodoState } from "../domain/types.ts";
import { PiTodoEventStore } from "../pi/store.ts";
import { padAnsi } from "./format.ts";
import { renderTodoDocketLines } from "./docket.ts";
import type { TodoTheme } from "./theme.ts";

function framed(theme: TodoTheme, width: number, title: string, body: string[]): string[] {
  const inner = Math.max(32, width - 2);
  const label = ` ${title} `;
  const top = theme.fg("border", `╭${"─".repeat(Math.max(0, Math.floor((inner - label.length) / 2)))}`) + theme.fg("accent", label) + theme.fg("border", `${"─".repeat(Math.max(0, inner - label.length - Math.floor((inner - label.length) / 2)))}╮`);
  return [top, ...body.map((line) => `${theme.fg("border", "│")}${padAnsi(line, inner)}${theme.fg("border", "│")}`), theme.fg("border", `╰${"─".repeat(inner)}╯`)];
}

class TodoModalComponent {
  private theme: TodoTheme;
  private state: TodoState;
  private requestRender: () => void;
  private closeModal: () => void;
  private getRows: () => number;
  private refreshState: () => Promise<TodoState>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private scrollOffset = 0;
  private showAll = false;

  constructor(theme: TodoTheme, state: TodoState, requestRender: () => void, closeModal: () => void, getRows: () => number, refreshState: () => Promise<TodoState>, pollMs = 750) {
    this.theme = theme;
    this.state = state;
    this.requestRender = requestRender;
    this.closeModal = closeModal;
    this.getRows = getRows;
    this.refreshState = refreshState;
    this.pollTimer = setInterval(() => void this.refresh(), pollMs);
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      this.update(await this.refreshState());
    } finally {
      this.refreshInFlight = false;
    }
  }

  update(state: TodoState): void {
    if (state.lastEventId === this.state.lastEventId && Object.keys(state.todos).length === Object.keys(this.state.todos).length) return;
    this.state = state;
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const bodyWidth = Math.max(30, width - 4);
    const visibleCount = this.showAll ? Object.keys(this.state.todos).length : undefined;
    const body = [
      this.theme.fg("dim", `view ${this.showAll ? "all tasks" : "open tasks"} · a toggle all/open`),
      "",
      ...renderTodoDocketLines(this.state, this.theme, { width: bodyWidth, limit: visibleCount ?? 18, includeDone: this.showAll }),
      "",
      this.theme.fg("dim", "a all/open · ↑↓/j/k scroll · q/esc close · /todo refreshes"),
    ];
    const all = framed(this.theme, Math.max(40, width), `/todo live modal · ${this.showAll ? "all" : "open"}`, body);
    const maxLines = Math.max(8, Math.floor(this.getRows() * 0.86));
    const maxOffset = Math.max(0, all.length - maxLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    this.cachedWidth = width;
    this.cachedLines = all.length > maxLines ? all.slice(this.scrollOffset, this.scrollOffset + maxLines) : all;
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.closeModal();
    if (data === "a") {
      this.showAll = !this.showAll;
      this.scrollOffset = 0;
    }
    if (matchesKey(data, Key.down) || data === "j") this.scrollOffset += 1;
    if (matchesKey(data, Key.up) || data === "k") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

export function createLiveTodoModalComponent(options: { theme: TodoTheme; state: TodoState; requestRender: () => void; closeModal: () => void; getRows: () => number; refreshState: () => Promise<TodoState>; pollMs?: number }): TodoModalComponent {
  return new TodoModalComponent(options.theme, options.state, options.requestRender, options.closeModal, options.getRows, options.refreshState, options.pollMs);
}

export async function openTodoModal(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const svc = new TodoService(new PiTodoEventStore(pi, ctx));
  const state = await svc.state();
  await ctx.ui.custom<void>((tui, theme, _kb, done) => createLiveTodoModalComponent({ theme, state, requestRender: () => tui.requestRender(), closeModal: () => done(), getRows: () => tui.terminal.rows, refreshState: () => svc.state() }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "82%", minWidth: 54, maxHeight: "88%", margin: 1, visible: (termWidth) => termWidth >= 54 },
  });
}
