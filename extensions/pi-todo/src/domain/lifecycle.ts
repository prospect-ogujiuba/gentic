import type { TodoPriority, TodoStatus, TodoStatusInput } from "./types.ts";

export const TODO_STATUSES = ["ready", "claimed", "in_progress", "external_blocked", "completed", "verified", "failed", "cancelled", "superseded"] as const;
export const COMPAT_TODO_STATUSES = ["proposed", "pending", "done", "needs_review", "blocked", "abandoned"] as const;

export const TODO_STATUS_ALIASES = {
  proposed: "ready",
  pending: "ready",
  done: "completed",
  needs_review: "completed",
  blocked: "external_blocked",
  abandoned: "cancelled",
} as const;

export const TERMINAL_STATUSES = ["completed", "verified", "failed", "cancelled", "superseded"] as const;
export const READY_STATUSES = ["ready"] as const;
export const ACTIVE_STATUSES = ["claimed", "in_progress"] as const;
export const OPEN_STATUSES = ["ready", "claimed", "in_progress", "external_blocked"] as const;
export const DONE_STATUSES = ["completed", "verified"] as const;
export const SUCCESS_STATUSES = DONE_STATUSES;
export const FAILURE_STATUSES = ["failed", "cancelled", "superseded"] as const;

export const TODO_LIFECYCLE_GLOSSARY = {
  active: "claimed or in_progress work currently owned by an agent/session",
  open: "not terminal; ready, claimed, in_progress, or external_blocked",
  done: "successfully closed; completed or verified",
  stale: "not a task status; expired claims return to ready and stale split scaffolds are cancelled with a reason",
  externallyBlocked: "open work waiting on an external dependency, represented by external_blocked",
} as const;

export const TODO_STATUS_MODEL: Record<TodoStatus, { terminal: boolean; active: boolean; open: boolean; done: boolean; externallyBlocked: boolean; meaning: string }> = {
  ready: { terminal: false, active: false, open: true, done: false, externallyBlocked: false, meaning: "actionable and eligible to claim/start once dependencies and capabilities are satisfied" },
  claimed: { terminal: false, active: true, open: true, done: false, externallyBlocked: false, meaning: "reserved by an owner but not yet started" },
  in_progress: { terminal: false, active: true, open: true, done: false, externallyBlocked: false, meaning: "actively being worked" },
  external_blocked: { terminal: false, active: false, open: true, done: false, externallyBlocked: true, meaning: "waiting on an external dependency, user decision, or outside system" },
  completed: { terminal: true, active: false, open: false, done: true, externallyBlocked: false, meaning: "implementation work is done and has completion evidence" },
  verified: { terminal: true, active: false, open: false, done: true, externallyBlocked: false, meaning: "completed work has passed verification/review" },
  failed: { terminal: true, active: false, open: false, done: false, externallyBlocked: false, meaning: "work stopped because the attempted implementation failed" },
  cancelled: { terminal: true, active: false, open: false, done: false, externallyBlocked: false, meaning: "work intentionally closed as no longer needed; abandoned is recorded as a cancellation reason" },
  superseded: { terminal: true, active: false, open: false, done: false, externallyBlocked: false, meaning: "work closed because another todo replaces it" },
};

export const TODO_TRANSITIONS: Record<TodoStatus, readonly TodoStatus[]> = {
  ready: ["claimed", "in_progress", "external_blocked", "completed", "failed", "cancelled", "superseded"],
  claimed: ["ready", "in_progress", "external_blocked", "completed", "failed", "cancelled", "superseded"],
  in_progress: ["ready", "external_blocked", "completed", "failed", "cancelled", "superseded"],
  external_blocked: ["ready", "cancelled", "superseded"],
  completed: ["verified", "ready", "superseded"],
  verified: ["ready", "superseded"],
  failed: ["ready", "cancelled", "superseded"],
  cancelled: ["ready"],
  superseded: ["ready"],
};

export function normalizeStatus(status: TodoStatusInput | string | undefined): TodoStatus {
  const value = status || "";
  if (value in TODO_STATUS_ALIASES) return TODO_STATUS_ALIASES[value as keyof typeof TODO_STATUS_ALIASES];
  if ((TODO_STATUSES as readonly string[]).includes(value)) return value as TodoStatus;
  return "ready";
}

export function isTerminalStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (TERMINAL_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isReadyStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (READY_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isActiveStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (ACTIVE_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isOpenStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (OPEN_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isDoneStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (DONE_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isSuccessStatus(status: TodoStatus | string | undefined): boolean {
  return isDoneStatus(status);
}

export function isFailureStatus(status: TodoStatus | string | undefined): boolean {
  return Boolean(status && (FAILURE_STATUSES as readonly string[]).includes(normalizeStatus(status)));
}

export function isExternalBlockedStatus(status: TodoStatus | string | undefined): boolean {
  return normalizeStatus(status) === "external_blocked";
}

export function canTransitionStatus(from: TodoStatus | string | undefined, to: TodoStatus | string | undefined, options: { allowNoop?: boolean } = {}): boolean {
  const normalizedFrom = normalizeStatus(from);
  const normalizedTo = normalizeStatus(to);
  return Boolean((options.allowNoop && normalizedFrom === normalizedTo) || TODO_TRANSITIONS[normalizedFrom].includes(normalizedTo));
}

export function transitionAllowedStatuses(from: TodoStatus | string | undefined): readonly TodoStatus[] {
  return TODO_TRANSITIONS[normalizeStatus(from)];
}

export function normalizePriority(priority?: TodoPriority): TodoPriority {
  if (priority === "critical") return "urgent";
  if (priority === "normal") return "medium";
  return priority || "medium";
}
