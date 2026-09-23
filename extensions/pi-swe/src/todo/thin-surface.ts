import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { renderUsage } from "../../../../src/command-guidance.ts";
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
import type { TodoBackend, TodoView, TodoViewItem } from "./provider.ts";
import { WorkflowTodoError } from "./workflow-backend.ts";
import { createTodoDocketComponent, orderedTodoRows, renderTodoDocketLines } from "./ui/docket.ts";
import { createSharedDocketComponent, renderSharedDocketLines } from "./ui/shared-docket.ts";
import { LightweightTodoModal, TodoDocketModal } from "./ui/modal.ts";
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
  /** Resolve afresh for every operation. Undefined selects branch authority. */
  resolveWorkflowBackend?: (ctx: ExtensionContext) => TodoBackend | undefined | Promise<TodoBackend | undefined>;
};

export type TodoSurfaceController = {
  refresh(ctx: ExtensionContext): Promise<void>;
};

type SurfaceResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: {
    todo?: TodoPublicItem | TodoViewItem;
    deletedCount?: number;
    state?: TodoCoreState;
    view?: TodoView;
    error?: { code: string; message: string };
  };
};

export function registerLightweightTodoSurface(pi: ExtensionAPI, options: SurfaceOptions = {}): TodoSurfaceController {
  const resolveWorkflowBackend = options.resolveWorkflowBackend ?? (() => undefined);
  let queue: Promise<void> = Promise.resolve();
  let completionCore: BranchTodoCore | undefined;
  let completionView: TodoView | undefined;
  let completionMutationsAllowed = false;

  const bindCore = (ctx: ExtensionContext): BranchTodoCore => {
    completionCore = coreFor(pi, ctx);
    return completionCore;
  };
  const readWorkflowBackend = async (ctx: ExtensionContext): Promise<TodoBackend | undefined> => resolveWorkflowBackend(ctx);
  const refreshSession = async (ctx: ExtensionContext): Promise<void> => {
    const workflow = await readWorkflowBackend(ctx);
    if (workflow) {
      completionMutationsAllowed = false;
      completionView = await workflow.view();
      updateWorkflowDisplay(completionView, ctx);
      return;
    }
    completionView = undefined;
    const core = bindCore(ctx);
    completionMutationsAllowed = true;
    updateDisplay(core, ctx);
  };
  pi.on("session_start", async (_event, ctx) => refreshSession(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshSession(ctx));

  const execute = async (request: TodoPublicRequest, ctx: ExtensionContext): Promise<SurfaceResult> => {
    try {
      const workflow = await readWorkflowBackend(ctx);
      if (workflow) {
        completionMutationsAllowed = false;
        const result = await workflow.execute(request);
        completionView = result.view;
        updateWorkflowDisplay(result.view, ctx);
        return workflowResult(request.action, result.view, result.item);
      }
      completionView = undefined;
      const core = bindCore(ctx);
      completionMutationsAllowed = true;
      const result = dispatch(core, request);
      updateDisplay(core, ctx);
      return result;
    } catch (error) {
      const core = safeCore(pi, ctx);
      return errorResult(
        error instanceof TodoCoreError || error instanceof WorkflowTodoError ? error.code : "INVALID_REQUEST",
        error instanceof Error ? error.message : String(error),
        error instanceof WorkflowTodoError
          ? "Use swe status or an intentional swe revise operation for unsupported workflow changes."
          : todoRecoveryHint(core.state(), request.action),
      );
    }
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Unified focus list: branch-backed standalone todos, or the focused active SWE workflow projected directly from workflow.json.",
    promptSnippet: "Use todo for lightweight work. A focused active pi-swe initiative is projected without copying state; finish marks workflow work implemented.",
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
    description: "Manage standalone or focused workflow work · /todo <action> [arguments]",
    getArgumentCompletions: (prefix) => completionView
      ? getWorkflowTodoCommandCompletions(prefix, completionView)
      : getTodoCommandCompletions(prefix, safeState(completionCore), completionMutationsAllowed),
    handler: async (args, ctx) => {
      let workflow: TodoBackend | undefined;
      try { workflow = await readWorkflowBackend(ctx as ExtensionContext); }
      catch (error) {
        ctx.ui.notify(`Todo authority is unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      completionView = workflow ? await workflow.view() : undefined;
      completionMutationsAllowed = !workflow;
      const core = workflow ? undefined : bindCore(ctx as ExtensionContext);
      if (!args.trim()) {
        if (workflow) {
          const view = await workflow.view();
          ctx.ui.notify(`${renderWorkflowList(view)}\n\nWorkflow authority: start ready work or finish active work; use swe revise for structural changes.`, "info");
        } else {
          ctx.ui.notify(renderTodoQuickHelp(core!.state(), true), "info");
        }
        return;
      }
      if (args.trim() === "open") {
        await openTodoDocket(pi, ctx, workflow);
        return;
      }
      const request = commandRequest(args);
      if (!request) {
        ctx.ui.notify(`${renderUsage(TODO_COMMAND_ACTIONS)}\n${core ? todoRecoveryHint(core.state(), args.trim().split(/\s+/, 1)[0]) : "Use /swe status for current workflow lifecycle guidance."}`, "warning");
        return;
      }
      const result = await execute(request, ctx as ExtensionContext);
      ctx.ui.notify(result.content[0]?.text ?? "", result.details.error ? "error" : "info");
    },
  });

  return { refresh: refreshSession };
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

async function openTodoDocket(pi: ExtensionAPI, ctx: ExtensionCommandContext, workflow?: TodoBackend): Promise<void> {
  if (workflow) {
    const view = await workflow.view();
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(renderSharedDocketLines(view, plainTodoTheme, { width: 92, includeDone: true, limit: 100 }).join("\n") || "No workflow work.", "info");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TodoDocketModal({
      view,
      theme,
      requestRender: () => tui.requestRender(),
      close: () => done(undefined),
      terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40,
    }), {
      overlay: true,
      overlayOptions: { width: "80%", minWidth: 44, maxHeight: "85%", anchor: "center", margin: 1 },
    });
    return;
  }
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

function updateWorkflowDisplay(view: TodoView, ctx: ExtensionContext | ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  const active = view.items.find((item) => item.status === "active");
  const open = view.items.filter((item) => item.executable && item.status !== "complete");
  ctx.ui.setStatus(STATUS_KEY, active ? `todo: ${active.title}` : open.length ? `todo: ${open.length} workflow` : undefined);
  if (ctx.mode === "tui") {
    ctx.ui.setWidget(STATUS_KEY, view.items.length ? (_tui, theme) => createSharedDocketComponent(view, theme) : undefined);
  } else if (ctx.mode === "rpc") {
    ctx.ui.setWidget(STATUS_KEY, view.items.length ? renderSharedDocketLines(view, plainTodoTheme, { width: 92 }) : undefined);
  }
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

function workflowResult(action: TodoPublicAction, view: TodoView, item?: TodoViewItem): SurfaceResult {
  if (action === "list") return { content: [{ type: "text", text: renderWorkflowList(view) }], details: { view } };
  const verb = action === "start" ? "Started" : "Marked implemented";
  return {
    content: [{ type: "text", text: `${verb} ${item?.title ?? "workflow work"} [${item?.rawStatus ?? "unknown"}] (${item?.id ?? "unknown"}).${action === "finish" ? " Complete verification and review through swe." : ""}` }],
    details: { todo: item, view },
  };
}

function renderWorkflowList(view: TodoView): string {
  const byId = new Map(view.items.map((item) => [item.id, item]));
  const depth = (item: TodoViewItem): number => {
    let value = 0; let parentId = item.parentId; const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) { seen.add(parentId); value += 1; parentId = byId.get(parentId)?.parentId; }
    return value;
  };
  const heading = `${view.authorityId} [${view.authorityStatus ?? "workflow"}]${view.revision ? ` r${view.revision}` : ""}`;
  return [heading, ...view.items.map((item) => `${"  ".repeat(depth(item))}${item.title} [${item.rawStatus}] (${item.id})`)].join("\n");
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

function getWorkflowTodoCommandCompletions(prefix: string, view: TodoView) {
  const normalized = prefix.trimStart();
  if (!/\s/.test(normalized)) {
    const supported = new Set(["open", "list"]);
    if (view.items.some((item) => item.capabilities.start)) supported.add("start");
    if (view.items.some((item) => item.capabilities.finish)) supported.add("finish");
    return getTodoCommandCompletions(normalized).filter((item) => supported.has(item.value));
  }
  const match = /^(start|finish)\s+(\S*)$/.exec(normalized);
  if (!match) return [];
  const action = match[1] as "start" | "finish";
  const idPrefix = match[2]!.toLowerCase();
  return view.items
    .filter((item) => item.capabilities[action] && item.id.toLowerCase().startsWith(idPrefix))
    .map((item) => ({
      value: `${action} ${item.id}`,
      label: item.id,
      description: `${item.rawStatus}${item.ready ? " · ready" : ""} · ${item.title}`,
    }));
}

function safeCore(pi: ExtensionAPI, ctx: ExtensionContext): BranchTodoCore {
  try { return coreFor(pi, ctx); }
  catch { return new BranchTodoCore({ getBranch: () => [], appendEntry: () => undefined }); }
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
