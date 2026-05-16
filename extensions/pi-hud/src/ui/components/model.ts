import type { HudSnapshot, Theme } from "../../../types.ts";

export function renderProvider(s: HudSnapshot, theme: Theme): string {
  const model = String(s.modelId ?? "");
  const provider = model.includes("/") ? model.split("/")[0] : undefined;
  return theme.fg("dim", provider || "no-provider");
}

export function renderModel(s: HudSnapshot, theme: Theme): string {
  const model = String(s.modelId ?? "no-model");
  return theme.fg("accent", model.includes("/") ? (model.split("/").pop() ?? model) : model);
}

export function renderThinkingLevel(s: HudSnapshot, theme: Theme): string {
  const level = s.thinkingLevel?.trim();
  return level ? `${theme.fg("dim", "(")}${theme.fg(level === "off" ? "dim" : "accent", level)}${theme.fg("dim", ")")}` : "";
}
