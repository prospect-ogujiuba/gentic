import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const MUTED_WARNING_COLOR = "syntaxString";
export const FRESH_COLOR = "syntaxComment";

export function compactNumber(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "--";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function compactCurrency(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "$--";
}

export function formatPercent(n: number | undefined): string | undefined {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)}%` : undefined;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function cleanTruncate(text: string, width: number): string {
  return truncateToWidth(text, width, "").replace(/\x1b\[0m$/, "");
}

export function fitLeftRight(width: number, left: string, right: string): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + 1 + rightWidth <= width) return left + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + right;
  if (rightWidth + 1 >= width) return truncateToWidth(right, width);
  return truncateToWidth(left, Math.max(1, width - rightWidth - 1)) + " " + right;
}

export function fitResponsive(width: number, leftCandidates: string[], rightCandidates: string[]): string {
  for (const left of leftCandidates) {
    for (const right of rightCandidates) {
      if (!left) return right;
      if (!right) return left;
      if (visibleWidth(left) + 1 + visibleWidth(right) <= width) return cleanTruncate(fitLeftRight(width, left, right), width);
    }
  }
  return cleanTruncate([leftCandidates.at(-1), rightCandidates.at(-1)].filter(Boolean).join(" "), width);
}
