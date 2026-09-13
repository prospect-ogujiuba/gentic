import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMPONENT_IDS, isComponentId, isDisplayMode, recordMessageUsage, recordMessagesUsage, resetConfig, setDisplayMode, startWorkTimer, state, stopWorkTimer } from "../app/state.ts";
import { openModal } from "../ui/surfaces/modal.ts";
import { hudRuntime, type HudUiContext } from "./runtime.ts";

const TEST_COMMAND_RE = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)(\s|$)|\b(vitest|jest|pytest|ruff|eslint|tsc)\b/i;
const HUD_USAGE = "Usage: /pi-hud [open|show|hide|reset|mode off|widget-first|footer|placement footer|widget|both|toggle <component>|only <component>]";
const HUD_COMMAND_COMPLETIONS = [
  { value: "open", label: "open", description: "Open the detailed HUD modal · /pi-hud open" },
  { value: "show", label: "show", description: "Show the HUD using widget-first mode if hidden · /pi-hud show" },
  { value: "hide", label: "hide", description: "Disable persistent HUD display · /pi-hud hide" },
  { value: "reset", label: "reset", description: "Restore default HUD mode and components · /pi-hud reset" },
  { value: "mode", label: "mode", description: "Select display mode · /pi-hud mode <off|widget-first|footer>" },
  { value: "placement", label: "placement", description: "Select HUD placement · /pi-hud placement <footer|widget|both>" },
  { value: "toggle", label: "toggle", description: "Toggle one component · /pi-hud toggle <component>" },
  { value: "only", label: "only", description: "Show only one component · /pi-hud only <component>" },
] as const;

type HudCommandContext = ExtensionCommandContext & HudUiContext;

export function completeHudArgument(prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace < 0) {
    return HUD_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized)).map((item) => ({ ...item }));
  }
  const command = normalized.slice(0, firstSpace);
  const query = normalized.slice(firstSpace + 1).trim();
  const values = command === "mode"
    ? [
        { value: "off", description: "Disable persistent HUD display" },
        { value: "widget-first", description: "Keep Pi's native footer and render the HUD as a widget (default)" },
        { value: "footer", description: "Replace Pi's native footer with the HUD" },
      ]
    : command === "placement"
      ? [
          { value: "footer", description: "Render in the footer" },
          { value: "widget", description: "Render as a widget" },
          { value: "both", description: "Render in both supported placements" },
        ]
      : command === "toggle" || command === "only"
        ? COMPONENT_IDS.map((value) => ({ value, description: command === "toggle" ? `Toggle the ${value} component` : `Show only the ${value} component` }))
        : [];
  return values.filter((item) => item.value.startsWith(query)).map((item) => ({
    value: `${command} ${item.value}`,
    label: item.value,
    description: item.description,
  }));
}

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
    description: "/pi-hud [open|show|hide|reset|mode <off|widget-first|footer>|placement <footer|widget|both>|toggle <component>|only <component>] — configure the Pi HUD",
    getArgumentCompletions: completeHudArgument,
    handler: async (args, ctx) => handleHudCommand(args, ctx as HudCommandContext),
  });
}
