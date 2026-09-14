import type { DisplayMode, HudState } from "../../types.ts";

export const DISPLAY_MODES = ["off", "widget-first"] as const satisfies readonly DisplayMode[];
export const DEFAULT_DISPLAY_MODE: DisplayMode = "widget-first";

export const state: HudState = {
  displayMode: DEFAULT_DISPLAY_MODE,
  agent: "idle",
  activeTools: [],
};

export function isDisplayMode(value: string | undefined): value is DisplayMode {
  return DISPLAY_MODES.includes(value as DisplayMode);
}

export function resolveDisplayModeConfig(value: unknown): DisplayMode {
  if (value === undefined || value === null) return DEFAULT_DISPLAY_MODE;
  if (typeof value === "string") {
    if (isDisplayMode(value)) return value;
    if (value === "widget" || value === "both" || value === "footer") return "widget-first";
    throw new TypeError(`Invalid pi-hud display mode: ${value}`);
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid pi-hud configuration: expected an object");

  const config = value as { displayMode?: unknown; enabled?: unknown; placement?: unknown };
  if (config.displayMode !== undefined) return resolveDisplayModeConfig(config.displayMode);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new TypeError("Invalid pi-hud configuration: enabled must be boolean");
  if (config.enabled === false) return "off";
  if (config.placement !== undefined) {
    if (typeof config.placement !== "string") throw new TypeError("Invalid pi-hud configuration: placement must be a string");
    return resolveDisplayModeConfig(config.placement);
  }
  return DEFAULT_DISPLAY_MODE;
}

export function setDisplayMode(value: unknown): void {
  state.displayMode = resolveDisplayModeConfig(value);
}

export function resetConfig(): void {
  state.displayMode = DEFAULT_DISPLAY_MODE;
}

export function resetHudState(): void {
  resetConfig();
  state.agent = "idle";
  state.activeTools = [];
}
