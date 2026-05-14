import { compactCurrency, compactNumber, FRESH_COLOR, formatPercent, MUTED_WARNING_COLOR } from "../lib/format.ts";
import type { HudSnapshot, Theme } from "../../../types.ts";

const CONTEXT_BAR_WIDTH = 16;

function contextColor(pct: number | undefined): string {
  if (pct === undefined) return FRESH_COLOR;
  if (pct >= 90) return "error";
  if (pct >= 60) return MUTED_WARNING_COLOR;
  return FRESH_COLOR;
}

export function renderContextBar(s: HudSnapshot, theme: Theme): string {
  const usage = s.usage;
  if (!usage || usage.contextWindow === undefined || usage.contextPct === undefined) {
    return [theme.fg("dim", "░".repeat(CONTEXT_BAR_WIDTH)), theme.fg("dim", "--/--"), theme.fg("dim", "--")].join(" ");
  }
  const pct = Math.max(0, Math.min(100, usage.contextPct));
  const filled = Math.max(0, Math.min(CONTEXT_BAR_WIDTH, Math.round((pct / 100) * CONTEXT_BAR_WIDTH)));
  const color = contextColor(pct);
  const tokens = compactNumber(usage.contextTokens ?? usage.totalTokens);
  return `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(CONTEXT_BAR_WIDTH - filled))} ${theme.fg("text", `${tokens}/${compactNumber(usage.contextWindow)}`)} ${theme.fg(color, formatPercent(pct) ?? "--")}`;
}

export function renderUsageSummary(s: HudSnapshot, theme: Theme): string {
  const u = s.usage;
  if (!u) return [`${theme.fg("dim", "IN")} ${theme.fg("dim", "--")}`, `${theme.fg("dim", "OUT")} ${theme.fg("dim", "--")}`, theme.fg("dim", "$--")].join("  ");
  return [`${theme.fg("dim", "IN")} ${theme.fg("text", compactNumber(u.input))}`, `${theme.fg("dim", "OUT")} ${theme.fg("text", compactNumber(u.output))}`, theme.fg(MUTED_WARNING_COLOR, compactCurrency(u.cost))].join("  ");
}

export function renderPiContextLedgerSummary(s: HudSnapshot, theme: Theme): string {
  const ledger = s.piContext;
  if (!ledger?.available) return theme.fg("dim", "ledger --");
  const total = compactNumber(ledger.totalTokens);
  const remaining = ledger.remainingTokens === undefined ? "left --" : `left ${compactNumber(ledger.remainingTokens)}`;
  const largest = ledger.largestGroup ? `hot ${ledger.largestGroup.label}` : "hot --";
  return [theme.fg("dim", "ledger"), theme.fg("text", total), theme.fg(contextColor(contextPercent(ledger.totalTokens, ledger.contextWindowTokens)), remaining), theme.fg("dim", largest)].join(" ");
}

export function renderPiContextLedgerDetails(s: HudSnapshot, theme: Theme): string[] {
  const ledger = s.piContext;
  if (!ledger?.available) return [theme.fg("dim", "pi-context ledger unavailable")];
  const lines = [renderPiContextLedgerSummary(s, theme)];
  if (ledger.recentCompaction) {
    const saved = ledger.recentCompaction.savedTokens === undefined ? "unknown saved" : `${compactNumber(ledger.recentCompaction.savedTokens)} saved`;
    lines.push(`${theme.fg("dim", "compaction")} ${theme.fg("text", `${compactNumber(ledger.recentCompaction.beforeTokens)} → ${compactNumber(ledger.recentCompaction.afterTokens)}`)} ${theme.fg(FRESH_COLOR, saved)}`);
  }
  if (ledger.contributors.length) {
    lines.push(`${theme.fg("dim", "contributors")} ${ledger.contributors.map((entry) => `${entry.label} ${compactNumber(entry.tokenCount)}`).join(theme.fg("dim", " · "))}`);
  }
  if (ledger.warnings.length) lines.push(`${theme.fg(MUTED_WARNING_COLOR, "warnings")} ${ledger.warnings.length}${ledger.truncatedWarnings ? ` (+${ledger.truncatedWarnings})` : ""}`);
  return lines;
}

function contextPercent(tokens: number | undefined, window: number | undefined): number | undefined {
  if (tokens === undefined || window === undefined || window <= 0) return undefined;
  return (tokens / window) * 100;
}
