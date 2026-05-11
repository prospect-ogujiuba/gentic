import type { HudSnapshot, Theme } from "../types.ts";

export function renderModel(s: HudSnapshot, theme: Theme): string {
  const model = String(s.modelId ?? "no-model");
  return theme.fg("accent", model.includes("/") ? (model.split("/").pop() ?? model) : model);
}

export function renderThinkingLevel(s: HudSnapshot, theme: Theme): string {
  const level = s.thinkingLevel?.trim();
  return level ? `${theme.fg("dim", "(")}${theme.fg(level === "off" ? "dim" : "accent", level)}${theme.fg("dim", ")")}` : "";
}
