import type { TodoPriority, TodoStatus, TodoStatusInput } from "./types.ts";

export const TODO_STATUSES = ["ready", "claimed", "in_progress", "blocked", "completed", "verified", "failed", "abandoned", "cancelled"] as const;
export const COMPAT_TODO_STATUSES = ["proposed", "pending", "done", "needs_review"] as const;

export const TERMINAL_STATUSES = ["completed", "verified", "failed", "abandoned", "cancelled"] as const;
export const READY_STATUSES = ["ready"] as const;
export const ACTIVE_STATUSES = ["claimed", "in_progress"] as const;
export const SUCCESS_STATUSES = ["completed", "verified"] as const;
export const FAILURE_STATUSES = ["failed", "abandoned", "cancelled"] as const;

export function normalizeStatus(status: TodoStatusInput | string | undefined): TodoStatus {
  if (status === "proposed" || status === "pending") return "ready";
  if (status === "done" || status === "needs_review") return "completed";
  if ((TODO_STATUSES as readonly string[]).includes(status || "")) return status as TodoStatus;
  return "ready";
}

export function isTerminalStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (TERMINAL_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isReadyStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (READY_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isSuccessStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (SUCCESS_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isFailureStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (FAILURE_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function normalizePriority(priority?: TodoPriority): TodoPriority {
  if (priority === "critical") return "urgent";
  if (priority === "normal") return "medium";
  return priority || "medium";
}
