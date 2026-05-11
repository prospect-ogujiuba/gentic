import { normalizeSwePath } from "./state.ts";
import type { VerificationScope } from "./evidence.ts";

export type PiSweClassification = {
  stage?: string;
  confidence: number;
};

export type ToolPayload = {
  toolName?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
};

export type InspectionFact = {
  kind: "inspection";
  path: string;
  toolName: string;
};

export type CodeChangeFact = {
  kind: "code_change";
  path?: string;
  toolName: string;
  writeMode?: "new" | "existing" | "unknown";
  broad?: boolean;
  command?: string;
};

export type VerificationFact = {
  kind: "verification";
  toolName: string;
  command: string;
  exitCode?: number;
  scope: VerificationScope;
};

export type TodoCompletionFact = {
  kind: "todo_completion_attempt";
  toolName: string;
  todoId?: string;
};

export type PiSweFact = InspectionFact | CodeChangeFact | VerificationFact | TodoCompletionFact;

export function unclassified(): PiSweClassification {
  return { confidence: 0 };
}

export function classifyToolCall(payload: ToolPayload): PiSweFact[] {
  const toolName = normalizeToolName(payload.toolName ?? payload.name);
  const args = asRecord(payload.args ?? payload.input);
  if (!toolName) return [];

  const inspection = classifyInspectionCall(toolName, args);
  if (inspection) return [inspection];

  const change = classifyChangeCall(toolName, args);
  if (change) return [change];

  const todoCompletion = classifyTodoCompletionCall(toolName, args);
  if (todoCompletion) return [todoCompletion];

  return [];
}

export function classifyToolResult(payload: ToolPayload): PiSweFact[] {
  const toolName = normalizeToolName(payload.toolName ?? payload.name);
  const args = asRecord(payload.args ?? payload.input);
  if (!toolName) return [];

  const verification = classifyVerificationResult(toolName, args, payload.result);
  return verification ? [verification] : [];
}

function classifyInspectionCall(toolName: string, args: Record<string, unknown>): InspectionFact | undefined {
  if (["read", "functions.read"].includes(toolName)) {
    return pathFact("inspection", toolName, stringProp(args, "path") ?? stringProp(args, "filePath"));
  }

  if (["ctx_execute_file", "context_mode_ctx_execute_file", "functions.ctx_execute_file", "functions.context_mode_ctx_execute_file"].includes(toolName)) {
    return pathFact("inspection", toolName, stringProp(args, "path"));
  }

  const command = stringProp(args, "command");
  if (command && isPathSpecificSearch(command)) {
    return pathFact("inspection", toolName, lastCommandPath(command));
  }

  return undefined;
}

function classifyChangeCall(toolName: string, args: Record<string, unknown>): CodeChangeFact | undefined {
  if (["edit", "functions.edit"].includes(toolName)) {
    const path = stringProp(args, "path") ?? stringProp(args, "filePath");
    return path ? { kind: "code_change", toolName, path: normalizeSwePath(path), writeMode: "existing" } : undefined;
  }

  if (["write", "functions.write"].includes(toolName)) {
    const path = stringProp(args, "path") ?? stringProp(args, "filePath");
    const existed = booleanProp(args, "existed") ?? booleanProp(args, "alreadyExists") ?? booleanProp(args, "isExistingFile");
    return path ? { kind: "code_change", toolName, path: normalizeSwePath(path), writeMode: existed === undefined ? "unknown" : existed ? "existing" : "new" } : undefined;
  }

  const command = stringProp(args, "command");
  if (command && isBroadChangeCommand(command)) {
    return { kind: "code_change", toolName, broad: true, command };
  }

  return undefined;
}

function classifyVerificationResult(toolName: string, args: Record<string, unknown>, result: unknown): VerificationFact | undefined {
  const command = stringProp(args, "command");
  if (!command || !isVerificationCommand(command)) return undefined;

  return {
    kind: "verification",
    toolName,
    command,
    exitCode: extractExitCode(result),
    scope: classifyVerificationScope(command),
  };
}

function classifyTodoCompletionCall(toolName: string, args: Record<string, unknown>): TodoCompletionFact | undefined {
  if (!["todo", "functions.todo"].includes(toolName)) return undefined;
  const action = stringProp(args, "action");
  if (!["complete", "done", "task.done"].includes(action ?? "")) return undefined;
  return { kind: "todo_completion_attempt", toolName, todoId: stringProp(args, "todoId") ?? stringProp(args, "id") };
}

function pathFact(kind: "inspection", toolName: string, path: string | undefined): InspectionFact | undefined {
  return path ? { kind, toolName, path: normalizeSwePath(path) } : undefined;
}

function isPathSpecificSearch(command: string): boolean {
  if (!/\b(rg|grep|find)\b/.test(command)) return false;
  if (/(^|\s)\.(\s|$)|\$\(|`|--files\b/.test(command)) return false;
  return lastCommandPath(command) !== undefined;
}

function lastCommandPath(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const candidates = tokens.filter((token) => !token.startsWith("-") && /[/.]/.test(token) && !/^['\"]?\.{1,2}['\"]?$/.test(token));
  const path = candidates.at(-1)?.replace(/^['\"]|['\"]$/g, "");
  return path && !/[|;&]/.test(path) ? path : undefined;
}

function isBroadChangeCommand(command: string): boolean {
  return /\b(prettier|eslint|ruff|black|gofmt|cargo\s+fmt|npm\s+run\s+format)\b/.test(command) && /(--write|--fix|\bformat\b|\bfmt\b)/.test(command);
}

function isVerificationCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|node\s+--test|npm\s+run\s+check|tsc|typecheck|cargo\s+test|go\s+test)\b/.test(command);
}

function classifyVerificationScope(command: string): VerificationScope {
  if (/\b(test|src)\/[\w./-]+\.(test|spec)?\.[cm]?[jt]sx?\b|\bnode\s+--test\s+\S+/.test(command)) return "focused";
  if (/\b(test|src)\//.test(command)) return "nearby";
  return "broad";
}

function extractExitCode(result: unknown): number | undefined {
  const record = asRecord(result);
  const direct = numberProp(record, "exitCode") ?? numberProp(record, "code") ?? numberProp(record, "status");
  if (direct !== undefined) return direct;
  const nested = asRecord(record.result);
  return numberProp(nested, "exitCode") ?? numberProp(nested, "code") ?? numberProp(nested, "status");
}

function normalizeToolName(toolName: string | undefined): string {
  return (toolName ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanProp(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberProp(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
