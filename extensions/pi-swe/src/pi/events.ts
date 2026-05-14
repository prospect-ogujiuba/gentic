import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyFacts, emitWarnings, loadSessionRuntime, resetTurnRuntime, type PiSweRuntime } from "../app/runtime.ts";
import { classifyToolCall, classifyToolResult } from "../domain/classify.ts";

export function registerSweEvents(pi: ExtensionAPI, runtime: PiSweRuntime): void {
  pi.on("session_start", (_event, ctx) => {
    loadSessionRuntime(runtime, pi, ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    resetTurnRuntime(runtime, ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    const facts = classifyToolCall({ toolName: event.toolName, input: event.input });
    applyFacts(runtime, facts);
    emitWarnings(ctx, runtime, facts);
  });

  pi.on("tool_result", (event, ctx) => {
    const facts = classifyToolResult({ toolName: event.toolName, input: event.input, result: { exitCode: detailNumber(event.details, "exitCode") ?? detailNumber(event.details, "code") ?? (event.isError ? 1 : 0) } });
    applyFacts(runtime, facts);
    emitWarnings(ctx, runtime, facts);
  });
}

function detailNumber(details: unknown, key: string): number | undefined {
  return details && typeof details === "object" && typeof (details as Record<string, unknown>)[key] === "number" ? (details as Record<string, number>)[key] : undefined;
}
