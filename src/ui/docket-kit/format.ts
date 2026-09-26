import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function leftRight(width: number, left: string, right: string): string[] {
  if (!right) return [truncateToWidth(left, width, "")];
  if (visibleWidth(left) + visibleWidth(right) + 1 <= width) {
    return [`${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`];
  }
  return [truncateToWidth(left, width, ""), truncateToWidth(right, width, "")];
}
