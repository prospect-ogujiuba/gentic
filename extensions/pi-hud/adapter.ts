import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSnapshot, withLiveUsage } from "./snapshot.ts";
import { COMPONENT_IDS, isComponentId, isPlacement, recordMessageUsage, recordMessagesUsage, resetConfig, resetSessionUsage, resetWorkTimer, startWorkTimer, state, stopWorkTimer } from "./state.ts";
import { createHudComponent } from "./surfaces/footer.ts";
import { openModal } from "./surfaces/modal.ts";

const TEST_COMMAND_RE = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)(\s|$)|\b(vitest|jest|pytest|ruff|eslint|tsc)\b/i;
const HUD_USAGE = "Usage: /pi-hud [open|show|hide|reset|placement footer|widget|both|toggle <component>|only <component>]";

type HudUiContext = Pick<ExtensionContext, "cwd" | "getContextUsage" | "hasUI" | "model" | "ui">;
type HudCommandContext = ExtensionCommandContext & HudUiContext;

function applyHud(ctx: HudUiContext): void {
  ctx.ui.setFooter(undefined);
  ctx.ui.setWidget("pi-hud", undefined);
  if (!state.enabled) return;

  const snapshot = createSnapshot(ctx);
  const liveSnapshot = () => withLiveUsage(snapshot, ctx);
  state.modal?.update(liveSnapshot());
  if (state.placement === "footer" || state.placement === "both") ctx.ui.setFooter(createHudComponent(liveSnapshot));
  if (state.placement === "widget" || state.placement === "both") ctx.ui.setWidget("pi-hud", createHudComponent(liveSnapshot));
}

function recordEvent(ctx: HudUiContext, name: string): void {
  state.recentEvents = [name, ...state.recentEvents.filter((event) => event !== name)].slice(0, 8);
  if (ctx.hasUI) applyHud(ctx);
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
  if (!cmd || cmd === "open" || cmd === "modal") return openModal(ctx);
  if (cmd === "show") state.enabled = true;
  else if (cmd === "hide") state.enabled = false;
  else if (cmd === "placement" && isPlacement(target)) state.placement = target;
  else if (cmd === "toggle" && isComponentId(target)) state.components[target] = !state.components[target];
  else if (cmd === "only" && isComponentId(target)) for (const id of COMPONENT_IDS) state.components[id] = id === target;
  else if (cmd === "reset") resetConfig();
  else {
    ctx.ui.notify(HUD_USAGE, "info");
    return;
  }
  applyHud(ctx);
  ctx.ui.notify(`pi-hud: ${state.enabled ? "enabled" : "hidden"}; placement=${state.placement}; components=${COMPONENT_IDS.filter((id) => state.components[id]).join(",")}`, "info");
}

export function registerHudEventHandlers(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => { state.agent = "idle"; resetWorkTimer(); resetSessionUsage(); recordEvent(ctx, event.type); });
  pi.on("model_select", (event, ctx) => recordEvent(ctx, event.type));
  pi.on("thinking_level_select", (event, ctx) => { state.thinkingLevel = event.level; recordEvent(ctx, event.type); });
  pi.on("agent_start", (event, ctx) => { state.agent = "thinking"; startWorkTimer(); recordEvent(ctx, event.type); });
  pi.on("agent_end", (event, ctx) => { state.agent = "idle"; state.activeTools = []; recordMessagesUsage(event.messages); stopWorkTimer(); recordEvent(ctx, event.type); });
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
  pi.on("session_shutdown", (_event, ctx) => { stopWorkTimer(); ctx.ui.setFooter(undefined); ctx.ui.setWidget("pi-hud", undefined); });
}

export function registerHudCommand(pi: ExtensionAPI): void {
  pi.registerCommand("pi-hud", {
    description: "Configure and inspect the Visiplane-style Pi HUD",
    handler: async (args, ctx) => handleHudCommand(args, ctx as HudCommandContext),
  });
}
