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
  ModelSelectEvent,
  ResourcesDiscoverEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionStartEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
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
  type PiContextUsageSnapshot,
} from "../app/index.ts";
import {
  collectRuntimeCompaction,
  collectRuntimeInput,
  collectRuntimeMessage,
  collectRuntimeToolExecutionEnd,
  collectRuntimeToolExecutionStart,
  collectRuntimeToolResult,
  type RuntimeLedgerResult,
} from "./runtime-ledger.ts";
import { collectStaticInventoryFromBeforeAgentStart } from "./static-inventory.ts";

export function registerPiContext(pi: ExtensionAPI): void {
  let currentTurnId: string | undefined;
  let compactCount = 0;
  let beforeCompactUsage: Omit<PiContextUsageSnapshot, "capturedAt" | "event"> | undefined;

  pi.registerCommand("pi-context", {
    description: "Show the maintained context ledger summary or write report artifacts",
    getArgumentCompletions: (prefix) =>
      ["summary", "artifact", "open", "json", "system", "user", "project", "extensions", "session", "tools", "artifacts", "compaction"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      ensureStarted(ctx, "context", "command:/pi-context");
      updateSessionState({ event: "context", reason: "command:/pi-context", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
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
    startSessionState({
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      metadata: readSessionMetadata(ctx),
      usageSnapshot: readUsageSnapshot(ctx),
    });
  });

  pi.on("resources_discover", (event, ctx) => {
    ensureStarted(ctx, "resources_discover", event.reason);
    updateSessionState({
      event: "resources_discover",
      reason: event.reason,
      metadata: { cwd: event.cwd, ...readSessionMetadata(ctx) },
      usageSnapshot: readUsageSnapshot(ctx),
    });
  });

  pi.on("input", (event, ctx) => {
    ensureStarted(ctx, "input");
    updateSessionState({ event: "input", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeInput(event, { turnId: currentTurnId }));
  });

  pi.on("before_agent_start", (event, ctx) => {
    ensureStarted(ctx, "before_agent_start");
    updateSessionState({ event: "before_agent_start", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    const inventory = collectStaticInventoryFromBeforeAgentStart(event, { cwd: ctx.cwd });
    recordLedgerEntries({ entries: inventory.entries, warnings: inventory.warnings });
  });

  pi.on("agent_start", (_event, ctx) => {
    ensureStarted(ctx, "agent_start");
    updateSessionState({ event: "agent_start", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("agent_end", (_event, ctx) => {
    ensureStarted(ctx, "agent_end");
    updateSessionState({ event: "agent_end", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("turn_start", (event, ctx) => {
    currentTurnId = `turn-${event.turnIndex}`;
    ensureStarted(ctx, "turn_start");
    updateSessionState({ event: "turn_start", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("turn_end", (_event, ctx) => {
    ensureStarted(ctx, "turn_end");
    updateSessionState({ event: "turn_end", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("context", (_event, ctx) => {
    ensureStarted(ctx, "context");
    updateSessionState({ event: "context", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("before_provider_request", (_event, ctx) => {
    ensureStarted(ctx, "before_provider_request");
    updateSessionState({ event: "before_provider_request", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
  });

  pi.on("message_start", (event, ctx) => {
    ensureStarted(ctx, "message_start");
    updateSessionState({ event: "message_start", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeMessage("message_start", event.message, { turnId: currentTurnId }));
  });

  pi.on("message_update", (event, ctx) => {
    ensureStarted(ctx, "message_update");
    updateSessionState({ event: "message_update", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeMessage("message_update", event.message, { turnId: currentTurnId }));
  });

  pi.on("message_end", (event, ctx) => {
    ensureStarted(ctx, "message_end");
    updateSessionState({ event: "message_end", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeMessage("message_end", event.message, { turnId: currentTurnId }));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    ensureStarted(ctx, "tool_execution_start");
    updateSessionState({ event: "tool_execution_start", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeToolExecutionStart(event, { turnId: currentTurnId }));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    ensureStarted(ctx, "tool_execution_end");
    updateSessionState({ event: "tool_execution_end", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeToolExecutionEnd(event, { turnId: currentTurnId }));
  });

  pi.on("tool_result", (event, ctx) => {
    ensureStarted(ctx, "tool_result");
    updateSessionState({ event: "tool_result", metadata: readSessionMetadata(ctx), usageSnapshot: readUsageSnapshot(ctx) });
    recordRuntime(collectRuntimeToolResult(event, { turnId: currentTurnId }));
  });

  pi.on("session_before_switch", (event) => {
    updateSessionState({ event: "session_before_switch", reason: event.reason });
  });

  pi.on("session_before_fork", () => {
    updateSessionState({ event: "session_before_fork" });
  });

  pi.on("session_before_compact", (_event, ctx) => {
    beforeCompactUsage = readUsageSnapshot(ctx);
    updateSessionState({ event: "session_before_compact", metadata: readSessionMetadata(ctx), usageSnapshot: beforeCompactUsage });
  });

  pi.on("session_compact", (_event, ctx) => {
    compactCount += 1;
    const after = readUsageSnapshot(ctx);
    updateSessionState({ event: "session_compact", metadata: readSessionMetadata(ctx), usageSnapshot: after });
    recordRuntime(collectRuntimeCompaction({ count: compactCount, before: beforeCompactUsage, after, turnId: currentTurnId }));
    beforeCompactUsage = undefined;
  });

  pi.on("session_shutdown", (event) => {
    resetSessionState(event.reason);
  });

  pi.on("model_select", (event, ctx) => {
    updateSessionState({ event: "model_select", reason: event.source, metadata: readSessionMetadata(ctx, event) });
  });

  function recordRuntime(result: RuntimeLedgerResult): void {
    recordLedgerEntries({ entries: result.entries, warnings: result.warnings });
  }
}

function ensureStarted(ctx: ExtensionContext, event: PiContextLifecycleEventType, reason?: string): void {
  const state = getSessionState();
  if (state?.active) return;
  startSessionState({
    reason: reason ?? `lazy:${event}`,
    metadata: readSessionMetadata(ctx),
    usageSnapshot: readUsageSnapshot(ctx),
    warnings: [`${event} observed before session_start; initialized at earliest available hook`],
  });
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
  | ToolExecutionEndEvent
  | ToolResultEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent;
