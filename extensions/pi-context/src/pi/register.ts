import type {
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionInfoChangedEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

type ModelSelectEvent = { model: unknown };
type ResourcesDiscoverEvent = { type: "resources_discover"; cwd: string; reason: "startup" | "reload" };

import {
  loadEffectiveContextConfig,
  type LoadEffectiveContextConfigOptions,
  type LoadEffectiveContextConfigResult,
} from "../config/index.ts";
import {
  clearLedgerEntries,
  createPiContextReportSnapshot,
  getSessionState,
  parsePiContextReportArgs,
  piContextHelpText,
  recordLedgerEntries,
  renderPiContextSummary,
  resetSessionState,
  startSessionState,
  updateSessionState,
  writePiContextReportArtifact,
  type PiContextLifecycleEventType,
  type PiContextSessionMetadata,
  type PiContextSessionState,
  type PiContextUsageSnapshot,
  type UpdateSessionStateInput,
} from "../app/index.ts";
import {
  collectRuntimeCompaction,
  collectRuntimeInput,
  collectRuntimeMessage,
  collectRuntimeToolExecutionEnd,
  collectRuntimeToolExecutionStart,
  collectRuntimeToolExecutionUpdate,
  collectRuntimeToolResult,
  type RuntimeLedgerResult,
} from "./runtime-ledger.ts";
import { collectStaticInventoryFromBeforeAgentStart } from "./static-inventory.ts";

export const MESSAGE_UPDATE_SAMPLE_RATE = 8;

export type RegisterPiContextOptions = {
  now?: () => number;
  loadConfig?: (options?: LoadEffectiveContextConfigOptions) => LoadEffectiveContextConfigResult;
};

const PI_CONTEXT_COMPLETIONS = [
  { value: "summary", label: "summary", description: "Show the maintained context summary · /pi-context summary [groups...]" },
  { value: "artifact", label: "artifact", description: "Write an expanded Markdown report · /pi-context artifact [groups...]" },
  { value: "open", label: "open", description: "Alias for writing an expanded report · /pi-context open [groups...]" },
  { value: "json", label: "json", description: "Write deterministic JSON for downstream use · /pi-context json [groups...]" },
  { value: "help", label: "help", description: "Show command syntax and group filters · /pi-context help" },
  { value: "system", label: "system", description: "Include only system-context entries" },
  { value: "user", label: "user", description: "Include only user-message context entries" },
  { value: "project", label: "project", description: "Include only project-context entries" },
  { value: "extensions", label: "extensions", description: "Include only extension-provided context entries" },
  { value: "session", label: "session", description: "Include only session-context entries" },
  { value: "tools", label: "tools", description: "Include only tool context entries" },
  { value: "artifacts", label: "artifacts", description: "Include only discovered artifact entries" },
  { value: "compaction", label: "compaction", description: "Include only compaction observations" },
] as const;

export function completePiContextArgument(prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const trailingSpace = /\s$/.test(normalized);
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  const query = trailingSpace ? "" : tokens.at(-1) ?? "";
  const completed = trailingSpace ? tokens : tokens.slice(0, -1);
  if (completed.includes("help")) return [];
  const hasMode = completed.some((token) => ["summary", "artifact", "open", "json", "help"].includes(token));
  return PI_CONTEXT_COMPLETIONS
    .filter((item) => !completed.includes(item.value) && item.value.startsWith(query))
    .filter((item) => !hasMode || !["summary", "artifact", "open", "json", "help"].includes(item.value))
    .map((item) => ({ value: [...completed, item.value].join(" "), label: item.label, description: item.description }));
}

export function registerPiContext(pi: ExtensionAPI, options: RegisterPiContextOptions = {}): void {
  const now = options.now ?? Date.now;
  const loadConfig = options.loadConfig ?? loadEffectiveContextConfig;
  let currentTurnId: string | undefined;
  let compactCount = 0;
  let beforeCompactUsage: Omit<PiContextUsageSnapshot, "capturedAt" | "event"> | undefined;
  let pendingInputs: Array<{ event: Pick<InputEvent, "text" | "source" | "images">; at: string }> = [];
  let messageUpdateCount = 0;
  let suppressedMessageUpdates = 0;
  const toolCalls = new Map<string, { args?: unknown; result?: unknown; details?: unknown }>();

  const resetRuntimeClosure = (): void => {
    currentTurnId = undefined;
    compactCount = 0;
    beforeCompactUsage = undefined;
    pendingInputs = [];
    messageUpdateCount = 0;
    suppressedMessageUpdates = 0;
    toolCalls.clear();
  };

  const beginSession = (
    ctx: ExtensionContext,
    input: Omit<Parameters<typeof startSessionState>[0], "metadata" | "pressurePolicy" | "nowMs">,
  ): PiContextSessionState => {
    const loaded = loadConfig({ cwd: ctx.cwd });
    const state = startSessionState({
      ...input,
      metadata: readSessionMetadata(ctx),
      pressurePolicy: loaded.config.pressure,
      nowMs: now(),
      warnings: [
        ...(input.warnings ?? []),
        ...loaded.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`),
      ],
    });
    notifyPressure(state, ctx);
    return state;
  };

  const ensureRuntimeStarted = (ctx: ExtensionContext, event: PiContextLifecycleEventType, reason?: string): void => {
    const state = getSessionState();
    if (state?.active) return;
    beginSession(ctx, {
      reason: reason ?? `lazy:${event}`,
      warnings: [`${event} observed before session_start; initialized at earliest available hook`],
    });
  };

  const observeUsage = (
    ctx: ExtensionContext,
    input: Omit<UpdateSessionStateInput, "usageSnapshot" | "nowMs">,
  ): PiContextSessionState => {
    const state = updateSessionState({ ...input, usageSnapshot: readUsageSnapshot(ctx), nowMs: now() });
    notifyPressure(state, ctx);
    return state;
  };

  pi.registerCommand("pi-context", {
    description: "/pi-context [summary|artifact|open|json|help] [system|user|project|extensions|session|tools|artifacts|compaction] — inspect or export the context ledger",
    getArgumentCompletions: completePiContextArgument,
    handler: async (args, ctx) => {
      ensureRuntimeStarted(ctx, "context", "command:/pi-context");
      observeUsage(ctx, { event: "context", reason: "command:/pi-context", metadata: readSessionMetadata(ctx) });
      const request = parsePiContextReportArgs(args);
      if (request.help) {
        ctx.ui.notify(piContextHelpText(), "info");
        return;
      }

      const snapshot = createPiContextReportSnapshot(getSessionState(), { cwd: ctx.cwd });
      if (request.mode === "artifact") {
        const artifact = writePiContextReportArtifact(snapshot, request, { cwd: ctx.cwd });
        ctx.ui.notify(`${renderPiContextSummary(snapshot, request)}\nArtifact: ${artifact.relativePath}`, request.warnings.length ? "warning" : "info");
        return;
      }

      ctx.ui.notify(renderPiContextSummary(snapshot, request), request.warnings.length ? "warning" : "info");
    },
  });

  pi.on("session_start", (event, ctx) => {
    resetRuntimeClosure();
    beginSession(ctx, {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      usageSnapshot: readUsageSnapshot(ctx),
    });
  });

  pi.on("resources_discover", (event, ctx) => {
    ensureRuntimeStarted(ctx, "resources_discover", event.reason);
    observeUsage(ctx, {
      event: "resources_discover",
      reason: event.reason,
      metadata: { cwd: event.cwd, ...readSessionMetadata(ctx) },
    });
  });

  pi.on("input", (event, ctx) => {
    ensureRuntimeStarted(ctx, "input");
    observeUsage(ctx, { event: "input", metadata: readSessionMetadata(ctx) });
    const at = new Date().toISOString();
    const pending = { event: { text: event.text, source: event.source, images: event.images }, at };
    pendingInputs.push(pending);
    // Record immediately without a turn rather than assigning new input to the previous turn.
    recordRuntime(collectRuntimeInput(pending.event, { at }));
  });

  pi.on("before_agent_start", (event, ctx) => {
    ensureRuntimeStarted(ctx, "before_agent_start");
    observeUsage(ctx, { event: "before_agent_start", metadata: readSessionMetadata(ctx) });
    const inventory = collectStaticInventoryFromBeforeAgentStart(event, { cwd: ctx.cwd });
    recordLedgerEntries({ entries: inventory.entries, warnings: inventory.warnings });
  });

  pi.on("agent_start", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "agent_start");
    observeUsage(ctx, { event: "agent_start", metadata: readSessionMetadata(ctx) });
  });

  pi.on("agent_end", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "agent_end");
    observeUsage(ctx, { event: "agent_end", metadata: readSessionMetadata(ctx) });
  });

  pi.on("agent_settled", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "agent_settled");
    observeUsage(ctx, { event: "agent_settled", metadata: readSessionMetadata(ctx) });
    currentTurnId = undefined;
  });

  pi.on("turn_start", (event, ctx) => {
    currentTurnId = `turn-${event.turnIndex}`;
    ensureRuntimeStarted(ctx, "turn_start");
    observeUsage(ctx, { event: "turn_start", metadata: readSessionMetadata(ctx) });
    for (const pending of pendingInputs) recordRuntime(collectRuntimeInput(pending.event, { at: pending.at, turnId: currentTurnId }));
    pendingInputs = [];
  });

  pi.on("turn_end", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "turn_end");
    observeUsage(ctx, { event: "turn_end", metadata: readSessionMetadata(ctx) });
  });

  pi.on("context", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "context");
    observeUsage(ctx, { event: "context", metadata: readSessionMetadata(ctx) });
  });

  pi.on("before_provider_request", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "before_provider_request");
    observeUsage(ctx, { event: "before_provider_request", metadata: readSessionMetadata(ctx) });
  });

  pi.on("message_start", (event, ctx) => {
    messageUpdateCount = 0;
    suppressedMessageUpdates = 0;
    ensureRuntimeStarted(ctx, "message_start");
    observeUsage(ctx, { event: "message_start", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeMessage("message_start", event.message, { turnId: currentTurnId }));
  });

  pi.on("message_update", (event, ctx) => {
    messageUpdateCount += 1;
    if (messageUpdateCount % MESSAGE_UPDATE_SAMPLE_RATE !== 0) {
      suppressedMessageUpdates += 1;
      return;
    }
    ensureRuntimeStarted(ctx, "message_update");
    observeUsage(ctx, { event: "message_update", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeMessage("message_update", event.message, { turnId: currentTurnId }));
  });

  pi.on("message_end", (event, ctx) => {
    ensureRuntimeStarted(ctx, "message_end");
    observeUsage(ctx, { event: "message_end", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeMessage("message_end", event.message, {
      turnId: currentTurnId,
      uncollectedEventCount: suppressedMessageUpdates || undefined,
    }));
    messageUpdateCount = 0;
    suppressedMessageUpdates = 0;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    toolCalls.set(event.toolCallId, { args: event.args });
    ensureRuntimeStarted(ctx, "tool_execution_start");
    observeUsage(ctx, { event: "tool_execution_start", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeToolExecutionStart(event, { turnId: currentTurnId }));
  });

  pi.on("tool_execution_update", (event, ctx) => {
    const lifecycle = toolCalls.get(event.toolCallId) ?? {};
    lifecycle.args = lifecycle.args ?? event.args;
    lifecycle.result = event.partialResult;
    toolCalls.set(event.toolCallId, lifecycle);
    ensureRuntimeStarted(ctx, "tool_execution_update");
    updateSessionState({ event: "tool_execution_update", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeToolExecutionUpdate({ ...event, args: lifecycle.args, partialResult: lifecycle.result }, { turnId: currentTurnId }));
  });

  pi.on("tool_result", (event, ctx) => {
    const lifecycle = toolCalls.get(event.toolCallId) ?? {};
    lifecycle.args = event.input ?? lifecycle.args;
    lifecycle.result = event.content;
    lifecycle.details = event.details;
    toolCalls.set(event.toolCallId, lifecycle);
    ensureRuntimeStarted(ctx, "tool_result");
    observeUsage(ctx, { event: "tool_result", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeToolResult(event, { turnId: currentTurnId }));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const lifecycle = toolCalls.get(event.toolCallId) ?? {};
    lifecycle.result = event.result ?? lifecycle.result;
    ensureRuntimeStarted(ctx, "tool_execution_end");
    observeUsage(ctx, { event: "tool_execution_end", metadata: readSessionMetadata(ctx) });
    recordRuntime(collectRuntimeToolExecutionEnd({ ...event, result: lifecycle.result }, { turnId: currentTurnId, input: lifecycle.args, details: lifecycle.details }));
    toolCalls.delete(event.toolCallId);
  });

  pi.on("session_info_changed", (_event, ctx) => {
    ensureRuntimeStarted(ctx, "session_info_changed");
    updateSessionState({ event: "session_info_changed", metadata: readSessionMetadata(ctx) });
  });

  pi.on("session_tree", (_event, ctx) => {
    currentTurnId = undefined;
    pendingInputs = [];
    toolCalls.clear();
    clearLedgerEntries();
    ensureRuntimeStarted(ctx, "session_tree");
    observeUsage(ctx, { event: "session_tree", metadata: readSessionMetadata(ctx) });
  });

  pi.on("session_before_switch", (event) => {
    updateSessionState({ event: "session_before_switch", reason: event.reason });
  });

  pi.on("session_before_fork", () => {
    updateSessionState({ event: "session_before_fork" });
  });

  pi.on("session_before_compact", (_event, ctx) => {
    beforeCompactUsage = readUsageSnapshot(ctx);
    const state = updateSessionState({
      event: "session_before_compact",
      metadata: readSessionMetadata(ctx),
      usageSnapshot: beforeCompactUsage,
      nowMs: now(),
    });
    notifyPressure(state, ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    compactCount += 1;
    const after = readUsageSnapshot(ctx);
    const state = updateSessionState({
      event: "session_compact",
      metadata: readSessionMetadata(ctx),
      usageSnapshot: after,
      nowMs: now(),
    });
    notifyPressure(state, ctx);
    recordRuntime(collectRuntimeCompaction({ count: compactCount, before: beforeCompactUsage, after, turnId: currentTurnId }));
    beforeCompactUsage = undefined;
  });

  pi.on("session_shutdown", (event) => {
    resetRuntimeClosure();
    resetSessionState(event.reason);
  });

  pi.on("model_select", (event, ctx) => {
    updateSessionState({ event: "model_select", reason: event.source, metadata: readSessionMetadata(ctx, event) });
  });

  function recordRuntime(result: RuntimeLedgerResult): void {
    recordLedgerEntries({ entries: result.entries, warnings: result.warnings });
  }
}

function notifyPressure(state: PiContextSessionState, ctx: ExtensionContext): void {
  const evaluation = state.pressure.evaluation;
  if (!evaluation?.shouldNotify || evaluation.remainingPercent === undefined || !evaluation.notification) return;
  const remaining = formatRemainingPercent(evaluation.remainingPercent);
  if (evaluation.notification === "critical") {
    ctx.ui.notify(
      `Context pressure critical: ${remaining}% remaining. Compact or start a new session before continuing.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    `Context pressure warning: ${remaining}% remaining. Consider finishing the current task or compacting soon.`,
    "warning",
  );
}

function formatRemainingPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readSessionMetadata(ctx: ExtensionContext, modelEvent?: ModelSelectEvent): PiContextSessionMetadata {
  const sessionManager = ctx.sessionManager;
  const model = modelEvent?.model ?? ctx.model;
  return {
    sessionId: safeString(() => sessionManager.getSessionId()),
    sessionFile: safeString(() => sessionManager.getSessionFile()),
    sessionDir: safeString(() => sessionManager.getSessionDir()),
    cwd: ctx.cwd ?? safeString(() => sessionManager.getCwd()),
    worktree: ctx.cwd ?? safeString(() => sessionManager.getCwd()),
    modelProvider: readStringProperty(model, "provider") ?? readStringProperty(model, "providerId"),
    modelId: readStringProperty(model, "id"),
    modelName: readStringProperty(model, "name"),
    contextWindow: readNumberProperty(model, "contextWindow"),
  };
}

function readUsageSnapshot(ctx: ExtensionContext): Omit<PiContextUsageSnapshot, "capturedAt" | "event"> | undefined {
  const usage = safeValue(() => ctx.getContextUsage());
  if (!usage) return undefined;
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : undefined,
    contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : undefined,
    percent: typeof usage.percent === "number" ? usage.percent : undefined,
    tokenConfidence: typeof usage.tokens === "number" ? "exact" : "unknown",
  };
}

function safeString(read: () => string | undefined): string | undefined {
  const value = safeValue(read);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readNumberProperty(value: unknown, property: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "number" ? candidate : undefined;
}

export type PiContextObservedEvent =
  | SessionStartEvent
  | SessionInfoChangedEvent
  | SessionTreeEvent
  | ResourcesDiscoverEvent
  | InputEvent
  | BeforeAgentStartEvent
  | ContextEvent
  | BeforeProviderRequestEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | ToolResultEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent;
