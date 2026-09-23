import {
  prefixedCompletions,
  renderActionHelp,
  rootActionCompletions,
  type CommandActionSpec,
  type CommandCompletion,
} from "../../../src/command-guidance.ts";
import { TODO_MAX_ITEMS, type TodoPublicItem } from "./contract.ts";
import type { TodoCoreState } from "./state-core.ts";

export const TODO_COMMAND_ACTIONS = [
  { action: "open", syntax: "/todo open", description: "Open the visual docket" },
  { action: "list", syntax: "/todo list", description: "List every todo" },
  { action: "create", syntax: "/todo create <title> [--parent <id>]", description: "Create work or a subtask" },
  { action: "move", syntax: "/todo move <id> before|after <id>", description: "Reorder siblings" },
  { action: "delete", syntax: "/todo delete <id>", description: "Delete a todo subtree" },
  { action: "start", syntax: "/todo start <id>", description: "Start one ready todo" },
  { action: "finish", syntax: "/todo finish [id]", description: "Finish active work" },
  { action: "block", syntax: "/todo block <id> <reason>", description: "Record an external blocker" },
  { action: "unblock", syntax: "/todo unblock <id>", description: "Return blocked work to ready" },
] as const satisfies readonly CommandActionSpec[];

export type TodoCommandAction = typeof TODO_COMMAND_ACTIONS[number]["action"];

export function getTodoCommandCompletions(
  prefix: string,
  state?: TodoCoreState,
  mutationsAllowed = true,
): CommandCompletion[] {
  const normalized = prefix.trimStart();
  if (!/\s/.test(normalized)) return rootActionCompletions(normalized, visibleActions(state, mutationsAllowed));
  if (!state || !mutationsAllowed) return [];

  const match = /^(\S+)\s+(.*)$/s.exec(normalized);
  if (!match) return [];
  const action = match[1] as TodoCommandAction;
  const remainder = match[2]!;
  if (action === "create") return completeParent(remainder, state);
  if (action === "move") return completeMove(remainder, state);
  if (action === "delete") return completeIds(action, remainder, state, () => true);
  if (action === "start") return state.activeTodoId ? [] : completeIds(action, remainder, state, (todo) => todo.status === "ready");
  if (action === "finish") return completeIds(action, remainder, state, (todo) => todo.status === "in_progress" && canFinish(todo, state));
  if (action === "block") return completeIds(action, remainder, state, (todo) => todo.status === "ready" || todo.status === "in_progress");
  if (action === "unblock") return completeIds(action, remainder, state, (todo) => todo.status === "external_blocked");
  return [];
}

export function renderTodoQuickHelp(state: TodoCoreState, mutationsAllowed = true, ownershipMessage?: string): string {
  const todos = orderedTodos(state);
  const active = state.activeTodoId ? state.todos[state.activeTodoId] : undefined;
  const ready = todos.filter((todo) => todo.status === "ready");
  const blocked = todos.filter((todo) => todo.status === "external_blocked");
  const lines = [
    active ? `Active: ${active.id} — ${clip(active.title, 64)}` : "Active: none",
    `Ready: ${ready.length}${ready[0] ? ` · next ${ready[0].id} — ${clip(ready[0].title, 52)}` : ""}`,
    `Blocked: ${blocked.length}${blocked[0] ? ` · ${blocked[0].id} — ${clip(blocked[0].blockedReason ?? blocked[0].title, 52)}` : ""}`,
    "",
    ...renderActionHelp(visibleActions(state, mutationsAllowed)),
  ];
  if (!mutationsAllowed) {
    lines.push(ownershipMessage ?? "Lifecycle owner: pi-swe; complete or pause active SWE work before mutating todos.", "Next: /todo list");
  } else if (active) lines.push(`Next: /todo finish ${active.id} or /todo block ${active.id} <reason>`);
  else if (ready[0]) lines.push(`Next: /todo start ${ready[0].id}`);
  else if (blocked[0]) lines.push(`Next: /todo unblock ${blocked[0].id}`);
  else lines.push("Next: /todo create <title>");
  lines.push("Type a space after an action to see valid contextual completions.");
  return lines.join("\n");
}

export function todoRecoveryHint(state: TodoCoreState, requestedAction?: string): string | undefined {
  const active = state.activeTodoId ? state.todos[state.activeTodoId] : undefined;
  if (requestedAction === "start" && active) return `Finish or block active todo ${active.id} first: /todo finish ${active.id}`;
  if (requestedAction === "finish" && !active) {
    const ready = orderedTodos(state).find((todo) => todo.status === "ready");
    return ready ? `Start ready todo ${ready.id} first: /todo start ${ready.id}` : "Create work first: /todo create <title>";
  }
  if (requestedAction === "unblock") {
    const blocked = orderedTodos(state).find((todo) => todo.status === "external_blocked");
    if (blocked) return `Try: /todo unblock ${blocked.id}`;
  }
  return "Type /todo for current state and valid next actions.";
}

function visibleActions(state?: TodoCoreState, mutationsAllowed = true): readonly CommandActionSpec<TodoCommandAction>[] {
  if (!state) return mutationsAllowed ? TODO_COMMAND_ACTIONS : TODO_COMMAND_ACTIONS.filter(({ action }) => action === "open" || action === "list");
  const todos = orderedTodos(state);
  return TODO_COMMAND_ACTIONS.filter(({ action }) => {
    if (action === "open" || action === "list") return true;
    if (!mutationsAllowed) return false;
    if (action === "create") return todos.length < TODO_MAX_ITEMS;
    if (action === "delete") return todos.length > 0;
    if (action === "move") return todos.some((todo) => siblings(todo, state).length > 0);
    if (action === "start") return !state.activeTodoId && todos.some((todo) => todo.status === "ready");
    if (action === "finish") return todos.some((todo) => todo.status === "in_progress" && canFinish(todo, state));
    if (action === "block") return todos.some((todo) => todo.status === "ready" || todo.status === "in_progress");
    return todos.some((todo) => todo.status === "external_blocked");
  });
}

function completeParent(remainder: string, state: TodoCoreState): CommandCompletion[] {
  const match = /^(.*\S)\s+--parent\s+(\S*)$/.exec(remainder);
  if (!match) return [];
  const valuePrefix = `create ${match[1]} --parent `;
  return prefixedCompletions(valuePrefix, candidates(state, match[2]!, (todo) => todo.status !== "completed"));
}

function completeMove(remainder: string, state: TodoCoreState): CommandCompletion[] {
  const first = /^(\S*)$/.exec(remainder);
  if (first) return prefixedCompletions("move ", candidates(state, first[1]!, (todo) => siblings(todo, state).length > 0));
  const relation = /^(\S+)\s+(\S*)$/.exec(remainder);
  if (relation) {
    const todo = state.todos[relation[1]!];
    if (!todo) return [];
    return ["before", "after"]
      .filter((value) => value.startsWith(relation[2]!))
      .map((value) => ({ value: `move ${todo.id} ${value}`, label: value, description: `Place ${todo.id} ${value} a sibling` }));
  }
  const anchor = /^(\S+)\s+(before|after)\s+(\S*)$/.exec(remainder);
  if (!anchor) return [];
  const todo = state.todos[anchor[1]!];
  if (!todo) return [];
  return prefixedCompletions(`move ${todo.id} ${anchor[2]} `, candidates(state, anchor[3]!, (candidate) => candidate.id !== todo.id && candidate.parentTodoId === todo.parentTodoId));
}

function completeIds(
  action: TodoCommandAction,
  remainder: string,
  state: TodoCoreState,
  include: (todo: TodoPublicItem) => boolean,
): CommandCompletion[] {
  if (/\s/.test(remainder)) return [];
  return prefixedCompletions(`${action} `, candidates(state, remainder, include));
}

function candidates(state: TodoCoreState, prefix: string, include: (todo: TodoPublicItem) => boolean): CommandCompletion[] {
  return orderedTodos(state)
    .filter((todo) => include(todo) && todo.id.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((todo) => ({ value: todo.id, label: todo.id, description: describeTodo(todo, state) }));
}

function orderedTodos(state: TodoCoreState): TodoPublicItem[] {
  return state.order.slice(0, TODO_MAX_ITEMS).map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
}

function siblings(todo: TodoPublicItem, state: TodoCoreState): TodoPublicItem[] {
  return orderedTodos(state).filter((candidate) => candidate.id !== todo.id && candidate.parentTodoId === todo.parentTodoId);
}

function canFinish(todo: TodoPublicItem, state: TodoCoreState): boolean {
  const all = orderedTodos(state);
  const queue = [todo.id];
  const seen = new Set(queue);
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const candidate of all) {
      if (seen.has(candidate.id) || candidate.parentTodoId !== parentId) continue;
      if (candidate.status !== "completed") return false;
      seen.add(candidate.id);
      queue.push(candidate.id);
    }
  }
  return true;
}

function describeTodo(todo: TodoPublicItem, state: TodoCoreState): string {
  const context = todo.id === state.activeTodoId ? "active" : todo.status;
  const hierarchy = todo.parentTodoId ? `child of ${todo.parentTodoId}` : "root";
  const blocker = todo.blockedReason ? ` · blocked: ${clip(todo.blockedReason, 48)}` : "";
  return `${context} · ${hierarchy} · ${clip(todo.title, 64)}${blocker}`;
}

function clip(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}
