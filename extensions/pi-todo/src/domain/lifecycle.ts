import type { TodoPriority, TodoStatus } from "./types.ts";

export const LEGACY_TODO_STATUSES = ["proposed", "ready", "claimed", "in_progress", "blocked", "completed", "verified", "failed", "abandoned"] as const;
export const COMPAT_TODO_STATUSES = ["pending", "done", "cancelled", "needs_review"] as const;
export const TODO_STATUSES = [...LEGACY_TODO_STATUSES, ...COMPAT_TODO_STATUSES] as const;

export const TERMINAL_STATUSES = ["completed", "verified", "failed", "abandoned", "done", "cancelled"] as const;
export const READY_STATUSES = ["ready", "pending"] as const;
export const ACTIVE_STATUSES = ["claimed", "in_progress"] as const;
export const SUCCESS_STATUSES = ["completed", "verified", "done"] as const;
export const FAILURE_STATUSES = ["failed", "abandoned", "cancelled"] as const;

export function isTerminalStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (TERMINAL_STATUSES as readonly string[]).includes(status));
}

export function isReadyStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (READY_STATUSES as readonly string[]).includes(status));
}

export function isSuccessStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (SUCCESS_STATUSES as readonly string[]).includes(status));
}

export function isFailureStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (FAILURE_STATUSES as readonly string[]).includes(status));
}

export function normalizePriority(priority?: TodoPriority): TodoPriority {
  if (priority === "critical") return "urgent";
  if (priority === "normal") return "medium";
  return priority || "medium";
}
