import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function leftRight(width: number, left: string, right = ""): string {
  if (!right) return truncateToWidth(left, width, "");
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 >= width) return truncateToWidth(`${left} ${right}`, width, "");
  return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

export function wrap(width: number, text: string, indent = ""): string[] {
  return wrapTextWithAnsi(text, Math.max(8, width - visibleWidth(indent))).map((line) => truncateToWidth(`${indent}${line}`, width, ""));
}
