import { randomUUID } from "node:crypto";

import {
  TODO_MAX_ITEMS,
  TODO_TEXT_LIMITS,
  decideTodoOwnership,
  type TodoOwnershipDecision,
  type TodoPublicAction,
  type TodoPublicItem,
} from "./contract.ts";

export const TODO_EVENT_CUSTOM_TYPE = "gentic.todo.event";
export const TODO_EVENT_VERSION = 1 as const;

export type TodoBranchEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

export type TodoCoreState = {
  todos: Record<string, TodoPublicItem>;
  order: string[];
  activeTodoId?: string;
};

type TodoCoreEvent =
  | { id: string; type: "todo.created"; at: string; todo: TodoPublicItem }
  | { id: string; type: "todo.started"; at: string; todoId: string }
  | { id: string; type: "todo.moved"; at: string; todoId: string; beforeTodoId?: string; afterTodoId?: string }
  | { id: string; type: "todo.completed" | "todo.cancelled" | "todo.failed" | "todo.superseded" | "todo.verified"; at: string; todoId: string; summary?: string; evidence?: readonly unknown[] }
  | { id: string; type: "todo.blocked" | "todo.external_blocked"; at: string; todoId: string; reason: string }
  | { id: string; type: "todo.unblocked"; at: string; todoId: string };

type TodoCoreEventInput = TodoCoreEvent extends infer Event
  ? Event extends TodoCoreEvent ? Omit<Event, "id" | "at"> : never
  : never;

type BranchTodoCoreOptions = {
  getBranch: () => readonly TodoBranchEntry[];
  appendEntry: (customType: string, data: unknown) => void;
  now?: () => string;
  createId?: (prefix: "todo" | "event") => string;
};

export class TodoCoreError extends Error {
  readonly code: "TODO_NOT_FOUND" | "ACTIVE_TODO_EXISTS" | "INVALID_TRANSITION" | "NO_ACTIVE_TODO";

  constructor(code: TodoCoreError["code"], message: string) {
    super(message);
    this.name = "TodoCoreError";
    this.code = code;
  }
}

/** Minimal event-sourced core. The supplied branch is the only state authority. */
export class BranchTodoCore {
  private readonly getBranch: BranchTodoCoreOptions["getBranch"];
  private readonly appendEntry: BranchTodoCoreOptions["appendEntry"];
  private readonly now: () => string;
  private readonly createId: NonNullable<BranchTodoCoreOptions["createId"]>;

  constructor(options: BranchTodoCoreOptions) {
    this.getBranch = options.getBranch;
    this.appendEntry = options.appendEntry;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  state(): TodoCoreState {
    const state: TodoCoreState = { todos: {}, order: [], activeTodoId: undefined };
    for (const entry of this.getBranch()) {
      const event = decodeEvent(entry);
      if (event) applyEvent(state, event);
    }
    return state;
  }

  list(): TodoPublicItem[] {
    const state = this.state();
    return state.order.map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
  }

  ownership(action: TodoPublicAction, hasActiveSweTask: boolean): TodoOwnershipDecision {
    return decideTodoOwnership(action, hasActiveSweTask);
  }

  create(title: string, parentTodoId?: string): TodoPublicItem {
    const normalized = requirePublicLine(title, TODO_TEXT_LIMITS.title, "todo title");
    const state = this.state();
    if (state.order.length >= TODO_MAX_ITEMS) throw new Error(`todo limit exceeded: maximum ${TODO_MAX_ITEMS}`);
    const normalizedParentId = parentTodoId === undefined ? undefined : requireTodoId(parentTodoId);
    if (normalizedParentId) {
      const parent = requireTodo(state, normalizedParentId);
      if (parent.status === "completed") {
        throw new TodoCoreError("INVALID_TRANSITION", "cannot add a subtask to a completed todo");
      }
    }
    const todo: TodoPublicItem = {
      id: requireTodoId(this.createId("todo")),
      title: normalized,
      status: "ready",
      parentTodoId: normalizedParentId,
    };
    this.append({ type: "todo.created", todo });
    return todo;
  }

  move(todoId: string, beforeTodoId?: string, afterTodoId?: string): TodoPublicItem {
    const state = this.state();
    const normalizedId = requireTodoId(todoId);
    const todo = requireTodo(state, normalizedId);
    if ((beforeTodoId === undefined) === (afterTodoId === undefined)) {
      throw new Error("exactly one of beforeTodoId or afterTodoId is required");
    }
    const normalizedBeforeId = beforeTodoId === undefined ? undefined : requireTodoId(beforeTodoId);
    const normalizedAfterId = afterTodoId === undefined ? undefined : requireTodoId(afterTodoId);
    const anchorId = normalizedBeforeId ?? normalizedAfterId!;
    const anchor = requireTodo(state, anchorId);
    if (anchor.id === todo.id) return todo;
    if (anchor.parentTodoId !== todo.parentTodoId) {
      throw new TodoCoreError("INVALID_TRANSITION", "todos can only move before or after a sibling");
    }
    this.append({ type: "todo.moved", todoId: normalizedId, beforeTodoId: normalizedBeforeId, afterTodoId: normalizedAfterId });
    return todo;
  }

  start(todoId: string): TodoPublicItem {
    const state = this.state();
    const normalizedId = requireTodoId(todoId);
    const todo = requireTodo(state, normalizedId);
    if (todo.status === "in_progress") return todo;
    if (state.activeTodoId) {
      throw new TodoCoreError("ACTIVE_TODO_EXISTS", `todo ${state.activeTodoId} is already active`);
    }
    if (todo.status !== "ready") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot start todo from ${todo.status}`);
    }
    this.append({ type: "todo.started", todoId: normalizedId });
    return { ...todo, status: "in_progress", blockedReason: undefined };
  }

  finish(todoId?: string, summary?: string): TodoPublicItem {
    const state = this.state();
    const targetId = todoId === undefined ? state.activeTodoId : requireTodoId(todoId);
    if (!targetId) throw new TodoCoreError("NO_ACTIVE_TODO", "no active todo to finish");
    const todo = requireTodo(state, targetId);
    if (todo.status !== "in_progress") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot finish todo from ${todo.status}`);
    }
    const incompleteSubtasks = descendantIds(state, targetId).filter((id) => state.todos[id]?.status !== "completed");
    if (incompleteSubtasks.length) {
      throw new TodoCoreError("INVALID_TRANSITION", `complete ${incompleteSubtasks.length} open subtask${incompleteSubtasks.length === 1 ? "" : "s"} first`);
    }
    const normalizedSummary = summary === undefined ? undefined : requirePublicLine(summary, TODO_TEXT_LIMITS.summary, "todo summary");
    this.append({ type: "todo.completed", todoId: targetId, summary: normalizedSummary, evidence: [] });
    return { ...todo, status: "completed", blockedReason: undefined };
  }

  block(todoId: string | undefined, reason: string): TodoPublicItem {
    const state = this.state();
    const targetId = todoId === undefined ? state.activeTodoId : requireTodoId(todoId);
    if (!targetId) throw new TodoCoreError("NO_ACTIVE_TODO", "no active todo to block");
    const todo = requireTodo(state, targetId);
    if (todo.status !== "ready" && todo.status !== "in_progress") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot block todo from ${todo.status}`);
    }
    const normalized = requirePublicLine(reason, TODO_TEXT_LIMITS.reason, "block reason");
    this.append({ type: "todo.blocked", todoId: targetId, reason: normalized });
    return { ...todo, status: "external_blocked", blockedReason: normalized };
  }

  unblock(todoId: string): TodoPublicItem {
    const state = this.state();
    const normalizedId = requireTodoId(todoId);
    const todo = requireTodo(state, normalizedId);
    if (todo.status !== "external_blocked") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot unblock todo from ${todo.status}`);
    }
    this.append({ type: "todo.unblocked", todoId: normalizedId });
    return { ...todo, status: "ready", blockedReason: undefined };
  }

  private append(event: TodoCoreEventInput): void {
    const complete = { ...event, id: this.createId("event"), at: this.now() } as TodoCoreEvent;
    this.appendEntry(TODO_EVENT_CUSTOM_TYPE, { version: TODO_EVENT_VERSION, event: complete });
  }
}

function decodeEvent(entry: TodoBranchEntry): TodoCoreEvent | undefined {
  if (entry.type !== "custom" || entry.customType !== TODO_EVENT_CUSTOM_TYPE) return undefined;
  const data = record(entry.data);
  if (!data) return undefined;
  const candidate = data.version === TODO_EVENT_VERSION ? record(data.event) : data;
  if (!candidate || typeof candidate.id !== "string" || typeof candidate.type !== "string" || typeof candidate.at !== "string") return undefined;
  if (candidate.type === "todo.created") {
    const todo = decodeTodo(candidate.todo);
    return todo ? { id: candidate.id, type: candidate.type, at: candidate.at, todo } : undefined;
  }
  if (typeof candidate.todoId !== "string") return undefined;
  const todoId = decodeTodoId(candidate.todoId);
  if (!todoId) return undefined;
  if (candidate.type === "todo.started" || candidate.type === "todo.unblocked") {
    return { id: candidate.id, type: candidate.type, at: candidate.at, todoId };
  }
  if (candidate.type === "todo.moved") {
    const beforeTodoId = typeof candidate.beforeTodoId === "string" ? decodeTodoId(candidate.beforeTodoId) : undefined;
    const afterTodoId = typeof candidate.afterTodoId === "string" ? decodeTodoId(candidate.afterTodoId) : undefined;
    return (beforeTodoId === undefined) === (afterTodoId === undefined)
      ? undefined
      : { id: candidate.id, type: candidate.type, at: candidate.at, todoId, beforeTodoId, afterTodoId };
  }
  if (["todo.completed", "todo.cancelled", "todo.failed", "todo.superseded", "todo.verified"].includes(candidate.type)) {
    return {
      id: candidate.id,
      type: candidate.type as "todo.completed" | "todo.cancelled" | "todo.failed" | "todo.superseded" | "todo.verified",
      at: candidate.at,
      todoId,
      summary: typeof candidate.summary === "string" ? boundedPublicLine(candidate.summary, TODO_TEXT_LIMITS.summary) : undefined,
    };
  }
  if ((candidate.type === "todo.blocked" || candidate.type === "todo.external_blocked") && typeof candidate.reason === "string") {
    return { id: candidate.id, type: candidate.type, at: candidate.at, todoId, reason: boundedPublicLine(candidate.reason, TODO_TEXT_LIMITS.reason) };
  }
  return undefined;
}

function applyEvent(state: TodoCoreState, event: TodoCoreEvent): void {
  if (event.type === "todo.created") {
    if (!state.todos[event.todo.id]) {
      if (state.order.length >= TODO_MAX_ITEMS) return;
      state.order.push(event.todo.id);
    }
    const todo = { ...event.todo };
    if (todo.parentTodoId && state.todos[todo.parentTodoId]?.status === "completed") {
      todo.parentTodoId = undefined;
    }
    state.todos[todo.id] = todo;
    if (todo.status === "completed" && descendantIds(state, todo.id).some((id) => state.todos[id]?.status !== "completed")) {
      state.todos[todo.id] = { ...todo, status: "ready" };
    }
    if (todo.status === "in_progress") activate(state, todo.id);
    else if (state.activeTodoId === todo.id) state.activeTodoId = undefined;
    return;
  }
  const todo = state.todos[event.todoId];
  if (!todo) return;
  if (event.type === "todo.started") {
    activate(state, event.todoId);
    return;
  }
  if (event.type === "todo.moved") {
    moveTodo(state, event.todoId, event.beforeTodoId, event.afterTodoId);
    return;
  }
  if (["todo.completed", "todo.cancelled", "todo.failed", "todo.superseded", "todo.verified"].includes(event.type)) {
    if (descendantIds(state, event.todoId).some((id) => state.todos[id]?.status !== "completed")) return;
    state.todos[event.todoId] = { ...todo, status: "completed", blockedReason: undefined };
    if (state.activeTodoId === event.todoId) state.activeTodoId = undefined;
    return;
  }
  if (event.type === "todo.blocked" || event.type === "todo.external_blocked") {
    state.todos[event.todoId] = { ...todo, status: "external_blocked", blockedReason: event.reason };
    if (state.activeTodoId === event.todoId) state.activeTodoId = undefined;
    return;
  }
  state.todos[event.todoId] = { ...todo, status: "ready", blockedReason: undefined };
  if (state.activeTodoId === event.todoId) state.activeTodoId = undefined;
}

function activate(state: TodoCoreState, todoId: string): void {
  if (state.activeTodoId && state.activeTodoId !== todoId) {
    const previous = state.todos[state.activeTodoId];
    if (previous?.status === "in_progress") state.todos[state.activeTodoId] = { ...previous, status: "ready" };
  }
  const todo = state.todos[todoId];
  if (!todo) return;
  state.todos[todoId] = { ...todo, status: "in_progress", blockedReason: undefined };
  state.activeTodoId = todoId;
}

function decodeTodo(value: unknown): TodoPublicItem | undefined {
  const todo = record(value);
  if (!todo || typeof todo.id !== "string" || typeof todo.title !== "string") return undefined;
  const id = decodeTodoId(todo.id);
  if (!id) return undefined;
  const status = normalizePublicStatus(todo.status);
  if (!status) return undefined;
  return {
    id,
    title: boundedPublicLine(todo.title, TODO_TEXT_LIMITS.title),
    status,
    parentTodoId: typeof todo.parentTodoId === "string" ? decodeTodoId(todo.parentTodoId) : undefined,
    blockedReason: typeof todo.blockedReason === "string"
      ? boundedPublicLine(todo.blockedReason, TODO_TEXT_LIMITS.reason)
      : typeof todo.externalBlocker === "string" ? boundedPublicLine(todo.externalBlocker, TODO_TEXT_LIMITS.reason) : undefined,
  };
}

function moveTodo(state: TodoCoreState, todoId: string, beforeTodoId?: string, afterTodoId?: string): void {
  const todo = state.todos[todoId];
  const anchorId = beforeTodoId ?? afterTodoId;
  const anchor = anchorId ? state.todos[anchorId] : undefined;
  if (!todo || !anchor || todo.id === anchor.id || todo.parentTodoId !== anchor.parentTodoId) return;
  const without = state.order.filter((id) => id !== todoId);
  const anchorIndex = without.indexOf(anchor.id);
  if (anchorIndex < 0) return;
  without.splice(anchorIndex + (afterTodoId ? 1 : 0), 0, todoId);
  state.order = without;
}

function descendantIds(state: TodoCoreState, parentTodoId: string): string[] {
  const result: string[] = [];
  const queue = [parentTodoId];
  const seen = new Set(queue);
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const id of state.order) {
      if (seen.has(id) || state.todos[id]?.parentTodoId !== parentId) continue;
      seen.add(id);
      result.push(id);
      queue.push(id);
    }
  }
  return result;
}

function normalizePublicStatus(value: unknown): TodoPublicItem["status"] | undefined {
  if (value === "ready" || value === "pending" || value === "proposed") return "ready";
  if (value === "in_progress" || value === "claimed") return "in_progress";
  if (value === "external_blocked" || value === "blocked") return "external_blocked";
  if (["completed", "done", "needs_review", "verified", "failed", "cancelled", "superseded", "abandoned"].includes(String(value))) return "completed";
  return undefined;
}

function boundedPublicLine(value: string, maximum: number): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function requirePublicLine(value: string, maximum: number, label: string): string {
  const normalized = boundedPublicLine(value, maximum + 1);
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} must not exceed ${maximum} characters`);
  return normalized;
}

function decodeTodoId(value: string): string | undefined {
  const normalized = boundedPublicLine(value, TODO_TEXT_LIMITS.todoId + 1);
  return normalized.length > 0 && normalized.length <= TODO_TEXT_LIMITS.todoId && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function requireTodoId(value: string): string {
  const normalized = decodeTodoId(value);
  if (!normalized) throw new Error(`todoId must be 1..${TODO_TEXT_LIMITS.todoId} safe characters`);
  return normalized;
}

function requireTodo(state: TodoCoreState, todoId: string): TodoPublicItem {
  const todo = state.todos[todoId];
  if (!todo) throw new TodoCoreError("TODO_NOT_FOUND", `todo not found: ${todoId}`);
  return todo;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
