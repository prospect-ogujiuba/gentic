import { compactCurrency, compactNumber, FRESH_COLOR, formatPercent, MUTED_WARNING_COLOR } from "../lib/format.ts";
import type { HudSnapshot, Theme } from "../types.ts";

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
