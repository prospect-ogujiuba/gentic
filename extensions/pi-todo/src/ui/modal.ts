import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { orderedDocketTodos } from "../app/query.ts";
import { TodoService } from "../app/service.ts";
import type { Todo, TodoState } from "../domain/types.ts";
import { PiTodoEventStore } from "../pi/store.ts";
import { padAnsi } from "./format.ts";
import { renderTodoDocketLines } from "./docket.ts";
import type { TodoTheme } from "./theme.ts";

const TODO_MODAL_MAX_HEIGHT_RATIO = 0.85;

function framed(
  theme: TodoTheme,
  width: number,
  title: string,
  body: string[],
): string[] {
  const inner = Math.max(32, width - 2);
  const label = ` ${title} `;
  const top =
    theme.fg(
      "border",
      `╭${"─".repeat(Math.max(0, Math.floor((inner - label.length) / 2)))}`,
    ) +
    theme.fg("accent", label) +
    theme.fg(
      "border",
      `${"─".repeat(Math.max(0, inner - label.length - Math.floor((inner - label.length) / 2)))}╮`,
    );
  return [
    top,
    ...body.map(
      (line) =>
        `${theme.fg("border", "│")}${padAnsi(line, inner)}${theme.fg("border", "│")}`,
    ),
    theme.fg("border", `╰${"─".repeat(inner)}╯`),
  ];
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
  private showAll = true;
  private selectedIndex = 0;
  private expandedTodoIds = new Set<string>();

  constructor(
    theme: TodoTheme,
    state: TodoState,
    requestRender: () => void,
    closeModal: () => void,
    getRows: () => number,
    refreshState: () => Promise<TodoState>,
    pollMs = 750,
  ) {
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
    if (
      state.lastEventId === this.state.lastEventId &&
      Object.keys(state.todos).length === Object.keys(this.state.todos).length
    )
      return;
    this.state = state;
    this.clampSelection();
    this.invalidate();
    this.requestRender();
  }

  private rows(): Todo[] {
    return orderedDocketTodos(this.state, this.showAll);
  }

  private clampSelection(): void {
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, Math.max(0, this.rows().length - 1)),
    );
  }

  private toggleExpandAll(): void {
    const ids = this.rows().map((todo) => todo.id);
    if (ids.length === 0) return;
    const allExpanded = ids.every((id) => this.expandedTodoIds.has(id));
    if (allExpanded) {
      for (const id of ids) this.expandedTodoIds.delete(id);
      return;
    }
    for (const id of ids) this.expandedTodoIds.add(id);
  }

  private syncScrollToSelection(lines: string[], maxLines: number): void {
    const selectedLine = lines.findIndex((line) => line.includes("› "));
    if (selectedLine < 0) return;
    const margin = 2;
    if (selectedLine < this.scrollOffset + margin)
      this.scrollOffset = Math.max(0, selectedLine - margin);
    if (selectedLine >= this.scrollOffset + maxLines - margin)
      this.scrollOffset = Math.max(0, selectedLine - maxLines + margin + 1);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.clampSelection();
    const bodyWidth = Math.max(30, width - 4);
    const rows = this.rows();
    const selectedTodoId = rows[this.selectedIndex]?.id;
    const modeLine = this.theme.fg(
      "dim",
      `${this.showAll ? "all" : "open"} tasks · ↑↓/j/k select · enter/space expand · x expand/collapse all · a all/open`,
    );
    const content = renderTodoDocketLines(this.state, this.theme, {
      width: bodyWidth,
      limit: rows.length,
      includeDone: this.showAll,
      detail: "compact",
      selectedTodoId,
      expandedTodoIds: this.expandedTodoIds,
    });
    const footer = this.theme.fg(
      "dim",
      "a all/open · x expand/collapse all · enter/space expand · ↑↓/j/k select · pgup/pgdn scroll · q close",
    );
    const maxLines = Math.max(8, Math.floor(this.getRows() * TODO_MODAL_MAX_HEIGHT_RATIO));
    const contentLimit = Math.max(1, maxLines - 4);
    const maxOffset = Math.max(0, content.length - contentLimit);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    this.syncScrollToSelection(content, contentLimit);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visibleContent =
      content.length > contentLimit
        ? content.slice(this.scrollOffset, this.scrollOffset + contentLimit)
        : content;
    const range =
      content.length > contentLimit
        ? this.theme.fg(
            "dim",
            ` · lines ${this.scrollOffset + 1}-${this.scrollOffset + visibleContent.length}/${content.length}`,
          )
        : "";
    const all = framed(
      this.theme,
      Math.max(40, width),
      `/todo · ${this.showAll ? "all" : "open"}`,
      [modeLine + range, ...visibleContent, footer],
    );
    this.cachedWidth = width;
    this.cachedLines = all;
    return this.cachedLines;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    )
      return this.closeModal();
    if (data === "a") {
      this.showAll = !this.showAll;
      this.scrollOffset = 0;
      this.clampSelection();
    }
    if (data === "x") this.toggleExpandAll();
    if (matchesKey(data, Key.pageDown)) this.scrollOffset += 5;
    if (matchesKey(data, Key.pageUp))
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
    if (matchesKey(data, Key.down) || data === "j")
      this.selectedIndex = Math.min(
        Math.max(0, this.rows().length - 1),
        this.selectedIndex + 1,
      );
    if (matchesKey(data, Key.up) || data === "k")
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      data === " "
    ) {
      const todoId = this.rows()[this.selectedIndex]?.id;
      if (todoId)
        this.expandedTodoIds.has(todoId)
          ? this.expandedTodoIds.delete(todoId)
          : this.expandedTodoIds.add(todoId);
    }
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

export function createLiveTodoModalComponent(options: {
  theme: TodoTheme;
  state: TodoState;
  requestRender: () => void;
  closeModal: () => void;
  getRows: () => number;
  refreshState: () => Promise<TodoState>;
  pollMs?: number;
}): TodoModalComponent {
  return new TodoModalComponent(
    options.theme,
    options.state,
    options.requestRender,
    options.closeModal,
    options.getRows,
    options.refreshState,
    options.pollMs,
  );
}

export async function openTodoModal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const svc = new TodoService(new PiTodoEventStore(pi, ctx));
  const state = await svc.state();
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      createLiveTodoModalComponent({
        theme,
        state,
        requestRender: () => tui.requestRender(),
        closeModal: () => done(),
        getRows: () => tui.terminal.rows,
        refreshState: () => svc.state(),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 54,
        maxHeight: `${Math.round(TODO_MODAL_MAX_HEIGHT_RATIO * 100)}%`,
        margin: 1,
        visible: (termWidth) => termWidth >= 54,
      },
    },
  );
}
