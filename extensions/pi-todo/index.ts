import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TodoService, type CreateArtifactInput, type CreateTodoInput } from "./src/app/service.ts";
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
  "split_check",
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
  "attach_evidence",
  "record_artifact",
  "create_artifact",
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
    createdByTodoId: Type.Optional(Type.String()),
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
  return `${todo.id} ${todo.title} - [${todo.status}]`;
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
  };
}
function artifactInput(params: Record<string, unknown>): CreateArtifactInput {
  return {
    kind: (params.kind as CreateArtifactInput["kind"] | undefined) ?? "plans",
    shortName: String(params.shortName || params.title || "artifact"),
    purpose: String(params.purpose || params.summary || "generated artifact"),
    content: String(params.content || ""),
    category: params.category as string | undefined,
    subcategory: params.subcategory as string | undefined,
  };
}

function splitCheckText(todo: Todo, result: Awaited<ReturnType<TodoService["splitCheck"]>>): string {
  const lines = [
    `task: ${todo.id}`,
    `assessment: ${result.assessment}`,
    `confidence: ${result.confidence}`,
    "reasons:",
    ...result.reasons.map((reason) => `  - ${reason}`),
    `recommended child count: ${result.recommendedChildCount}`,
  ];
  if (result.suggestedChildren.length > 0) lines.push("suggested children:", ...result.suggestedChildren.map((child, index) => `  ${index + 1}. ${child.title}`));
  return lines.join("\n");
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

function activeTodo(state: Awaited<ReturnType<TodoService["state"]>>): Todo | undefined {
  return Object.values(state.todos).find((todo) => todo.status === "in_progress" || todo.status === "claimed");
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
    `todo open ${counts.open} · active ${counts.byStatus.in_progress} · done ${counts.byStatus.completed + counts.byStatus.verified}`,
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
    return { content: [{ type: "text" as const, text: renderTodoDocketLines(state, ansiTodoTheme, { width: 100, limit: 20, includeDone: params.includeDone as boolean | undefined, detail: "summary" }).join("\n") }], details: { state } };
  }
  if (params.action === "next" || params.action === "next_ready") {
    const todo = await svc.next();
    return { content: [{ type: "text" as const, text: todo ? renderTodo(todo) : "No next todo." }], details: { todo } };
  }
  if (params.action === "graph") {
    const graph = await svc.graph(params.todoId as string | undefined);
    return { content: [{ type: "text" as const, text: JSON.stringify(graph) }], details: { graph } };
  }
  const todoIdParam = params.todoId as string | undefined;
  if (!todoIdParam) throw new Error("todoId is required for this action");
  const todoId = await svc.resolveId(todoIdParam);
  if (params.action === "get") {
    const todo = await svc.get(todoId);
    return { content: [{ type: "text" as const, text: renderTodo(todo) }], details: { todo } };
  }
  if (params.action === "history") {
    const history = await svc.history(todoId);
    return { content: [{ type: "text" as const, text: history.map((event) => `${event.at} ${event.type}`).join("\n") }], details: { history } };
  }
  if (params.action === "split_check") {
    const todo = await svc.get(todoId);
    const splitCheck = await svc.splitCheck(todoId);
    await updateWidget(pi, ctx);
    return { content: [{ type: "text" as const, text: splitCheckText(todo, splitCheck) }], details: { splitCheck } };
  }

  const owner = (params.owner as string | undefined) ?? ctx.sessionId ?? ctx.cwd ?? null;
  if (params.action === "split") {
    const parent = await svc.get(todoId);
    const existingChildren = params.children as CreateTodoInput[] | undefined;
    const splitCheck = await svc.splitCheck(todoId);
    const requestedCount = Math.max(1, Math.min(Number(params.count || splitCheck.recommendedChildCount || 3), 6));
    const children = existingChildren?.length ? existingChildren : params.auto ? splitCheck.suggestedChildren.slice(0, requestedCount).map((child) => ({ title: child.title, acceptanceCriteria: child.acceptanceCriteria })) : [];
    if (children.length === 0) throw new Error("split children are required unless auto is true");
    const reason = (params.reason as string | undefined) || `split assessment ${splitCheck.assessment}: ${splitCheck.reasons.join(", ")}`;
    if (params.auto && params.apply === false) {
      return { content: [{ type: "text" as const, text: splitCheckText(parent, { ...splitCheck, suggestedChildren: children }) }], details: { splitCheck, children } };
    }
    const created = await svc.split(todoId, children, reason);
    await updateWidget(pi, ctx);
    return { content: [{ type: "text" as const, text: `split ${todoId} into ${created.length} children\n${created.map(renderTodo).join("\n")}` }], details: { parent, children: created, splitCheck } };
  }
  const todo = params.action === "claim" ? await svc.claim(todoId, params.requiredCapabilities as string[] | undefined, params.leaseMs as number | undefined, owner)
    : params.action === "renew" ? await svc.renew(todoId, params.leaseMs as number | undefined)
    : params.action === "release" ? await svc.release(todoId, params.reason as string | undefined)
    : params.action === "start" ? await svc.start(todoId, params.requiredCapabilities as string[] | undefined, params.leaseMs as number | undefined, owner, { splitOverrideReason: params.reason as string | undefined })
    : params.action === "block" ? await svc.block(todoId, (params.reason as string | undefined) || "")
    : params.action === "unblock" ? await svc.unblock(todoId)
    : params.action === "cancel" ? await svc.cancel(todoId, params.reason as string | undefined)
    : params.action === "abandon" ? await svc.abandon(todoId, params.reason as string | undefined)
    : params.action === "complete" ? await svc.complete(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined)
    : params.action === "attach_evidence" ? await svc.attachEvidence(todoId, normalizeEvidence(params.evidence))
    : params.action === "record_artifact" ? await svc.attachEvidence(todoId, [{ type: "generated_artifact", path: String(params.path || ""), summary: String(params.summary || "generated artifact"), createdByTodoId: todoId, recordedAt: new Date().toISOString() }])
    : params.action === "create_artifact" ? (await svc.createArtifact(todoId, artifactInput(params))).todo
    : params.action === "verify" ? await svc.verify(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined, params.requiredCapabilities as string[] | undefined)
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
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "todo") return;
    const state = await service(pi, ctx).state();
    if (activeTodo(state)) return;
    await updateWidget(pi, ctx);
    return {
      block: true,
      reason: "pi-todo enforcement: use the todo tool first and claim/start a todo before using other tools.",
    };
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Unified Gentic todo ledger tool with create/update/split/split_check/claim/start/block/complete/attach_evidence/record_artifact/create_artifact/verify/reopen/list/get/history/graph actions.",
    promptSnippet:
      "Use todo first. Non-todo tools are blocked until a todo is claimed or started. Use todo as the unified Gentic todo ledger tool for durable planning and lifecycle actions. Generated notes, reports, plans, logs, TODO files, and artifacts belong under .model-artifacts/<kind>/<topic>/ and must be recorded with todo action=record_artifact. For TODO/planning artifacts use .model-artifacts/todo/<topic>/, where <topic> is preferably the concrete extension/project such as pi-todo, pi-swe, or gentic; use subfolders for coherent phase sets like pi-swe-phases.",
    parameters: Type.Object({
      action: TodoActionSchema,
      todoId: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([Type.Literal("reports"), Type.Literal("logs"), Type.Literal("specs"), Type.Literal("plans"), Type.Literal("findings"), Type.Literal("todo")])),
      category: Type.Optional(Type.String()),
      subcategory: Type.Optional(Type.String()),
      shortName: Type.Optional(Type.String()),
      purpose: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(PrioritySchema),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      definitionOfDone: Type.Optional(Type.Array(Type.String())),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      reason: Type.Optional(Type.String()),
      requiredCapabilities: Type.Optional(Type.Array(Type.String())),
      owner: Type.Optional(Type.String()),
      scope: Type.Optional(ScopeSchema),
      dependencyTodoId: Type.Optional(Type.String()),
      leaseMs: Type.Optional(Type.Number()),
      children: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.Optional(Type.String()),
            acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      ),
      auto: Type.Optional(Type.Boolean()),
      apply: Type.Optional(Type.Boolean()),
      count: Type.Optional(Type.Number()),
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
      ["open", "list", "next", "graph", "history", "get", "split-check"]
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
      if (!["list", "next", "graph", "history", "get", "split-check"].includes(subcommand)) {
        ctx.ui.notify("Unknown /todo command. Use /todo, /todo list, /todo next, /todo graph <id>, /todo history <id>, /todo get <id>, or /todo split-check <id>.", "error");
        return;
      }
      const action = subcommand === "next" ? "next_ready" : subcommand === "split-check" ? "split_check" : subcommand;
      const result = await executeTodoAction(pi, ctx, { action, todoId: id });
      ctx.ui.notify(result.content.map((item) => item.text).join("\n"), "info");
    },
  });
}
