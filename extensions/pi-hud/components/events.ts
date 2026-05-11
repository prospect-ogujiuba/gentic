import { MUTED_WARNING_COLOR } from "../lib/format.ts";
import type { HudSnapshot, Theme } from "../types.ts";

function shortEventName(name: string): string {
  return name.replace(/^tool_execution_/, "tool_").replace(/^session_/, "sess_").replace(/^message_/, "msg_");
}

export function renderHarnessEvents(s: HudSnapshot, theme: Theme): string {
  const events = s.recentEvents.slice(0, 5);
  if (!events.length) return "";
  const chips = events.map((event, i) => theme.fg(i === 0 ? "accent" : "dim", `${i === 0 ? "◆" : "◇"} `) + theme.fg(i === 0 ? MUTED_WARNING_COLOR : "muted", shortEventName(event)));
  return `${theme.fg("dim", "Events | ")}${chips.join(theme.fg("dim", " "))}`;
}
