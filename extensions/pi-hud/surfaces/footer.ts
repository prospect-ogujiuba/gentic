import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWorktime } from "../components/worktime.ts";
import { renderContextBar, renderPiContextLedgerSummary, renderUsageSummary } from "../components/context.ts";
import { renderHarnessEvents } from "../components/events.ts";
import { renderGitStatus } from "../components/git.ts";
import { renderModel, renderThinkingLevel } from "../components/model.ts";
import { renderToolBadges, renderToolSummary } from "../components/tools.ts";
import { state } from "../state.ts";
import type { HudSnapshot, Theme } from "../types.ts";
import { cleanTruncate, fitLeftRight, fitResponsive, stripAnsi } from "../lib/format.ts";

function compactContextBar(line: string): string {
  const match = stripAnsi(line).match(/([\d.]+[kM]?\/[\d.]+[kM]?)\s+([\d.]+%|--)/);
  return match ? `${match[1]} ${match[2]}` : line;
}

function compactGitStatus(line: string, width: number): string[] {
  const parts = line.split(/\s+\x1b\[[0-9;]*m·\x1b\[[0-9;]*m\s+|\s+·\s+/).filter(Boolean);
  return [
    parts,
    parts.filter((part) => !stripAnsi(part).startsWith("fetched ")),
    parts.filter((part) => !/^(fetched |untracked |unstaged )/.test(stripAnsi(part))),
  ].map((candidate) => candidate.join(" · ")).filter((candidate) => candidate && visibleWidth(candidate) <= width);
}

function fitToolLine(width: number, badges: string, summary: string): string {
  if (!badges) return cleanTruncate(summary, width);
  if (!summary) return cleanTruncate(badges, width);
  if (visibleWidth(badges) + 1 + visibleWidth(summary) <= width) return cleanTruncate(fitLeftRight(width, badges, summary), width);

  const badgeParts = badges.split(/\s+(?=\x1b\[[0-9;]*m?\[|\[)/).filter(Boolean);
  for (let count = badgeParts.length - 1; count > 0; count -= 1) {
    const kept = badgeParts.slice(0, count).join(" ");
    if (visibleWidth(kept) + 1 + visibleWidth(summary) <= width) return fitLeftRight(width, kept, summary);
  }
  return cleanTruncate(summary, width);
}

export function renderFooterLines(s: HudSnapshot, theme: Theme, width: number): string[] {
  const modelThinking = [state.components.model ? renderModel(s, theme) : "", state.components.model ? renderThinkingLevel(s, theme) : ""].filter(Boolean).join(theme.fg("dim", " "));
  const context = state.components.context ? renderContextBar(s, theme) : "";
  const ledger = state.components.context ? renderPiContextLedgerSummary(s, theme) : "";
  const lineOne = fitResponsive(width, [
    [modelThinking, context, ledger].filter(Boolean).join(theme.fg("dim", "  ")),
    [modelThinking, compactContextBar(context), ledger].filter(Boolean).join(theme.fg("dim", "  ")),
    [modelThinking, compactContextBar(context)].filter(Boolean).join(theme.fg("dim", "  ")),
    modelThinking,
  ], [state.components.context ? renderUsageSummary(s, theme) : ""]);

  const gitFull = state.components.git ? renderGitStatus(s, theme) : "";
  const gitCandidates = [gitFull, ...compactGitStatus(gitFull, width)].filter((value, index, all) => value && all.indexOf(value) === index);
  const lineTwo = fitResponsive(width, gitCandidates.length ? gitCandidates : [gitFull], [state.components.worktime ? renderWorktime(s, theme) : ""]);
  const lineThree = state.components.tools ? fitToolLine(width, renderToolBadges(s, theme), renderToolSummary(s, theme)) : "";
  const eventLine = state.components.events ? cleanTruncate(renderHarnessEvents(s, theme), width) : "";
  return [lineOne, lineTwo, lineThree, eventLine].filter(Boolean);
}

export function createHudComponent(s: HudSnapshot) {
  return (tui: { requestRender?: () => void }, theme: Theme) => {
    const timer = state.components.worktime ? setInterval(() => tui.requestRender?.(), 1000) : undefined;
    return {
      dispose() {
        if (timer) clearInterval(timer);
      },
      invalidate() {},
      render(width: number): string[] {
        return renderFooterLines(s, theme, width);
      },
    };
  };
}
