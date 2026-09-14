import { randomUUID } from "node:crypto";

import {
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
  | { id: string; type: "todo.completed"; at: string; todoId: string; summary?: string; evidence?: readonly unknown[] }
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

  create(title: string): TodoPublicItem {
    const normalized = title.trim();
    if (!normalized) throw new Error("todo title is required");
    const todo: TodoPublicItem = {
      id: this.createId("todo"),
      title: normalized,
      status: "ready",
    };
    this.append({ type: "todo.created", todo });
    return todo;
  }

  start(todoId: string): TodoPublicItem {
    const state = this.state();
    const todo = requireTodo(state, todoId);
    if (todo.status === "in_progress") return todo;
    if (state.activeTodoId) {
      throw new TodoCoreError("ACTIVE_TODO_EXISTS", `todo ${state.activeTodoId} is already active`);
    }
    if (todo.status !== "ready") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot start todo from ${todo.status}`);
    }
    this.append({ type: "todo.started", todoId });
    return { ...todo, status: "in_progress", blockedReason: undefined };
  }

  finish(todoId?: string, summary?: string): TodoPublicItem {
    const state = this.state();
    const targetId = todoId ?? state.activeTodoId;
    if (!targetId) throw new TodoCoreError("NO_ACTIVE_TODO", "no active todo to finish");
    const todo = requireTodo(state, targetId);
    if (todo.status !== "in_progress") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot finish todo from ${todo.status}`);
    }
    this.append({ type: "todo.completed", todoId: targetId, summary, evidence: [] });
    return { ...todo, status: "completed", blockedReason: undefined };
  }

  block(todoId: string | undefined, reason: string): TodoPublicItem {
    const state = this.state();
    const targetId = todoId ?? state.activeTodoId;
    if (!targetId) throw new TodoCoreError("NO_ACTIVE_TODO", "no active todo to block");
    const todo = requireTodo(state, targetId);
    if (todo.status !== "ready" && todo.status !== "in_progress") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot block todo from ${todo.status}`);
    }
    const normalized = reason.trim();
    if (!normalized) throw new Error("block reason is required");
    this.append({ type: "todo.blocked", todoId: targetId, reason: normalized });
    return { ...todo, status: "external_blocked", blockedReason: normalized };
  }

  unblock(todoId: string): TodoPublicItem {
    const state = this.state();
    const todo = requireTodo(state, todoId);
    if (todo.status !== "external_blocked") {
      throw new TodoCoreError("INVALID_TRANSITION", `cannot unblock todo from ${todo.status}`);
    }
    this.append({ type: "todo.unblocked", todoId });
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
  if (candidate.type === "todo.started" || candidate.type === "todo.unblocked") {
    return { id: candidate.id, type: candidate.type, at: candidate.at, todoId: candidate.todoId };
  }
  if (candidate.type === "todo.completed") {
    return { id: candidate.id, type: candidate.type, at: candidate.at, todoId: candidate.todoId, summary: typeof candidate.summary === "string" ? candidate.summary : undefined };
  }
  if ((candidate.type === "todo.blocked" || candidate.type === "todo.external_blocked") && typeof candidate.reason === "string") {
    return { id: candidate.id, type: candidate.type, at: candidate.at, todoId: candidate.todoId, reason: candidate.reason };
  }
  return undefined;
}

function applyEvent(state: TodoCoreState, event: TodoCoreEvent): void {
  if (event.type === "todo.created") {
    if (!state.todos[event.todo.id]) state.order.push(event.todo.id);
    state.todos[event.todo.id] = { ...event.todo };
    if (event.todo.status === "in_progress") activate(state, event.todo.id);
    return;
  }
  const todo = state.todos[event.todoId];
  if (!todo) return;
  if (event.type === "todo.started") {
    activate(state, event.todoId);
    return;
  }
  if (event.type === "todo.completed") {
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
  const status = todo.status;
  if (status !== "ready" && status !== "in_progress" && status !== "external_blocked" && status !== "completed") return undefined;
  return {
    id: todo.id,
    title: todo.title,
    status,
    blockedReason: typeof todo.blockedReason === "string"
      ? todo.blockedReason
      : typeof todo.externalBlocker === "string" ? todo.externalBlocker : undefined,
  };
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
