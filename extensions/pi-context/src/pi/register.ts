import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createNativeContextSnapshot,
  renderNativeContextSummary,
  writeNativeContextExport,
} from "../app/index.ts";
import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  createContextPressureState,
  reduceContextPressure,
  type ContextPressurePolicy,
  type ContextPressureState,
  type ContextPressureUsage,
} from "../domain/index.ts";
import {
  loadEffectiveContextConfig,
  type LoadEffectiveContextConfigOptions,
  type LoadEffectiveContextConfigResult,
} from "../config/index.ts";

export type RegisterPiContextOptions = {
  now?: () => number;
  loadConfig?: (options?: LoadEffectiveContextConfigOptions) => LoadEffectiveContextConfigResult;
};

export type PiContextObservedEvent =
  | { type: "session_start" }
  | { type: "turn_end" }
  | { type: "session_compact" }
  | { type: "session_shutdown" };

const PI_CONTEXT_COMPLETIONS = [
  { value: "summary", label: "summary", description: "Show a fresh bounded context summary" },
  { value: "artifact", label: "artifact", description: "Write a content-safe Markdown report" },
  { value: "open", label: "open", description: "Alias for writing a Markdown report" },
  { value: "json", label: "json", description: "Write deterministic content-safe JSON" },
  { value: "help", label: "help", description: "Show command syntax" },
  { value: "system", label: "system", description: "Compatibility filter; contributors remain aggregate" },
  { value: "user", label: "user", description: "Compatibility filter; contributors remain aggregate" },
  { value: "project", label: "project", description: "Compatibility filter; contributors remain aggregate" },
  { value: "extensions", label: "extensions", description: "Compatibility filter; contributors remain aggregate" },
  { value: "session", label: "session", description: "Compatibility filter; contributors remain aggregate" },
  { value: "tools", label: "tools", description: "Compatibility filter; contributors remain aggregate" },
  { value: "artifacts", label: "artifacts", description: "Compatibility filter; contributors remain aggregate" },
  { value: "compaction", label: "compaction", description: "Compatibility filter; contributors remain aggregate" },
] as const;

export function completePiContextArgument(prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const trailingSpace = /\s$/.test(normalized);
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  const query = trailingSpace ? "" : tokens.at(-1)?.toLowerCase() ?? "";
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
  let policy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY;
  let pressureState: ContextPressureState = createContextPressureState();
  let configured = false;

  const configureSession = (ctx: Pick<ExtensionContext, "cwd">): void => {
    const loaded = loadConfig({ cwd: ctx.cwd });
    policy = loaded.config.pressure;
    pressureState = createContextPressureState();
    configured = true;
  };

  const beginSession = (ctx: Pick<ExtensionContext, "cwd" | "getContextUsage" | "ui">): void => {
    configureSession(ctx);
    observePressure(ctx);
  };

  const ensureSession = (ctx: Pick<ExtensionContext, "cwd">): void => {
    if (!configured) configureSession(ctx);
  };

  const observePressure = (ctx: Pick<ExtensionContext, "getContextUsage" | "ui">): void => {
    const transition = reduceContextPressure(pressureState, readPressureUsage(ctx), policy);
    pressureState = transition.state;
    notifyPressure(transition.evaluation.notification, transition.evaluation.remainingPercent, ctx);
  };

  pi.registerCommand("pi-context", {
    description: "/pi-context [summary|artifact|open|json|help] — inspect or explicitly export a bounded native context snapshot",
    getArgumentCompletions: completePiContextArgument,
    handler: async (args, ctx) => {
      ensureSession(ctx);
      const request = parseRequest(args);
      if (request === "help") {
        ctx.ui.notify(piContextHelpText(), "info");
        return;
      }

      const snapshot = createNativeContextSnapshot(ctx, {
        capturedAt: new Date(now()).toISOString(),
        pressurePolicy: policy,
      });
      const transition = reduceContextPressure(pressureState, usageFromSnapshot(snapshot), policy);
      pressureState = transition.state;
      notifyPressure(transition.evaluation.notification, transition.evaluation.remainingPercent, ctx);
      const pressured = {
        ...snapshot,
        pressure: transition.evaluation.available
          ? {
              available: true as const,
              level: transition.evaluation.level,
              remainingPercent: transition.evaluation.remainingPercent,
            }
          : { available: false as const, level: "unavailable" as const },
      };

      if (request === "markdown" || request === "json") {
        const artifact = writeNativeContextExport(pressured, { cwd: ctx.cwd, format: request });
        ctx.ui.notify(`${renderNativeContextSummary(pressured)}\nArtifact: ${artifact.relativePath}`, "info");
        return;
      }
      ctx.ui.notify(renderNativeContextSummary(pressured), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => beginSession(ctx));
  pi.on("turn_end", (_event, ctx) => {
    ensureSession(ctx);
    observePressure(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    ensureSession(ctx);
    observePressure(ctx);
  });
  pi.on("session_shutdown", () => {
    configured = false;
    policy = DEFAULT_CONTEXT_PRESSURE_POLICY;
    pressureState = createContextPressureState();
  });
}

function parseRequest(args: string): "summary" | "markdown" | "json" | "help" {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => token === "help" || token === "--help" || token === "-h")) return "help";
  if (tokens.some((token) => token === "json" || token === "--json")) return "json";
  if (tokens.some((token) => token === "artifact" || token === "open" || token === "report" || token === "markdown" || token === "md")) return "markdown";
  return "summary";
}

function piContextHelpText(): string {
  return [
    "pi-context",
    "Usage: /pi-context [summary|artifact|open|json|help]",
    "summary/default: build and show a fresh bounded native snapshot",
    "artifact/open: explicitly write a content-safe Markdown report",
    "json: explicitly write content-safe JSON",
  ].join("\n");
}

function readPressureUsage(ctx: Pick<ExtensionContext, "getContextUsage">): ContextPressureUsage | undefined {
  const usage = safeValue(() => ctx.getContextUsage());
  if (!usage) return undefined;
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : undefined,
    contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : undefined,
    percent: typeof usage.percent === "number" ? usage.percent : undefined,
    tokenConfidence: typeof usage.tokens === "number" || typeof usage.percent === "number" ? "estimated" : "unknown",
  };
}

function usageFromSnapshot(snapshot: ReturnType<typeof createNativeContextSnapshot>): ContextPressureUsage | undefined {
  if (snapshot.usage.usedTokens === undefined && snapshot.usage.remainingPercent === undefined) return undefined;
  return {
    tokens: snapshot.usage.usedTokens,
    contextWindow: snapshot.usage.contextWindowTokens,
    percent: snapshot.usage.remainingPercent === undefined ? undefined : 100 - snapshot.usage.remainingPercent,
    tokenConfidence: "estimated",
  };
}

function notifyPressure(
  notification: "warning" | "critical" | undefined,
  remainingPercent: number | undefined,
  ctx: Pick<ExtensionContext, "ui"> | Pick<ExtensionCommandContext, "ui">,
): void {
  if (!notification || remainingPercent === undefined) return;
  const remaining = Number.isInteger(remainingPercent) ? String(remainingPercent) : remainingPercent.toFixed(1);
  if (notification === "critical") {
    ctx.ui.notify(`Context pressure critical: ${remaining}% remaining. Compact or start a new session before continuing.`, "error");
    return;
  }
  ctx.ui.notify(`Context pressure warning: ${remaining}% remaining. Consider finishing the current task or compacting soon.`, "warning");
}

function safeValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
