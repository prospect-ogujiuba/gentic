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
  TODO_SCOPES,
  TODO_TEXT_LIMITS,
  isTodoPublicAction,
  isTodoScope,
  type TodoPublicAction,
  type TodoPublicItem,
  type TodoPublicRequest,
  type TodoScope,
} from "../../../../src/todo-contracts/contract.ts";
import { BranchTodoCore, TodoCoreError, type TodoCoreState } from "../domain/state-core.ts";
import { NO_TODO_CAPABILITIES, type TodoBackend, type TodoMutationResult, type TodoView, type TodoViewItem } from "../../../../src/todo-contracts/provider.ts";
import { ProjectTodoBackend, projectSessionTodoView } from "../app/project-backend.ts";
import { ProjectTodoStoreError } from "../app/project-store.ts";
import { WorkflowTodoError } from "../../../../src/todo-contracts/provider.ts";
import { createTodoDocketComponent, orderedTodoRows, renderTodoDocketLines } from "../ui/docket.ts";
import { createSharedDocketComponent, renderSharedDocketLines } from "../../../../src/ui/todo-view/docket.ts";
import { LightweightTodoModal, TodoDocketModal } from "../ui/modal.ts";
import { plainTodoTheme } from "../../../../src/ui/todo-view/theme.ts";

const STATUS_KEY = "todo";

export { getTodoCommandCompletions } from "./command-adapter.ts";

export const lightweightTodoParameters = Type.Object({
  action: StringEnum(TODO_PUBLIC_ACTIONS),
  scope: Type.Optional(StringEnum(TODO_SCOPES)),
  title: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.title })),
  todoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  parentTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  beforeTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  afterTodoId: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.todoId })),
  reason: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.reason })),
  summary: Type.Optional(Type.String({ maxLength: TODO_TEXT_LIMITS.summary })),
});

type SurfaceOptions = {
  /** Resolve afresh for every operation. Undefined means no active initiative authority. */
  resolveWorkflowBackend?: (ctx: ExtensionContext) => TodoBackend | undefined | Promise<TodoBackend | undefined>;
  resolveProjectBackend?: (ctx: ExtensionContext) => TodoBackend | Promise<TodoBackend>;
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
  const resolveProjectBackend = options.resolveProjectBackend ?? ((ctx: ExtensionContext) => new ProjectTodoBackend(ctx.cwd));
  let queue: Promise<void> = Promise.resolve();
  let completionCore: BranchTodoCore | undefined;
  let completionWorkflowView: TodoView | undefined;
  let completionProjectView: TodoView | undefined;

  const bindCore = (ctx: ExtensionContext): BranchTodoCore => (completionCore = coreFor(pi, ctx));
  const readWorkflowBackend = async (ctx: ExtensionContext) => resolveWorkflowBackend(ctx);
  const readProjectBackend = async (ctx: ExtensionContext) => resolveProjectBackend(ctx);
  const refreshSession = async (ctx: ExtensionContext): Promise<void> => {
    const core = bindCore(ctx);
    try {
      const workflow = await readWorkflowBackend(ctx);
      completionWorkflowView = workflow ? await workflow.view() : undefined;
    } catch (error) {
      completionWorkflowView = undefined;
      updateUnavailableDisplay(ctx, error);
      return;
    }
    try { completionProjectView = await (await readProjectBackend(ctx)).view(); } catch { completionProjectView = undefined; }
    if (completionWorkflowView) updateWorkflowDisplay(completionWorkflowView, ctx);
    else updateDisplay(core, ctx);
  };
  pi.on("session_start", async (_event, ctx) => refreshSession(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshSession(ctx));

  const execute = async (request: TodoPublicRequest, ctx: ExtensionContext): Promise<SurfaceResult> => {
    try {
      const workflow = request.scope === "session" || request.scope === "project" ? undefined : await readWorkflowBackend(ctx);
      const scope = request.scope ?? (workflow ? "initiative" : "session");
      const core = bindCore(ctx);
      if (scope === "all") {
        if (request.action !== "list") throw new Error("all scope is read-only; choose session, project, or initiative");
        const views = [projectSessionTodoView(core.state()), await (await readProjectBackend(ctx)).view()];
        if (workflow) views.push(await workflow.view());
        const view = combineViews(views);
        return { content: [{ type: "text", text: renderScopedList(view) }], details: { view } };
      }
      if (scope === "initiative") {
        if (!workflow) throw new Error("no focused active initiative todo authority");
        const result = await workflow.execute(request);
        completionWorkflowView = result.view;
        updateWorkflowDisplay(result.view, ctx);
        return workflowResult(request.action, result.view, result.item);
      }
      if (scope === "project") {
        const result = await (await readProjectBackend(ctx)).execute(request);
        completionProjectView = result.view;
        return backendResult(request.action, result);
      }
      const result = dispatch(core, request);
      updateDisplay(core, ctx);
      return result;
    } catch (error) {
      const core = safeCore(pi, ctx);
      return errorResult(
        error instanceof TodoCoreError || error instanceof WorkflowTodoError || error instanceof ProjectTodoStoreError ? error.code : "INVALID_REQUEST",
        error instanceof Error ? error.message : String(error),
        error instanceof WorkflowTodoError ? "Use swe status or an intentional swe revise operation for unsupported workflow changes." : todoRecoveryHint(core.state(), request.action),
      );
    }
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Unified session, tracked project, and focused initiative todo authorities. Project mutations require explicit project scope.",
    promptSnippet: "Use todo for lightweight work. Unscoped calls select focused initiative work when active, otherwise session work; use scope project explicitly for tracked project todos.",
    parameters: lightweightTodoParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isTodoPublicAction(params.action) || (params.scope !== undefined && !isTodoScope(params.scope))) return errorResult("INVALID_REQUEST", "unsupported todo action or scope");
      const run = queue.then(async () => {
        signal?.throwIfAborted();
        try { return await execute(requestFrom(params.action, params), ctx); }
        catch (error) { return errorResult("INVALID_REQUEST", error instanceof Error ? error.message : String(error), "Inspect current state with todo list and retry with the required fields."); }
      });
      queue = run.then(() => undefined, () => undefined);
      const result = await run;
      signal?.throwIfAborted();
      return result;
    },
  });

  pi.registerCommand("todo", {
    description: "Manage todo authorities · /todo [session|project|initiative|all] <action>",
    getArgumentCompletions: (prefix) => scopedCompletions(prefix, completionCore, completionProjectView, completionWorkflowView),
    handler: async (args, ctx) => {
      const extensionCtx = ctx as ExtensionContext;
      let workflow: TodoBackend | undefined;
      try {
        workflow = await readWorkflowBackend(extensionCtx);
        completionWorkflowView = workflow ? await workflow.view() : undefined;
      } catch (error) {
        if (!/^(session|project)\s+/.test(args.trim())) {
          ctx.ui.notify(`Todo authority is unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      if (/^(project|all)\s+/.test(args.trim())) {
        try { completionProjectView = await (await readProjectBackend(extensionCtx)).view(); }
        catch (error) { ctx.ui.notify(`Project todo authority is unavailable: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
      }
      const core = bindCore(extensionCtx);
      if (!args.trim()) {
        if (workflow) ctx.ui.notify(`${renderWorkflowList(await workflow.view())}\n\nAuthority: initiative. Use /todo session list or /todo project list for other scopes.`, "info");
        else ctx.ui.notify(`${renderTodoQuickHelp(core.state(), true)}\nScope: session · also available: /todo project list, /todo all list`, "info");
        return;
      }
      const openMatch = /^(?:(session|project|initiative|all)\s+)?open$/.exec(args.trim());
      if (openMatch) {
        const scope = openMatch[1] as TodoScope | undefined;
        if (scope === "session" || (!scope && !workflow)) await openTodoDocket(pi, ctx);
        else await openScopedDocket(pi, ctx, scope, core, workflow, await readProjectBackend(extensionCtx));
        return;
      }
      const request = commandRequest(args);
      if (!request) {
        ctx.ui.notify(`${renderUsage(TODO_COMMAND_ACTIONS)}\nScopes: session, project, initiative, all (all is list/open only).`, "warning");
        return;
      }
      const result = await execute(request, extensionCtx);
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
  const scope = isTodoScope(params.scope) ? params.scope : undefined;
  if (action === "create") return { action, scope, title: stringParam(params.title, "title"), parentTodoId: optionalString(params.parentTodoId) };
  if (action === "move") return {
    action,
    scope,
    todoId: stringParam(params.todoId, "todoId"),
    beforeTodoId: optionalString(params.beforeTodoId),
    afterTodoId: optionalString(params.afterTodoId),
  };
  if (action === "delete" || action === "start" || action === "unblock") return { action, scope, todoId: stringParam(params.todoId, "todoId") };
  if (action === "finish") return { action, scope, todoId: optionalString(params.todoId), summary: optionalString(params.summary) };
  if (action === "block") return { action, scope, todoId: optionalString(params.todoId), reason: stringParam(params.reason, "reason") };
  return { action, scope };
}

function commandRequest(args: string): TodoPublicRequest | undefined {
  let input = args.trim();
  let scope: TodoScope | undefined;
  const scopeMatch = /^(session|project|initiative|all)(?:\s+([\s\S]+))?$/.exec(input);
  if (scopeMatch) { scope = scopeMatch[1] as TodoScope; input = scopeMatch[2]?.trim() ?? ""; }
  if (!input || input === "list") return { action: "list", scope };
  if (scope === "all") return undefined;
  const space = input.indexOf(" ");
  const action = space === -1 ? input : input.slice(0, space);
  const rest = space === -1 ? "" : input.slice(space + 1).trim();
  if (action === "create" && rest) {
    const parentMarker = rest.lastIndexOf(" --parent ");
    if (parentMarker > 0) {
      const title = rest.slice(0, parentMarker).trim();
      const parentTodoId = rest.slice(parentMarker + " --parent ".length).trim();
      if (title && parentTodoId && !/\s/.test(parentTodoId)) return { action, scope, title, parentTodoId };
      return undefined;
    }
    return { action, scope, title: rest };
  }
  if (action === "move") {
    const match = /^(\S+)\s+(before|after)\s+(\S+)$/.exec(rest);
    if (match) return match[2] === "before"
      ? { action, scope, todoId: match[1]!, beforeTodoId: match[3]! }
      : { action, scope, todoId: match[1]!, afterTodoId: match[3]! };
  }
  if ((action === "delete" || action === "start") && rest && !/\s/.test(rest)) return { action, scope, todoId: rest };
  if (action === "finish") return { action, scope, todoId: rest || undefined };
  if (action === "unblock" && rest) return { action, scope, todoId: rest };
  if (action === "block") {
    const separator = rest.indexOf(" ");
    if (separator > 0 && rest.slice(separator + 1).trim()) {
      return { action, scope, todoId: rest.slice(0, separator), reason: rest.slice(separator + 1).trim() };
    }
  }
  return undefined;
}

function backendResult(action: TodoPublicAction, result: TodoMutationResult): SurfaceResult {
  if (action === "list") return { content: [{ type: "text", text: renderScopedList(result.view) }], details: { view: result.view } };
  const label = result.item ? `${result.item.title} [${result.item.rawStatus}] (${result.item.scope}:${result.item.id})` : "project todo";
  const text = action === "delete"
    ? `Deleted ${label} (${result.deletedCount ?? 0} todo${result.deletedCount === 1 ? "" : "s"}).`
    : `${verb(action)} ${label}.`;
  return { content: [{ type: "text", text }], details: { todo: result.item, deletedCount: result.deletedCount, view: result.view } };
}

function combineViews(views: TodoView[]): TodoView {
  return {
    provider: "combined",
    scope: "all",
    authorityId: "session + project + initiative",
    items: views.flatMap((view) => view.items.map((item) => ({
      ...item,
      id: `${item.scope}:${item.id}`,
      parentId: item.parentId ? `${item.scope}:${item.parentId}` : undefined,
      capabilities: NO_TODO_CAPABILITIES,
    }))),
  };
}

function renderScopedList(view: TodoView): string {
  if (!view.items.length) return `No ${view.scope} todos.`;
  return view.items.map((item) => `${"  ".repeat(item.depth)}[${item.scope}] ${item.title} [${item.rawStatus}] (${item.id})`).join("\n");
}

function scopedCompletions(prefix: string, core?: BranchTodoCore, project?: TodoView, workflow?: TodoView) {
  const normalized = prefix.trimStart();
  const scoped = /^(session|project|initiative|all)\s+(.*)$/s.exec(normalized);
  if (scoped) {
    const scope = scoped[1] as TodoScope;
    const remainder = scoped[2]!;
    const values = scope === "all"
      ? getTodoCommandCompletions(remainder).filter((item) => item.value === "open" || item.value === "list")
      : scope === "initiative"
        ? (workflow ? getWorkflowTodoCommandCompletions(remainder, workflow) : [])
        : getTodoCommandCompletions(remainder, scope === "session" ? safeState(core) : project ? coreStateFromView(project) : undefined, true);
    return values.map((item) => ({ ...item, value: `${scope} ${item.value}` }));
  }
  if (!/\s/.test(normalized)) {
    const actions = workflow ? getWorkflowTodoCommandCompletions(normalized, workflow) : getTodoCommandCompletions(normalized, safeState(core), true);
    const scopes = TODO_SCOPES.filter((scope) => scope.startsWith(normalized)).map((scope) => ({ value: scope, label: scope, description: `/todo ${scope} <action> · explicit ${scope} authority` }));
    return [...scopes, ...actions];
  }
  return workflow ? getWorkflowTodoCommandCompletions(normalized, workflow) : getTodoCommandCompletions(normalized, safeState(core), true);
}

function coreStateFromView(view: TodoView): TodoCoreState {
  const state: TodoCoreState = { todos: {}, order: [] };
  for (const item of view.items) {
    const status = item.rawStatus as TodoPublicItem["status"];
    state.todos[item.id] = { id: item.id, title: item.title, status, parentTodoId: item.parentId, blockedReason: item.blockedReason };
    state.order.push(item.id);
    if (status === "in_progress") state.activeTodoId = item.id;
  }
  return state;
}

async function openScopedDocket(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  requestedScope: TodoScope | undefined,
  core: BranchTodoCore,
  workflow: TodoBackend | undefined,
  project: TodoBackend,
): Promise<void> {
  const scope = requestedScope ?? (workflow ? "initiative" : "session");
  if (scope === "session") return openTodoDocket(pi, ctx);
  if (scope === "initiative" && !workflow) { ctx.ui.notify("No focused active initiative todo authority.", "warning"); return; }
  const view = scope === "all"
    ? combineViews([projectSessionTodoView(core.state()), await project.view(), ...(workflow ? [await workflow.view()] : [])])
    : await (scope === "initiative" ? workflow! : project).view();
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(renderSharedDocketLines(view, plainTodoTheme, { width: 92, includeDone: true, limit: 100 }).join("\n") || `No ${scope} todos.`, "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TodoDocketModal({
    view, theme, requestRender: () => tui.requestRender(), close: () => done(undefined),
    terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40,
  }), { overlay: true, overlayOptions: { width: "80%", minWidth: 44, maxHeight: "85%", anchor: "center", margin: 1 } });
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

function updateUnavailableDisplay(ctx: ExtensionContext | ExtensionCommandContext, error: unknown): void {
  if (!ctx.hasUI) return;
  try { ctx.ui.setStatus(STATUS_KEY, "todo: unavailable"); } catch { /* UI failure is non-authoritative. */ }
  try { ctx.ui.setWidget(STATUS_KEY, undefined); } catch { /* UI failure is non-authoritative. */ }
  try { ctx.ui.notify(`Todo authority is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  catch { /* UI failure is non-authoritative. */ }
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
