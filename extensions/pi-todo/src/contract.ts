/** Stable public contract for the lightweight pi-todo replacement. */
export const TODO_TEXT_LIMITS = Object.freeze({
  title: 256,
  todoId: 128,
  reason: 2_048,
  summary: 2_048,
} as const);

export const TODO_MAX_ITEMS = 1_000;

export const TODO_PUBLIC_ACTIONS = Object.freeze([
  "create",
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

export type TodoPublicItem = {
  id: string;
  title: string;
  status: TodoPublicStatus;
  blockedReason?: string;
};

export type TodoPublicRequest =
  | { action: "create"; title: string }
  | { action: "start"; todoId: string }
  | { action: "finish"; todoId?: string; summary?: string }
  | { action: "block"; todoId?: string; reason: string }
  | { action: "unblock"; todoId: string }
  | { action: "list" };

export const TODO_EXCLUDED_CAPABILITIES = Object.freeze([
  "dependency-scheduling",
  "leases-and-claims",
  "splitting",
  "artifact-writing",
  "startup-filesystem-scans",
  "autonomous-follow-up",
] as const);

export type TodoLifecycleOwner = "pi-todo" | "pi-swe";

export type TodoOwnershipDecision = {
  lifecycleOwner: TodoLifecycleOwner;
  allowed: boolean;
};

/**
 * An active assessed pi-swe task is the sole lifecycle owner. Todo inspection
 * remains available, but pi-todo cannot begin or mutate competing work.
 */
export function decideTodoOwnership(
  action: TodoPublicAction,
  hasActiveSweTask: boolean,
): TodoOwnershipDecision {
  if (!hasActiveSweTask) return { lifecycleOwner: "pi-todo", allowed: true };
  return { lifecycleOwner: "pi-swe", allowed: action === "list" };
}

export function isTodoPublicAction(value: unknown): value is TodoPublicAction {
  return typeof value === "string" && (TODO_PUBLIC_ACTIONS as readonly string[]).includes(value);
}
