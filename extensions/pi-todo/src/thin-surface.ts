import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  TODO_PUBLIC_ACTIONS,
  isTodoPublicAction,
  type TodoPublicAction,
  type TodoPublicItem,
  type TodoPublicRequest,
} from "./contract.ts";
import { BranchTodoCore, TodoCoreError, type TodoCoreState } from "./state-core.ts";
import { hasActiveSweWorkflow } from "./pi/swe-ownership.ts";
import { createTodoDocketComponent, renderTodoDocketLines } from "./ui/docket.ts";
import { LightweightTodoModal } from "./ui/modal.ts";
import { plainTodoTheme } from "./ui/theme.ts";

const STATUS_KEY = "todo";

export const lightweightTodoParameters = Type.Object({
  action: StringEnum(TODO_PUBLIC_ACTIONS),
  title: Type.Optional(Type.String()),
  todoId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

type SurfaceOptions = {
  hasActiveSweTask?: (ctx: ExtensionContext) => boolean | Promise<boolean>;
};

type SurfaceResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    todo?: TodoPublicItem;
    state?: TodoCoreState;
    error?: { code: string; message: string };
  };
};

export function registerLightweightTodoSurface(pi: ExtensionAPI, options: SurfaceOptions = {}): void {
  const hasActiveSweTask = options.hasActiveSweTask ?? ((ctx: ExtensionContext) => hasActiveSweWorkflow(ctx.cwd));
  let queue: Promise<void> = Promise.resolve();

  pi.on("session_start", async (_event, ctx) => updateDisplay(coreFor(pi, ctx), ctx));
  pi.on("session_tree", async (_event, ctx) => updateDisplay(coreFor(pi, ctx), ctx));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "todo" || !isTodoPublicAction(event.input?.action)) return;
    const decision = coreFor(pi, ctx).ownership(event.input.action, await hasActiveSweTask(ctx));
    if (decision.allowed) return;
    return {
      block: true,
      reason: "pi-swe lifecycle ownership: complete or pause the active SWE task before mutating pi-todo",
    };
  });

  const execute = async (request: TodoPublicRequest, ctx: ExtensionContext): Promise<SurfaceResult> => {
    const core = coreFor(pi, ctx);
    const decision = core.ownership(request.action, await hasActiveSweTask(ctx));
    if (!decision.allowed) return errorResult("PI_SWE_OWNS_LIFECYCLE", "pi-swe lifecycle ownership is active");
    try {
      const result = dispatch(core, request);
      updateDisplay(core, ctx);
      return result;
    } catch (error) {
      return errorResult(error instanceof TodoCoreError ? error.code : "INVALID_REQUEST", error instanceof Error ? error.message : String(error));
    }
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Small branch-aware focus list: create, start, finish, block, unblock, and list.",
    promptSnippet: "Use todo to keep one active task. pi-swe owns lifecycle while an assessed workflow task is active.",
    parameters: lightweightTodoParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isTodoPublicAction(params.action)) return errorResult("INVALID_REQUEST", "unsupported todo action");
      const request = requestFrom(params.action, params);
      const run = queue.then(() => execute(request, ctx));
      queue = run.then(() => undefined, () => undefined);
      const result = await run;
      signal?.throwIfAborted();
      return result;
    },
  });

  pi.registerCommand("todo", {
    description: "/todo [open|list|create <title>|start <id>|finish [id]|block <id> <reason>|unblock <id>]",
    handler: async (args, ctx) => {
      if (args.trim() === "open") {
        await openTodoDocket(pi, ctx);
        return;
      }
      const request = commandRequest(args);
      if (!request) {
        ctx.ui.notify("Usage: /todo [open|list|create <title>|start <id>|finish [id]|block <id> <reason>|unblock <id>]", "warning");
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
    const todos = state.order.map((id) => state.todos[id]).filter((todo): todo is TodoPublicItem => Boolean(todo));
    return {
      content: [{ type: "text", text: renderList(todos) }],
      details: { state },
    };
  }
  const todo = request.action === "create" ? core.create(request.title)
    : request.action === "start" ? core.start(request.todoId)
    : request.action === "finish" ? core.finish(request.todoId, request.summary)
    : request.action === "block" ? core.block(request.todoId, request.reason)
    : core.unblock(request.todoId);
  return {
    content: [{ type: "text", text: `${verb(request.action)} ${todo.title} [${todo.status}]` }],
    details: { todo },
  };
}

function requestFrom(action: TodoPublicAction, params: Record<string, unknown>): TodoPublicRequest {
  if (action === "create") return { action, title: stringParam(params.title, "title") };
  if (action === "start" || action === "unblock") return { action, todoId: stringParam(params.todoId, "todoId") };
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
  if (action === "create" && rest) return { action, title: rest };
  if (action === "start" && rest) return { action, todoId: rest };
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
    ctx.ui.setWidget(STATUS_KEY, renderTodoDocketLines(state, plainTodoTheme, { width: 92 }));
  }
}

function renderList(todos: TodoPublicItem[]): string {
  return todos.length ? todos.map((todo) => `${todo.title} [${todo.status}]${todo.blockedReason ? ` — ${todo.blockedReason}` : ""}`).join("\n") : "No todos.";
}

function verb(action: Exclude<TodoPublicAction, "list">): string {
  return action === "create" ? "Created" : action === "start" ? "Started" : action === "finish" ? "Finished" : action === "block" ? "Blocked" : "Unblocked";
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorResult(code: string, message: string): SurfaceResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: { code, message } },
  };
}
