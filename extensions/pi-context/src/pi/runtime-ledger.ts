import { createHash } from "node:crypto";
import path from "node:path";
import type {
  InputEvent,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { byteLength, calculateCompactionStats, normalizeLedgerEntry, type ContextLedgerEntry, type ContextSourceKind, type TokenConfidence } from "../domain/index.ts";
import type { PiContextUsageSnapshot } from "../app/index.ts";

export type RuntimeLedgerContext = {
  at?: string;
  turnId?: string;
};

export type RuntimeCompactionInput = RuntimeLedgerContext & {
  count: number;
  before?: Omit<PiContextUsageSnapshot, "capturedAt" | "event">;
  after?: Omit<PiContextUsageSnapshot, "capturedAt" | "event">;
};

export type RuntimeLedgerResult = {
  entries: ContextLedgerEntry[];
  warnings: string[];
};

export function collectRuntimeInput(event: Pick<InputEvent, "text" | "source" | "images">, context: RuntimeLedgerContext = {}): RuntimeLedgerResult {
  const at = context.at ?? new Date().toISOString();
  const imageBytes = (event.images ?? []).reduce((total, image) => total + estimateValueBytes(image), 0);
  const textBytes = byteLength(event.text ?? "");
  return {
    warnings: [],
    entries: [
      normalizeLedgerEntry({
        id: `runtime:input:${hashText(`${event.source}:${at}:${textBytes}:${imageBytes}`).slice(0, 16)}`,
        kind: "user",
        label: `${event.source} user input`,
        origin: "input",
        byteCount: textBytes + imageBytes,
        tokenConfidence: "estimated",
        seenAt: at,
        turnId: context.turnId,
        sourceMetadata: {
          resourceType: "message",
          source: event.source,
          origin: "input",
          contentStored: false,
          operation: "input",
          eventType: "input",
          sizeEstimate: textBytes + imageBytes,
          pathCount: 0,
        },
        redaction: { redacted: true, reason: "runtime input content is not stored", originalByteCount: textBytes + imageBytes },
      }),
    ],
  };
}

export function collectRuntimeMessage(
  eventType: MessageStartEvent["type"] | MessageUpdateEvent["type"] | MessageEndEvent["type"],
  message: MessageStartEvent["message"],
  context: RuntimeLedgerContext = {},
): RuntimeLedgerResult {
  const at = context.at ?? new Date().toISOString();
  const measured = measureMessage(message);
  const role = readStringProperty(message, "role") ?? "message";
  const isFinal = eventType === "message_end";
  const usageTotalTokens = role === "assistant" ? readAssistantUsageTokens(message) : undefined;
  const usageWarning = usageTotalTokens === undefined ? undefined : "message usage.totalTokens is cumulative context usage and is excluded from entry tokens";
  const warning = [measured.warning, usageWarning].filter(Boolean).join("; ") || undefined;
  const tokenConfidence: TokenConfidence = measured.warning ? "unknown" : "estimated";
  return {
    warnings: usageWarning ? [usageWarning] : [],
    entries: [
      normalizeLedgerEntry({
        id: `runtime:message:${messageIdentity(message)}`,
        kind: classifyMessageKind(role),
        label: `${role} message`,
        origin: `message.${role}`,
        byteCount: measured.byteCount,
        tokenConfidence,
        seenAt: at,
        turnId: context.turnId,
        messageId: messageIdentity(message),
        sourceMetadata: {
          resourceType: "message",
          eventType,
          operation: isFinal ? "message_final" : "message_update",
          contentStored: false,
          sizeEstimate: measured.byteCount,
          pathCount: 0,
          status: "present",
          warning,
        },
        redaction: { redacted: true, reason: "runtime message content is not stored", originalByteCount: measured.byteCount },
      }),
    ],
  };
}

export function collectRuntimeToolExecutionStart(event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args">, context: RuntimeLedgerContext = {}): RuntimeLedgerResult {
  return collectRuntimeTool({
    at: context.at,
    turnId: context.turnId,
    eventType: "tool_execution_start",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.args,
    executionStatus: "started",
  });
}

export function collectRuntimeToolExecutionEnd(event: Pick<ToolExecutionEndEvent, "toolCallId" | "toolName" | "result" | "isError">, context: RuntimeLedgerContext = {}): RuntimeLedgerResult {
  return collectRuntimeTool({
    at: context.at,
    turnId: context.turnId,
    eventType: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: event.result,
    isError: event.isError,
    executionStatus: event.isError ? "error" : "success",
  });
}

export function collectRuntimeToolResult(event: Pick<ToolResultEvent, "toolCallId" | "toolName" | "input" | "content" | "details" | "isError">, context: RuntimeLedgerContext = {}): RuntimeLedgerResult {
  return collectRuntimeTool({
    at: context.at,
    turnId: context.turnId,
    eventType: "tool_result",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    result: event.content,
    details: event.details,
    isError: event.isError,
    executionStatus: event.isError ? "error" : "success",
  });
}

export function collectRuntimeCompaction(input: RuntimeCompactionInput): RuntimeLedgerResult {
  const at = input.at ?? new Date().toISOString();
  const beforeTokens = input.before?.tokens;
  const afterTokens = input.after?.tokens;
  const stats = calculateCompactionStats(beforeTokens, afterTokens, input.after?.tokenConfidence ?? input.before?.tokenConfidence ?? "unknown");
  const warnings = beforeTokens === undefined || afterTokens === undefined ? ["compaction before/after token usage was not fully exposed by Pi"] : [];
  const byteCount = byteLength(JSON.stringify({ beforeTokens, afterTokens, count: input.count }));
  return {
    warnings,
    entries: [
      normalizeLedgerEntry({
        id: `runtime:compaction:${input.count}`,
        kind: "compaction",
        label: `Compaction ${input.count}`,
        origin: "session_compact",
        byteCount,
        tokenConfidence: stats.tokenConfidence,
        seenAt: at,
        turnId: input.turnId,
        sourceMetadata: {
          resourceType: "compaction",
          operation: "compact",
          eventType: "session_compact",
          contentStored: false,
          status: beforeTokens === undefined || afterTokens === undefined ? "unknown" : "present",
          compactionCount: input.count,
          beforeTokens,
          afterTokens,
          deltaTokens: stats.deltaTokens,
          savedTokens: stats.savedTokens,
          warning: warnings[0],
        },
      }),
    ],
  };
}

function collectRuntimeTool(input: {
  at?: string;
  turnId?: string;
  eventType: "tool_execution_start" | "tool_execution_end" | "tool_result";
  toolCallId: string;
  toolName: string;
  input?: unknown;
  result?: unknown;
  details?: unknown;
  isError?: boolean;
  executionStatus: "started" | "success" | "error";
}): RuntimeLedgerResult {
  const at = input.at ?? new Date().toISOString();
  const tool = classifyTool(input.toolName, input.input, input.result, input.details);
  const argumentByteCount = estimateValueBytes(input.input);
  const resultByteCount = estimateValueBytes(input.result);
  const detailsByteCount = estimateValueBytes(input.details);
  const resultText = extractText(input.result);
  const warningCount = countMatches(resultText, /\bwarn(?:ing)?\b/gi) + tool.warnings.length;
  const errorCount = (input.isError ? 1 : 0) + countMatches(resultText, /\berror\b/gi);
  const warnings = [...tool.warnings];
  if (input.isError) warnings.push(`${input.toolName} reported an error`);

  const entries: ContextLedgerEntry[] = [
    normalizeLedgerEntry({
      id: `runtime:tool:${input.toolCallId}`,
      kind: "tool",
      label: input.toolName,
      origin: input.toolName,
      byteCount: argumentByteCount + resultByteCount + detailsByteCount,
      tokenConfidence: "estimated",
      seenAt: at,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      sourceMetadata: {
        resourceType: "tool_call",
        displayPath: tool.paths[0],
        toolName: input.toolName,
        operation: tool.operation,
        eventType: input.eventType,
        executionStatus: input.executionStatus,
        contentStored: false,
        pathCount: tool.paths.length,
        paths: tool.paths,
        argumentByteCount,
        resultByteCount,
        detailByteCount: detailsByteCount,
        warningCount,
        errorCount,
        status: input.executionStatus === "error" ? "error" : "present",
        warning: warnings[0],
      },
      redaction: { redacted: true, reason: "runtime tool arguments and results are not stored", originalByteCount: argumentByteCount + resultByteCount + detailsByteCount },
    }),
  ];

  for (const file of tool.files) {
    entries.push(
      normalizeLedgerEntry({
        id: `runtime:${file.kind}:${input.toolCallId}:${hashText(`${file.operation}:${file.path}`).slice(0, 16)}`,
        kind: file.kind,
        label: path.basename(file.path) || file.path,
        origin: file.path,
        byteCount: file.sizeEstimate,
        tokenConfidence: "estimated",
        seenAt: at,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        sourceMetadata: {
          resourceType: file.kind === "artifact" ? "artifact" : "file",
          displayPath: file.path,
          toolName: input.toolName,
          operation: file.operation,
          eventType: input.eventType,
          executionStatus: input.executionStatus,
          contentStored: false,
          pathCount: 1,
          paths: [file.path],
          sizeEstimate: file.sizeEstimate,
          warningCount,
          errorCount,
          status: input.executionStatus === "error" ? "error" : "present",
        },
      }),
    );
  }

  return { entries, warnings };
}

function classifyTool(toolName: string, input: unknown, result: unknown, details: unknown): {
  operation: string;
  paths: string[];
  files: Array<{ path: string; operation: string; kind: ContextSourceKind; sizeEstimate: number }>;
  warnings: string[];
} {
  const name = toolName.toLowerCase();
  const paths = extractPaths(input);
  const warnings: string[] = [];
  let operation = name;
  if (name === "read") operation = "read";
  else if (name === "edit") operation = "edit";
  else if (name === "write") operation = "write";
  else if (name === "bash") operation = "execute";
  else if (name === "todo") operation = `todo:${readStringProperty(input, "action") ?? "unknown"}`;
  else if (name.includes("context_mode") || name.startsWith("ctx_")) operation = name.includes("execute_file") ? "analyze_file" : name.includes("read") ? "read" : "context_mode";
  else if (name.includes("interactive_shell")) operation = "interactive_shell";

  if ((name === "read" || name === "edit" || name === "write") && paths.length === 0) warnings.push(`${toolName} path was not exposed`);

  const writeSize = name === "write" ? estimateValueBytes(readRecord(input)?.content) : 0;
  const resultSize = estimateValueBytes(result) + estimateValueBytes(details);
  const files = paths.map((filePath) => ({
    path: filePath,
    operation,
    kind: classifyPathKind(filePath),
    sizeEstimate: name === "write" ? writeSize : resultSize,
  }));
  return { operation, paths, files, warnings };
}

function classifyPathKind(filePath: string): ContextSourceKind {
  return filePath.includes(".model-artifacts/") || filePath.includes(".model-artifacts\\") ? "artifact" : "discovered";
}

function extractPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown, key = "", depth = 0): void => {
    if (depth > 5 || candidate === null || candidate === undefined || paths.size >= 25) return;
    if (typeof candidate === "string") {
      if (isPathKey(key) || looksLikeModelArtifact(candidate)) paths.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 50)) visit(item, key, depth + 1);
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [entryKey, entryValue] of Object.entries(candidate as Record<string, unknown>)) {
      if (isPathKey(entryKey)) visit(entryValue, entryKey, depth + 1);
      else if (entryKey === "evidence" || entryKey === "attachments") visit(entryValue, entryKey, depth + 1);
      else if (typeof entryValue === "object") visit(entryValue, entryKey, depth + 1);
    }
  };
  visit(value);
  return [...paths].sort();
}

function isPathKey(key: string): boolean {
  return /^(path|paths|file|files|filepath|filePath|url|urls)$/.test(key);
}

function looksLikeModelArtifact(value: string): boolean {
  return value.includes(".model-artifacts/") || value.includes(".model-artifacts\\");
}

function measureMessage(message: unknown): { byteCount: number; warning?: string } {
  const role = readStringProperty(message, "role");
  const content = readRecord(message)?.content;
  if (typeof content === "string") return { byteCount: byteLength(content) };
  if (Array.isArray(content)) return { byteCount: content.reduce((total, item) => total + measureContentItem(item), 0) };
  if (role === "assistant") return { byteCount: 0, warning: "assistant message content was not exposed" };
  return { byteCount: estimateValueBytes(content) };
}

function measureContentItem(item: unknown): number {
  const record = readRecord(item);
  if (!record) return estimateValueBytes(item);
  if (typeof record.text === "string") return byteLength(record.text);
  if (typeof record.thinking === "string") return byteLength(record.thinking);
  if (typeof record.data === "string") return byteLength(record.data);
  if (record.type === "toolCall") return estimateValueBytes(record.name) + estimateValueBytes(record.arguments);
  return estimateValueBytes(item);
}

function readAssistantUsageTokens(message: unknown): number | undefined {
  const usage = readRecord(readRecord(message)?.usage);
  const total = usage?.totalTokens;
  return typeof total === "number" ? total : undefined;
}

function messageIdentity(message: unknown): string {
  const record = readRecord(message);
  const role = readStringProperty(record, "role") ?? "unknown";
  const timestamp = readNumberProperty(record, "timestamp");
  const responseId = readStringProperty(record, "responseId");
  const toolCallId = readStringProperty(record, "toolCallId");
  if (responseId) return `${role}:${responseId}`;
  if (toolCallId) return `${role}:${toolCallId}`;
  if (timestamp !== undefined) return `${role}:${timestamp}`;
  return `${role}:${hashText(JSON.stringify({ role, size: estimateValueBytes(record?.content) })).slice(0, 16)}`;
}

function classifyMessageKind(role: string): ContextSourceKind {
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "session";
}

function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return byteLength(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return byteLength(String(value));
  if (depth > 5) return 0;
  if (Array.isArray(value)) return value.slice(0, 100).reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
  if (typeof value === "object") {
    let total = 0;
    let count = 0;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      total += byteLength(key) + estimateValueBytes(nested, depth + 1);
      count += 1;
      if (count >= 100) break;
    }
    return total;
  }
  return 0;
}

function extractText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 3) return "";
  if (typeof value === "string") return value.slice(0, 50_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => extractText(item, depth + 1)).join("\n").slice(0, 50_000);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.slice(0, 50_000);
    if (typeof record.content === "string") return record.content.slice(0, 50_000);
    return Object.values(record).slice(0, 50).map((item) => extractText(item, depth + 1)).join("\n").slice(0, 50_000);
  }
  return "";
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readStringProperty(value: unknown, property: string): string | undefined {
  const candidate = readRecord(value)?.[property];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readNumberProperty(value: unknown, property: string): number | undefined {
  const candidate = readRecord(value)?.[property];
  return typeof candidate === "number" ? candidate : undefined;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
