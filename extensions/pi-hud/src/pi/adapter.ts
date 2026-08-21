import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMPONENT_IDS, isComponentId, isDisplayMode, recordMessageUsage, recordMessagesUsage, resetConfig, setDisplayMode, startWorkTimer, state, stopWorkTimer } from "../app/state.ts";
import { openModal } from "../ui/surfaces/modal.ts";
import { hudRuntime, type HudUiContext } from "./runtime.ts";

const TEST_COMMAND_RE = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)(\s|$)|\b(vitest|jest|pytest|ruff|eslint|tsc)\b/i;
const HUD_USAGE = "Usage: /pi-hud [open|show|hide|reset|mode off|widget-first|footer|placement footer|widget|both|toggle <component>|only <component>]";

type HudCommandContext = ExtensionCommandContext & HudUiContext;

export function cleanupHud(ctx: HudUiContext): void {
  hudRuntime.shutdown(ctx);
}

export function applyHud(ctx: HudUiContext): void {
  hudRuntime.apply(ctx);
}

function recordEvent(ctx: HudUiContext, name: string): void {
  hudRuntime.recordEvent(ctx, name);
}

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
  if (!cmd || cmd === "open" || cmd === "modal") {
    if (ctx.mode === "tui") return openModal(ctx, hudRuntime);
    if (ctx.mode === "rpc") ctx.ui.notify("pi-hud: modal is available only in TUI mode", "info");
    return;
  }
  if (cmd === "show") {
    if (state.displayMode === "off") setDisplayMode("widget-first");
  } else if (cmd === "hide") setDisplayMode("off");
  else if (cmd === "mode" && isDisplayMode(target)) setDisplayMode(target);
  else if (cmd === "placement" && (target === "footer" || target === "widget" || target === "both")) setDisplayMode(target);
  else if (cmd === "toggle" && isComponentId(target)) state.components[target] = !state.components[target];
  else if (cmd === "only" && isComponentId(target)) for (const id of COMPONENT_IDS) state.components[id] = id === target;
  else if (cmd === "reset") resetConfig();
  else {
    if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(HUD_USAGE, "info");
    return;
  }
  applyHud(ctx);
  if (ctx.mode === "tui" || ctx.mode === "rpc") {
    ctx.ui.notify(`pi-hud: mode=${state.displayMode}; components=${COMPONENT_IDS.filter((id) => state.components[id]).join(",")}`, "info");
  }
}

export function registerHudEventHandlers(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => { hudRuntime.start(ctx); recordEvent(ctx, event.type); });
  pi.on("session_info_changed", (event, ctx) => recordEvent(ctx, event.type));
  pi.on("model_select", (event, ctx) => recordEvent(ctx, event.type));
  pi.on("thinking_level_select", (event, ctx) => { state.thinkingLevel = event.level; recordEvent(ctx, event.type); });
  pi.on("agent_start", (event, ctx) => { state.agent = "thinking"; startWorkTimer(); recordEvent(ctx, event.type); });
  pi.on("agent_end", (event, ctx) => { state.agent = "idle"; state.activeTools = []; recordMessagesUsage(event.messages); stopWorkTimer(); recordEvent(ctx, event.type); });
  pi.on("agent_settled", (event, ctx) => { state.agent = "idle"; state.activeTools = []; stopWorkTimer(); recordEvent(ctx, event.type); });
  pi.on("turn_start", (event, ctx) => { state.turn = event.turnIndex; state.agent = "thinking"; recordEvent(ctx, event.type); });
  pi.on("tool_execution_start", (event, ctx) => {
    state.activeTools.push({ id: event.toolCallId, toolName: event.toolName, args: event.args as Record<string, unknown> });
    state.toolCounts[event.toolName] = (state.toolCounts[event.toolName] ?? 0) + 1;
    setAgentForTool(event.toolName, event.args);
    recordEvent(ctx, event.type);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    state.activeTools = state.activeTools.filter((tool) => tool.id !== event.toolCallId);
    event.isError ? state.errorCalls += 1 : state.successCalls += 1;
    state.agent = state.activeTools.length ? "executing" : "thinking";
    recordEvent(ctx, event.type);
  });
  pi.on("tool_result", (event, ctx) => {
    if (!event.isError && JSON.stringify(event.content).toLowerCase().includes("warning")) state.warningCalls += 1;
    recordEvent(ctx, event.type);
  });
  pi.on("message_end", (event, ctx) => { recordMessageUsage(event.message); recordEvent(ctx, event.type); });
  pi.on("session_shutdown", (_event, ctx) => hudRuntime.shutdown(ctx));
}

export function registerHudCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pi-hud", {
    description: "Configure and inspect the Visiplane-style Pi HUD",
    handler: async (args, ctx) => handleHudCommand(args, ctx as HudCommandContext),
  });
}
