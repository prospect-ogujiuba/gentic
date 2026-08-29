import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWorktime } from "../components/worktime.ts";
import { renderContextBar, renderPiContextLedgerSummary, renderUsageSummary } from "../components/context.ts";
import { renderHarnessEvents } from "../components/events.ts";
import { renderGitStatus } from "../components/git.ts";
import { renderModel, renderProvider, renderThinkingLevel } from "../components/model.ts";
import { renderToolBadges, renderToolSummary } from "../components/tools.ts";
import { state } from "../../app/state.ts";
import type { HudSnapshot, Theme } from "../../../types.ts";
import { cleanTruncate, fitLeftRight, fitResponsive, stripAnsi } from "../lib/format.ts";

type HudSnapshotSource = HudSnapshot | (() => HudSnapshot);
type RenderRequester = { requestRender?: () => void };

function resolveSnapshot(source: HudSnapshotSource): HudSnapshot {
  return typeof source === "function" ? source() : source;
}

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

function compactStatuses(statuses: string[], count: number): string {
  const kept = statuses.slice(0, count).join(" · ");
  const omitted = statuses.length - count;
  return omitted > 0 ? `${kept} +${omitted}` : kept;
}

function normalizeExtensionStatus(key: string, value: string): string {
  if (key !== "todo") return value;
  return value.replace(/(^todo\s+(?:active|next|blocked|completed)\s+|^)todo_[a-z0-9]+(?:_[a-z0-9]+)*:?\s*/i, "$1");
}

export function renderNativeFooterLine(footerData: ReadonlyFooterDataProvider, theme: Theme, width: number): string {
  if (width <= 0) return "";
  const branch = footerData.getGitBranch();
  const branchText = branch ? theme.fg("dim", `branch ${branch}`) : "";
  const statuses = [...footerData.getExtensionStatuses().entries()]
    .map(([key, value]) => normalizeExtensionStatus(key, value))
    .filter((value) => value.trim().length > 0);

  if (width < 24) return cleanTruncate(statuses[0] || branchText, width);
  for (let count = statuses.length; count > 0; count -= 1) {
    const statusText = compactStatuses(statuses, count);
    if (!branchText && visibleWidth(statusText) <= width) return statusText;
    if (branchText && visibleWidth(branchText) + 1 + visibleWidth(statusText) <= width) return fitLeftRight(width, branchText, statusText);
  }
  if (!statuses.length) return cleanTruncate(branchText, width);

  const statusBudget = Math.max(1, Math.floor(width * 0.6));
  const statusText = cleanTruncate(compactStatuses(statuses, 1), statusBudget);
  return cleanTruncate(fitLeftRight(width, branchText, statusText), width);
}

export function renderFooterLines(s: HudSnapshot, theme: Theme, width: number): string[] {
  const boundedWidth = Math.max(0, width);
  const providerModel = [state.components.provider ? renderProvider(s, theme) : "", state.components.model ? renderModel(s, theme) : ""].filter(Boolean).join(theme.fg("dim", "/"));
  const modelThinking = [providerModel, state.components.model ? renderThinkingLevel(s, theme) : ""].filter(Boolean).join(theme.fg("dim", " "));
  const context = state.components.context ? renderContextBar(s, theme) : "";
  const ledger = state.components.context ? renderPiContextLedgerSummary(s, theme) : "";
  const lineOne = fitResponsive(boundedWidth, [
    [modelThinking, context, ledger].filter(Boolean).join(theme.fg("dim", "  ")),
    [modelThinking, compactContextBar(context), ledger].filter(Boolean).join(theme.fg("dim", "  ")),
    [modelThinking, compactContextBar(context)].filter(Boolean).join(theme.fg("dim", "  ")),
    modelThinking,
  ], [state.components.context ? renderUsageSummary(s, theme) : ""]);

  const gitFull = state.components.git ? renderGitStatus(s, theme) : "";
  const gitCandidates = [gitFull, ...compactGitStatus(gitFull, boundedWidth)].filter((value, index, all) => value && all.indexOf(value) === index);
  const lineTwo = fitResponsive(boundedWidth, gitCandidates.length ? gitCandidates : [gitFull], [state.components.worktime ? renderWorktime(s, theme) : ""]);
  const lineThree = state.components.tools ? fitToolLine(boundedWidth, renderToolBadges(s, theme), renderToolSummary(s, theme)) : "";
  const eventLine = state.components.events && boundedWidth >= 48 ? cleanTruncate(renderHarnessEvents(s, theme), boundedWidth) : "";
  return [lineOne, lineTwo, lineThree, eventLine].filter(Boolean).map((line) => cleanTruncate(line, boundedWidth));
}

function createSurfaceComponent(source: HudSnapshotSource, tui: RenderRequester, theme: Theme, footerData?: ReadonlyFooterDataProvider) {
  const timer = state.components.worktime || state.components.context ? setInterval(() => tui.requestRender?.(), 1000) : undefined;
  const unsubscribe = footerData?.onBranchChange(() => tui.requestRender?.());
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      unsubscribe?.();
    },
    invalidate() {},
    render(width: number): string[] {
      const hudLines = renderFooterLines(resolveSnapshot(source), theme, width);
      if (!footerData) return hudLines;
      const nativeLine = renderNativeFooterLine(footerData, theme, width);
      return [nativeLine, ...hudLines].filter(Boolean);
    },
  };
}

export function createHudWidgetComponent(source: HudSnapshotSource) {
  return (tui: RenderRequester, theme: Theme) => createSurfaceComponent(source, tui, theme);
}

export function createHudFooterComponent(source: HudSnapshotSource) {
  return (tui: RenderRequester, theme: Theme, footerData: ReadonlyFooterDataProvider) => createSurfaceComponent(source, tui, theme, footerData);
}

export const createHudComponent = createHudWidgetComponent;
