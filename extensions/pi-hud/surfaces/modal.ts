import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentStatus } from "../components/agent.ts";
import { renderContextBar, renderUsageSummary } from "../components/context.ts";
import { renderGitStatus } from "../components/git.ts";
import { renderModel, renderThinkingLevel } from "../components/model.ts";
import { renderToolBadges, renderToolSummary } from "../components/tools.ts";
import { fitLeftRight } from "../lib/format.ts";
import { createSnapshot } from "../snapshot.ts";
import { state } from "../state.ts";
import type { HudSnapshot, Theme } from "../types.ts";

function sectionTitle(theme: Theme, title: string, width: number): string[] {
  const label = ` ${title} `;
  const fill = Math.max(0, width - visibleWidth(label));
  return [theme.fg("borderMuted", "─".repeat(Math.floor(fill / 2))) + theme.fg("accent", label) + theme.fg("borderMuted", "─".repeat(fill - Math.floor(fill / 2)))];
}

function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function framed(theme: Theme, width: number, title: string, body: string[]): string[] {
  const innerWidth = Math.max(24, width - 2);
  const titleText = ` ${title} `;
  const fill = Math.max(0, innerWidth - visibleWidth(titleText));
  const lines = [
    theme.fg("border", `╭${"─".repeat(Math.floor(fill / 2))}`) + theme.fg("accent", titleText) + theme.fg("border", `${"─".repeat(fill - Math.floor(fill / 2))}╮`),
  ];
  for (const line of body) {
    for (const wrapped of wrapTextWithAnsi(line, Math.max(8, innerWidth))) {
      lines.push(`${theme.fg("border", "│")}${padAnsi(wrapped, innerWidth)}${theme.fg("border", "│")}`);
    }
  }
  lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

function modalBody(s: HudSnapshot, theme: Theme, width: number): string[] {
  const bodyWidth = Math.max(24, width - 2);
  const modelLine = [renderModel(s, theme), renderThinkingLevel(s, theme), renderContextBar(s, theme)].filter(Boolean).join(theme.fg("dim", "  "));
  const lines = bodyWidth >= 84
    ? [fitLeftRight(bodyWidth, modelLine, renderUsageSummary(s, theme)), fitLeftRight(bodyWidth, renderGitStatus(s, theme), renderAgentStatus(s, theme))]
    : [modelLine, renderUsageSummary(s, theme), renderGitStatus(s, theme), renderAgentStatus(s, theme)];

  const badges = renderToolBadges(s, theme);
  const summary = renderToolSummary(s, theme);
  lines.push(...sectionTitle(theme, "tools", bodyWidth));
  if (badges) lines.push(badges);
  if (summary) lines.push(summary);
  lines.push(...sectionTitle(theme, "session", bodyWidth), `turn ${state.turn} · ${s.worktreeId}`);
  return lines;
}

class PiHudModalComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private scrollOffset = 0;

  constructor(
    private theme: Theme,
    private snapshot: HudSnapshot,
    private requestRender: () => void,
    private close: () => void,
    private getRows: () => number,
  ) {}

  update(snapshot: HudSnapshot): void {
    this.snapshot = snapshot;
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const all = framed(this.theme, Math.max(32, width), "Pi HUD", modalBody(this.snapshot, this.theme, Math.max(32, width)));
    const maxLines = Math.max(8, Math.floor(this.getRows() * 0.82));
    const maxOffset = Math.max(0, all.length - maxLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visible = all.length > maxLines
      ? [...all.slice(this.scrollOffset, this.scrollOffset + maxLines - 1), this.theme.fg("dim", `↑↓ scroll · esc close · ${this.scrollOffset + 1}-${Math.min(all.length, this.scrollOffset + maxLines - 1)}/${all.length}`)]
      : all;
    this.cachedWidth = width;
    this.cachedLines = visible;
    return visible;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.close();
    if (matchesKey(data, Key.down)) this.scrollOffset += 1;
    if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export async function openModal(ctx: ExtensionCommandContext): Promise<void> {
  let component: PiHudModalComponent | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      component = new PiHudModalComponent(theme, createSnapshot(ctx), () => tui.requestRender(), () => done(), () => tui.terminal.rows);
      state.modal = component;
      return component;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "82%", minWidth: 54, maxHeight: "86%", margin: 1, visible: (termWidth) => termWidth >= 54 },
    });
  } finally {
    if (state.modal === component) state.modal = undefined;
  }
}
