import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  prefixedCompletions,
  renderUsage,
  rootActionCompletions,
  type CommandActionSpec,
} from "../../../../src/command-guidance.ts";
import { isDisplayMode, resetConfig, setDisplayMode, state } from "../app/state.ts";
import { hudRuntime, type HudUiContext } from "./runtime.ts";

const TEST_COMMAND_RE = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)(\s|$)|\b(vitest|jest|pytest|ruff|eslint|tsc)\b/i;
const HUD_COMMAND_ACTIONS = [
  { action: "show", syntax: "/pi-hud show", description: "Show the optional HUD widget" },
  { action: "hide", syntax: "/pi-hud hide", description: "Hide the optional HUD widget" },
  { action: "reset", syntax: "/pi-hud reset", description: "Restore the default widget mode" },
  { action: "mode", syntax: "/pi-hud mode <off|widget-first>", description: "Set the widget mode" },
] as const satisfies readonly CommandActionSpec[];
const HUD_USAGE = renderUsage(HUD_COMMAND_ACTIONS);

type HudCommandContext = ExtensionCommandContext & HudUiContext;

function notify(ctx: HudCommandContext, message: string): void {
  if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(message, "info");
}

export function completeHudArgument(prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) return rootActionCompletions(normalized, HUD_COMMAND_ACTIONS);
  const command = normalized.slice(0, firstSpace);
  const query = normalized.slice(firstSpace + 1).trim();
  if (command !== "mode") return [];
  return prefixedCompletions("mode ", [
    { value: "off", label: "off", description: "Hide the HUD widget" },
    { value: "widget-first", label: "widget-first", description: "Show the widget and keep Pi's native footer" },
  ].filter((item) => item.value.startsWith(query)));
}

export function cleanupHud(ctx: HudUiContext): void { hudRuntime.shutdown(ctx); }
export function applyHud(ctx: HudUiContext): void { hudRuntime.apply(ctx); }

function setAgentForTool(toolName: string, args: unknown): void {
  const command = typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
  if (toolName === "read") state.agent = "reading";
  else if (toolName === "edit") state.agent = "editing";
  else if (toolName === "write") state.agent = "writing";
  else if (toolName === "bash" && typeof command === "string" && TEST_COMMAND_RE.test(command)) state.agent = "testing";
  else state.agent = "executing";
}

async function handleHudCommand(args: string, ctx: HudCommandContext): Promise<void> {
  const [cmd, target] = args.trim().split(/\s+/);
  let migrated = false;
  if (!cmd || cmd === "show") setDisplayMode("widget-first");
  else if (cmd === "hide") setDisplayMode("off");
  else if (cmd === "reset") resetConfig();
  else if (cmd === "mode" && target) {
    try {
      setDisplayMode(target);
      migrated = !isDisplayMode(target);
    } catch {
      notify(ctx, HUD_USAGE);
      return;
    }
  } else if (cmd === "open" || cmd === "modal" || (cmd === "placement" && target)) {
    setDisplayMode("widget-first");
    migrated = true;
  } else {
    notify(ctx, HUD_USAGE);
    return;
  }

  applyHud(ctx);
  notify(ctx, migrated ? "pi-hud: legacy surface migrated to widget-first" : `pi-hud: mode=${state.displayMode}`);
}

export function registerHudEventHandlers(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => { hudRuntime.start(ctx); hudRuntime.update(ctx, true); });
  pi.on("model_select", (_event, ctx) => hudRuntime.update(ctx));
  pi.on("agent_start", (_event, ctx) => { state.agent = "thinking"; hudRuntime.update(ctx); });
  pi.on("agent_end", (_event, ctx) => { state.agent = "idle"; state.activeTools = []; hudRuntime.update(ctx, true); });
  pi.on("agent_settled", (_event, ctx) => { state.agent = "idle"; state.activeTools = []; hudRuntime.update(ctx, true); });
  pi.on("turn_start", (_event, ctx) => { state.agent = "thinking"; hudRuntime.update(ctx); });
  pi.on("tool_execution_start", (event, ctx) => {
    state.activeTools.push({ id: event.toolCallId, toolName: event.toolName });
    setAgentForTool(event.toolName, event.args);
    hudRuntime.update(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    state.activeTools = state.activeTools.filter((tool) => tool.id !== event.toolCallId);
    state.agent = state.activeTools.length ? "executing" : "thinking";
    hudRuntime.update(ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => hudRuntime.shutdown(ctx));
}

export function registerHudCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pi-hud", {
    description: "/pi-hud [show|hide|reset|mode <off|widget-first>] — configure the optional Pi HUD widget",
    getArgumentCompletions: completeHudArgument,
    handler: async (args, ctx) => handleHudCommand(args, ctx as HudCommandContext),
  });
}
