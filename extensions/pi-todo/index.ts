import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TodoService, type CreateTodoInput } from "./src/app/service.ts";
import { PiTodoEventStore } from "./src/pi/store.ts";
import {
  resetTodoSessionNameMemory,
  syncTodoSessionName,
} from "./src/pi/session-name.ts";
import type { EvidenceRef, Todo } from "./src/domain/types.ts";
import { summarizeTodos } from "./src/app/query.ts";
import {
  createTodoDocketComponent,
  renderTodoDocketLines,
} from "./src/ui/docket.ts";
import { openTodoModal } from "./src/ui/modal.ts";
import { ansiTodoTheme } from "./src/ui/theme.ts";

const STATUS_KEY = "todo";
const actions = [
  "create",
  "update",
  "split",
  "reprioritize",
  "link_dependency",
  "list",
  "get",
  "next",
  "next_ready",
  "claim",
  "renew",
  "release",
  "start",
  "block",
  "unblock",
  "complete",
  "fail",
  "verify",
  "reopen",
  "cancel",
  "abandon",
  "history",
  "graph",
] as const;
const TodoActionSchema = Type.Union(
  actions.map((action) => Type.Literal(action)) as [
    ReturnType<typeof Type.Literal>,
    ReturnType<typeof Type.Literal>,
    ...ReturnType<typeof Type.Literal>[],
  ],
);
const PrioritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
  Type.Literal("urgent"),
]);
const EvidenceSchema = Type.Array(
  Type.Object({
    type: Type.String(),
    path: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(Type.String())),
    command: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Number()),
    output: Type.Optional(Type.String()),
    outputSummary: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    recordedAt: Type.Optional(Type.String()),
    recordedBy: Type.Optional(Type.String()),
  }),
);
const ScopeSchema = Type.Object({
  repo: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  files: Type.Optional(Type.Array(Type.String())),
  component: Type.Optional(Type.String()),
  service: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  commands: Type.Optional(Type.Array(Type.String())),
  policyTags: Type.Optional(Type.Array(Type.String())),
});

function service(pi: ExtensionAPI, ctx: ExtensionContext): TodoService {
  return new TodoService(new PiTodoEventStore(pi, ctx));
}
function renderTodo(todo: Todo): string {
  return `[${todo.status}] ${todo.id} ${todo.title}`;
}
function normalizeEvidence(raw: unknown): EvidenceRef[] {
  return Array.isArray(raw) ? raw.map((item) => item as EvidenceRef) : [];
}
function mutationResult(action: string, todo: Todo) {
  return {
    content: [{ type: "text" as const, text: `${action} ${renderTodo(todo)}` }],
    details: { todo },
  };
}
function createInput(params: Record<string, unknown>): CreateTodoInput {
  return {
    title: String(params.title || ""),
    description: params.description as string | undefined,
    priority: params.priority as CreateTodoInput["priority"],
    acceptanceCriteria: params.acceptanceCriteria as string[] | undefined,
    definitionOfDone: params.definitionOfDone as string[] | undefined,
    dependsOn: params.dependsOn as string[] | undefined,
    tags: params.tags as string[] | undefined,
    scope: params.scope as CreateTodoInput["scope"],
    requiredCapabilities: params.requiredCapabilities as string[] | undefined,
    actor: params.actor as string | undefined,
  };
}
function updatePatch(params: Record<string, unknown>): Partial<Todo> {
  return Object.fromEntries(
    Object.entries({
      title: params.title,
      description: params.description,
      priority: params.priority,
      acceptanceCriteria: params.acceptanceCriteria,
      definitionOfDone: params.definitionOfDone,
      requiredCapabilities: params.requiredCapabilities,
      scope: params.scope,
    }).filter(([, value]) => value !== undefined),
  ) as Partial<Todo>;
}

async function updateWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state = await service(pi, ctx).state();
  const counts = summarizeTodos(state);
  syncTodoSessionName(pi, ctx, state);
  ctx.ui.setStatus(
    STATUS_KEY,
    `todo open ${counts.open} · active ${counts.byStatus.in_progress} · done ${counts.byStatus.done + counts.byStatus.completed + counts.byStatus.verified}`,
  );
  ctx.ui.setWidget(STATUS_KEY, createTodoDocketComponent(state));
}

async function executeTodoAction(pi: ExtensionAPI, ctx: ExtensionContext, params: Record<string, unknown>) {
  const svc = service(pi, ctx);
  if (params.action === "create") {
    const todo = await svc.create(createInput(params));
    await updateWidget(pi, ctx);
    return mutationResult("Created", todo);
  }
  if (params.action === "list") {
    const state = await svc.state();
    return { content: [{ type: "text" as const, text: renderTodoDocketLines(state, ansiTodoTheme, { width: 100, limit: 20, includeDone: params.includeDone as boolean | undefined }).join("\n") }], details: { state } };
  }
  if (params.action === "next" || params.action === "next_ready") {
    const todo = await svc.next({ actor: params.actor as string | undefined, actorCapabilities: params.actor_capabilities as string[] | undefined, actorScope: params.actor_scope as Parameters<TodoService["next"]>[0]["actorScope"] });
    return { content: [{ type: "text" as const, text: todo ? renderTodo(todo) : "No next todo." }], details: { todo } };
  }
  if (params.action === "graph") {
    const graph = await svc.graph(params.todoId as string | undefined);
    return { content: [{ type: "text" as const, text: JSON.stringify(graph) }], details: { graph } };
  }
  const todoId = params.todoId as string | undefined;
  if (!todoId) throw new Error("todoId is required for this action");
  if (params.action === "get") {
    const todo = await svc.get(todoId);
    return { content: [{ type: "text" as const, text: renderTodo(todo) }], details: { todo } };
  }
  if (params.action === "history") {
    const history = await svc.history(todoId);
    return { content: [{ type: "text" as const, text: history.map((event) => `${event.at} ${event.type}`).join("\n") }], details: { history } };
  }

  const todo = params.action === "claim" ? await svc.claim(todoId, params.actor as string | undefined, params.actor_capabilities as string[] | undefined, params.actor_scope as Parameters<TodoService["claim"]>[3], params.leaseMs as number | undefined)
    : params.action === "renew" ? await svc.renew(todoId, params.leaseMs as number | undefined)
    : params.action === "release" ? await svc.release(todoId, params.reason as string | undefined)
    : params.action === "start" ? await svc.start(todoId, params.actor as string | undefined)
    : params.action === "block" ? await svc.block(todoId, (params.reason as string | undefined) || "")
    : params.action === "unblock" ? await svc.unblock(todoId)
    : params.action === "cancel" ? await svc.cancel(todoId, params.reason as string | undefined)
    : params.action === "abandon" ? await svc.abandon(todoId, params.reason as string | undefined)
    : params.action === "complete" ? await svc.complete(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined)
    : params.action === "verify" ? await svc.verify(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined, params.actor_capabilities as string[] | undefined)
    : params.action === "fail" ? await svc.fail(todoId, params.reason as string | undefined, normalizeEvidence(params.evidence))
    : params.action === "reopen" ? await svc.reopen(todoId, params.reason as string | undefined)
    : params.action === "link_dependency" ? await svc.linkDependency(todoId, (params.dependencyTodoId as string | undefined) || "")
    : params.action === "split" ? (await svc.split(todoId, (params.children as CreateTodoInput[] | undefined) ?? [], (params.reason as string | undefined) || ""))[0]
    : params.action === "reprioritize" ? await svc.update(todoId, { priority: params.priority as Todo["priority"] | undefined })
    : params.action === "update" ? await svc.update(todoId, updatePatch(params))
    : undefined;
  if (!todo) throw new Error(`unsupported todo action: ${String(params.action)}`);
  await updateWidget(pi, ctx);
  return mutationResult(String(params.action), todo);
}

export default function piTodo(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") resetTodoSessionNameMemory();
    await updateWidget(pi, ctx);
  });
  pi.on("turn_end", async (_event, ctx) => updateWidget(pi, ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Unified Gentic todo ledger tool with create/update/split/claim/start/block/complete/verify/reopen/list/get/history/graph actions.",
    promptSnippet:
      "Use todo as the unified Gentic todo ledger tool for durable planning and lifecycle actions.",
    parameters: Type.Object({
      action: TodoActionSchema,
      todoId: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(PrioritySchema),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      definitionOfDone: Type.Optional(Type.Array(Type.String())),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      reason: Type.Optional(Type.String()),
      actor: Type.Optional(Type.String()),
      actor_capabilities: Type.Optional(Type.Array(Type.String())),
      actor_scope: Type.Optional(ScopeSchema),
      requiredCapabilities: Type.Optional(Type.Array(Type.String())),
      scope: Type.Optional(ScopeSchema),
      dependencyTodoId: Type.Optional(Type.String()),
      leaseMs: Type.Optional(Type.Number()),
      children: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.Optional(Type.String()),
          }),
        ),
      ),
      evidence: Type.Optional(EvidenceSchema),
      summary: Type.Optional(Type.String()),
      includeDone: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeTodoAction(pi, ctx, params);
    },
  });

  pi.registerCommand("todo", {
    description:
      "Open the Gentic todo dashboard. Observability: /todo list, /todo next, /todo graph <id>, /todo history <id>, /todo get <id>.",
    getArgumentCompletions: (prefix) =>
      ["open", "list", "next", "graph", "history", "get"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [subcommandRaw, id] = args.trim().split(/\s+/, 2);
      const subcommand = subcommandRaw || "open";
      if (subcommand === "open") {
        await openTodoModal(pi, ctx);
        await updateWidget(pi, ctx);
        return;
      }
      if (!["list", "next", "graph", "history", "get"].includes(subcommand)) {
        ctx.ui.notify("Unknown /todo command. Use /todo, /todo list, /todo next, /todo graph <id>, /todo history <id>, or /todo get <id>.", "error");
        return;
      }
      const result = await executeTodoAction(pi, ctx, { action: subcommand === "next" ? "next_ready" : subcommand, todoId: id });
      ctx.ui.notify(result.content.map((item) => item.text).join("\n"), "info");
    },
  });
}
