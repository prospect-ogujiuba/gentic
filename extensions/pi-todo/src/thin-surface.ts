import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { renderUsage } from "../../../src/command-guidance.ts";
import { coordinatedActiveSwe } from "../../../src/lifecycle-coordination.ts";
import {
  getTodoCommandCompletions,
  renderTodoQuickHelp,
  TODO_COMMAND_ACTIONS,
  todoRecoveryHint,
} from "./command-adapter.ts";
import {
  TODO_PUBLIC_ACTIONS,
  TODO_TEXT_LIMITS,
  isTodoPublicAction,
  type TodoPublicAction,
  type TodoPublicItem,
  type TodoPublicRequest,
} from "./contract.ts";
import { BranchTodoCore, TodoCoreError, type TodoCoreState } from "./state-core.ts";
import { createTodoDocketComponent, orderedTodoRows, renderTodoDocketLines } from "./ui/docket.ts";
import { LightweightTodoModal } from "./ui/modal.ts";
import { plainTodoTheme } from "./ui/theme.ts";

const STATUS_KEY = "todo";

export { getTodoCommandCompletions } from "./command-adapter.ts";

export const lightweightTodoParameters = Type.Object({
  action: StringEnum(TODO_PUBLIC_ACTIONS),
  title: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.title })),
  todoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  parentTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  beforeTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  afterTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  reason: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.reason })),
  summary: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.summary })),
});

type SurfaceOptions = {
  hasActiveSweTask?: (ctx: ExtensionContext) => boolean | Promise<boolean>;
};

type SurfaceResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: {
    todo?: TodoPublicItem;
    deletedCount?: number;
    state?: TodoCoreState;
    error?: { code: string; message: string };
  };
};

export function registerLightweightTodoSurface(pi: ExtensionAPI, options: SurfaceOptions = {}): void {
  const hasActiveSweTask = options.hasActiveSweTask ?? coordinatedActiveSwe;
  let queue: Promise<void> = Promise.resolve();
  let completionCore: BranchTodoCore | undefined;
  let completionMutationsAllowed = false;

  const bindCore = (ctx: ExtensionContext): BranchTodoCore => {
    completionCore = coreFor(pi, ctx);
    return completionCore;
  };
  const readOwnership = async (ctx: ExtensionContext): Promise<boolean | undefined> => {
    try { return await hasActiveSweTask(ctx); }
    catch { return undefined; }
  };
  const refreshSession = async (ctx: ExtensionContext): Promise<void> => {
    const core = bindCore(ctx);
    completionMutationsAllowed = await readOwnership(ctx) === false;
    updateDisplay(core, ctx);
  };
  pi.on("session_start", async (_event, ctx) => refreshSession(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshSession(ctx));

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "todo" || !isTodoPublicAction(event.input?.action)) return;
    const active = await readOwnership(ctx);
    if (active === undefined && event.input.action !== "list") {
      return { block: true, reason: "pi-swe lifecycle ownership scan is incomplete; mutation is blocked" };
    }
    const decision = coreFor(pi, ctx).ownership(event.input.action, active === true);
    if (decision.allowed) return;
    return {
      block: true,
      reason: "pi-swe lifecycle ownership: complete or pause the active SWE task before mutating pi-todo",
    };
  });

  const execute = async (request: TodoPublicRequest, ctx: ExtensionContext): Promise<SurfaceResult> => {
    const core = bindCore(ctx);
    const active = await readOwnership(ctx);
    completionMutationsAllowed = active === false;
    if (active === undefined && request.action !== "list") {
      return errorResult("PI_SWE_OWNERSHIP_UNKNOWN", "pi-swe ownership scan is incomplete; mutation is blocked", "Retry after lifecycle state is available, or inspect with todo list.");
    }
    const decision = core.ownership(request.action, active === true);
    if (!decision.allowed) {
      return errorResult("PI_SWE_OWNS_LIFECYCLE", "pi-swe lifecycle ownership is active", "Complete or pause active SWE work before mutating pi-todo; todo list remains available.");
    }
    try {
      const result = dispatch(core, request);
      updateDisplay(core, ctx);
      return result;
    } catch (error) {
      return errorResult(
        error instanceof TodoCoreError ? error.code : "INVALID_REQUEST",
        error instanceof Error ? error.message : String(error),
        todoRecoveryHint(core.state(), request.action),
      );
    }
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Small branch-aware focus list with subtasks and sibling reordering: create, move, delete, start, finish, block, unblock, and list.",
    promptSnippet: "Use todo to keep one active task. pi-swe owns lifecycle while an assessed workflow task is active.",
    parameters: lightweightTodoParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isTodoPublicAction(params.action)) return errorResult("INVALID_REQUEST", "unsupported todo action", "Inspect current state with todo list and retry with a supported action.");
      const run = queue.then(async () => {
        signal?.throwIfAborted();
        try {
          return await execute(requestFrom(params.action, params), ctx);
        } catch (error) {
          return errorResult("INVALID_REQUEST", error instanceof Error ? error.message : String(error), "Inspect current state with todo list and retry with the required fields.");
        }
      });
      queue = run.then(() => undefined, () => undefined);
      const result = await run;
      signal?.throwIfAborted();
      return result;
    },
  });

  pi.registerCommand("todo", {
    description: "Manage the branch-aware focus list · /todo <action> [arguments]",
    getArgumentCompletions: (prefix) => getTodoCommandCompletions(prefix, safeState(completionCore), completionMutationsAllowed),
    handler: async (args, ctx) => {
      const core = bindCore(ctx as ExtensionContext);
      if (!args.trim()) {
        const active = await readOwnership(ctx as ExtensionContext);
        completionMutationsAllowed = active === false;
        const ownershipMessage = active === undefined
          ? "Lifecycle ownership is unavailable; todo mutations are blocked until it can be determined."
          : undefined;
        ctx.ui.notify(renderTodoQuickHelp(core.state(), completionMutationsAllowed, ownershipMessage), "info");
        return;
      }
      if (args.trim() === "open") {
        await openTodoDocket(pi, ctx);
        return;
      }
      const request = commandRequest(args);
      if (!request) {
        ctx.ui.notify(`${renderUsage(TODO_COMMAND_ACTIONS)}\n${todoRecoveryHint(core.state(), args.trim().split(/\s+/, 1)[0])}`, "warning");
        return;
      }
      const result = await execute(request, ctx);
      ctx.ui.notify(result.content[0]?.text ?? "", result.details.error ? "error" : "info");
    },
  });
}

function coreFor(pi: ExtensionAPI, ctx: ExtensionContext): BranchTodoCore {
  return new BranchTodoCore({
    getBranch: () => ctx.sessionManager.getBranch() as never,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
  });
}

function dispatch(core: BranchTodoCore, request: TodoPublicRequest): SurfaceResult {
  if (request.action === "list") {
    const state = core.state();
    return {
      content: [{ type: "text", text: renderList(state) }],
      details: { state },
    };
  }
  if (request.action === "delete") {
    const { todo, deletedCount } = core.delete(request.todoId);
    const next = nextCommand(core.state());
    return {
      content: [{ type: "text", text: `Deleted ${todo.title} (${deletedCount} todo${deletedCount === 1 ? "" : "s"}) [${todo.id}].${next ? ` Next: ${next}` : ""}` }],
      details: { todo, deletedCount },
    };
  }
  const todo = request.action === "create" ? core.create(request.title, request.parentTodoId)
    : request.action === "move" ? core.move(request.todoId, request.beforeTodoId, request.afterTodoId)
    : request.action === "start" ? core.start(request.todoId)
    : request.action === "finish" ? core.finish(request.todoId, request.summary)
    : request.action === "block" ? core.block(request.todoId, request.reason)
    : core.unblock(request.todoId);
  return {
    content: [{ type: "text", text: `${verb(request.action)} ${todo.title} [${todo.status}] (${todo.id}). ${followUp(request.action, todo.id, core.state())}` }],
    details: { todo },
  };
}

function requestFrom(action: TodoPublicAction, params: Record<string, unknown>): TodoPublicRequest {
  if (action === "create") return { action, title: stringParam(params.title, "title"), parentTodoId: optionalString(params.parentTodoId) };
  if (action === "move") return {
    action,
    todoId: stringParam(params.todoId, "todoId"),
    beforeTodoId: optionalString(params.beforeTodoId),
    afterTodoId: optionalString(params.afterTodoId),
  };
  if (action === "delete" || action === "start" || action === "unblock") return { action, todoId: stringParam(params.todoId, "todoId") };
  if (action === "finish") return { action, todoId: optionalString(params.todoId), summary: optionalString(params.summary) };
  if (action === "block") return { action, todoId: optionalString(params.todoId), reason: stringParam(params.reason, "reason") };
  return { action };
}

function commandRequest(args: string): TodoPublicRequest | undefined {
  const input = args.trim();
  if (!input || input === "list") return { action: "list" };
  const space = input.indexOf(" ");
  const action = space === -1 ? input : input.slice(0, space);
  const rest = space === -1 ? "" : input.slice(space + 1).trim();
  if (action === "create" && rest) {
    const parentMarker = rest.lastIndexOf(" --parent ");
    if (parentMarker > 0) {
      const title = rest.slice(0, parentMarker).trim();
      const parentTodoId = rest.slice(parentMarker + " --parent ".length).trim();
      if (title && parentTodoId && !/\s/.test(parentTodoId)) return { action, title, parentTodoId };
      return undefined;
    }
    return { action, title: rest };
  }
  if (action === "move") {
    const match = /^(\S+)\s+(before|after)\s+(\S+)$/.exec(rest);
    if (match) return match[2] === "before"
      ? { action, todoId: match[1]!, beforeTodoId: match[3]! }
      : { action, todoId: match[1]!, afterTodoId: match[3]! };
  }
  if ((action === "delete" || action === "start") && rest && !/\s/.test(rest)) return { action, todoId: rest };
  if (action === "finish") return { action, todoId: rest || undefined };
  if (action === "unblock" && rest) return { action, todoId: rest };
  if (action === "block") {
    const separator = rest.indexOf(" ");
    if (separator > 0 && rest.slice(separator + 1).trim()) {
      return { action, todoId: rest.slice(0, separator), reason: rest.slice(separator + 1).trim() };
    }
  }
  return undefined;
}

async function openTodoDocket(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const core = coreFor(pi, ctx as ExtensionContext);
  const state = core.state();
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(renderTodoDocketLines(state, plainTodoTheme, { width: 92, includeDone: true }).join("\n") || "No todos.", "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new LightweightTodoModal({
    state,
    theme,
    requestRender: () => tui.requestRender(),
    close: () => done(undefined),
    terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40,
  }), {
    overlay: true,
    overlayOptions: {
      width: "80%",
      minWidth: 44,
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    },
  });
}

function updateDisplay(core: BranchTodoCore, ctx: ExtensionContext | ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  const state = core.state();
  const active = state.activeTodoId ? state.todos[state.activeTodoId] : undefined;
  const open = state.order.map((id) => state.todos[id]).filter((todo) => todo && todo.status !== "completed");
  ctx.ui.setStatus(STATUS_KEY, active ? `todo: ${active.title}` : open.length ? `todo: ${open.length} open` : undefined);
  if (ctx.mode === "tui") {
    ctx.ui.setWidget(STATUS_KEY, state.order.length
      ? (_tui, theme) => createTodoDocketComponent(state, theme)
      : undefined);
  } else if (ctx.mode === "rpc") {
    ctx.ui.setWidget(STATUS_KEY, state.order.length
      ? renderTodoDocketLines(state, plainTodoTheme, { width: 92 })
      : undefined);
  }
}

function renderList(state: TodoCoreState): string {
  const rows = orderedTodoRows(state, true);
  return rows.length ? rows.map(({ todo, depth }) => `${"  ".repeat(depth)}${todo.title} [${todo.status}] (${todo.id})${todo.blockedReason ? ` — ${todo.blockedReason}` : ""}`).join("\n") : "No todos.";
}

function verb(action: Exclude<TodoPublicAction, "list" | "delete">): string {
  return action === "create" ? "Created" : action === "move" ? "Moved" : action === "start" ? "Started" : action === "finish" ? "Finished" : action === "block" ? "Blocked" : "Unblocked";
}

function followUp(action: Exclude<TodoPublicAction, "list" | "delete">, todoId: string, state: TodoCoreState): string {
  if (action === "start") return `Next: /todo finish ${todoId} or /todo block ${todoId} <reason>`;
  if (action === "block") return `Next: /todo unblock ${todoId}`;
  if (action === "unblock" || action === "create") return state.activeTodoId
    ? `Active todo remains ${state.activeTodoId}.`
    : `Next: /todo start ${todoId}`;
  return nextCommand(state) ? `Next: ${nextCommand(state)}` : "No ready todo remains; create one with /todo create <title>.";
}

function nextCommand(state: TodoCoreState): string | undefined {
  if (state.activeTodoId) return `/todo finish ${state.activeTodoId}`;
  const ready = state.order.map((id) => state.todos[id]).find((todo) => todo?.status === "ready");
  if (ready) return `/todo start ${ready.id}`;
  const blocked = state.order.map((id) => state.todos[id]).find((todo) => todo?.status === "external_blocked");
  return blocked ? `/todo unblock ${blocked.id}` : undefined;
}

function safeState(core: BranchTodoCore | undefined): TodoCoreState | undefined {
  if (!core) return undefined;
  try { return core.state(); }
  catch { return undefined; }
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorResult(code: string, message: string, recovery?: string): SurfaceResult {
  const bounded = message.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "todo operation failed";
  const boundedRecovery = recovery?.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    content: [{ type: "text", text: `Error: ${bounded}${boundedRecovery ? ` Next: ${boundedRecovery}` : ""}` }],
    isError: true,
    details: { error: { code, message: bounded } },
  };
}
