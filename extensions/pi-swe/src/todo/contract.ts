/** Stable public contract for pi-swe's unified todo capability. */
export const TODO_TEXT_LIMITS = Object.freeze({
  title: 256,
  todoId: 128,
  reason: 2_048,
  summary: 2_048,
} as const);

export const TODO_MAX_ITEMS = 1_000;

export const TODO_PUBLIC_ACTIONS = Object.freeze([
  "create",
  "move",
  "delete",
  "start",
  "finish",
  "block",
  "unblock",
  "list",
] as const);

export type TodoPublicAction = (typeof TODO_PUBLIC_ACTIONS)[number];

export const TODO_PUBLIC_STATUSES = Object.freeze([
  "ready",
  "in_progress",
  "external_blocked",
  "completed",
] as const);

export type TodoPublicStatus = (typeof TODO_PUBLIC_STATUSES)[number];

export const TODO_SCOPES = Object.freeze([
  "session",
  "project",
  "initiative",
  "all",
] as const);

export type TodoScope = (typeof TODO_SCOPES)[number];

export type TodoPublicItem = {
  id: string;
  title: string;
  status: TodoPublicStatus;
  parentTodoId?: string;
  blockedReason?: string;
};

type TodoScopedRequest = { scope?: TodoScope };

export type TodoPublicRequest = TodoScopedRequest & (
  | { action: "create"; title: string; parentTodoId?: string }
  | { action: "move"; todoId: string; beforeTodoId?: string; afterTodoId?: string }
  | { action: "delete"; todoId: string }
  | { action: "start"; todoId: string }
  | { action: "finish"; todoId?: string; summary?: string }
  | { action: "block"; todoId?: string; reason: string }
  | { action: "unblock"; todoId: string }
  | { action: "list" }
);

export const TODO_EXCLUDED_CAPABILITIES = Object.freeze([
  "dependency-scheduling",
  "leases-and-claims",
  "splitting",
  "artifact-writing",
  "startup-filesystem-scans",
  "autonomous-follow-up",
] as const);

export function isTodoPublicAction(value: unknown): value is TodoPublicAction {
  return typeof value === "string" && (TODO_PUBLIC_ACTIONS as readonly string[]).includes(value);
}

export function isTodoScope(value: unknown): value is TodoScope {
  return typeof value === "string" && (TODO_SCOPES as readonly string[]).includes(value);
}
