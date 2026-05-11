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

export default function piTodo(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") resetTodoSessionNameMemory();
    await updateWidget(pi, ctx);
  });
  pi.on("turn_end", async (_event, ctx) => updateWidget(pi, ctx));

  pi.registerTool({
    name: "todo_create",
    label: "Todo Create",
    description: "Create a durable Gentic todo ledger item.",
    promptSnippet:
      "Create durable todo items with acceptance criteria before multi-step work.",
    promptGuidelines: [
      "Use todo_create for multi-step coding work and include acceptance criteria when known.",
    ],
    parameters: Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(PrioritySchema),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).create(params);
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Created ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });

  pi.registerTool({
    name: "todo_list",
    label: "Todo List",
    description: "List durable Gentic todo ledger items.",
    parameters: Type.Object({
      status: Type.Optional(Type.String()),
      includeDone: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = await service(pi, ctx).state();
      const todos = state.order
        .map((todoId) => state.todos[todoId])
        .filter(
          (todo) => todo && (!params.status || todo.status === params.status),
        );
      return {
        content: [
          {
            type: "text",
            text: renderTodoDocketLines(state, ansiTodoTheme, {
              width: 100,
              limit: 20,
              includeDone: params.includeDone,
            }).join("\n"),
          },
        ],
        details: { todos },
      };
    },
  });

  pi.registerTool({
    name: "todo_next",
    label: "Todo Next",
    description: "Return the deterministic next Gentic todo.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).next();
      return {
        content: [
          { type: "text", text: todo ? renderTodo(todo) : "No next todo." },
        ],
        details: { todo },
      };
    },
  });
  pi.registerTool({
    name: "todo_start",
    label: "Todo Start",
    description:
      "Start one Gentic todo, respecting dependency and max-active policy.",
    parameters: Type.Object({ todoId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).start(params.todoId);
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Started ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });
  pi.registerTool({
    name: "todo_block",
    label: "Todo Block",
    description: "Mark a Gentic todo blocked with a reason.",
    parameters: Type.Object({ todoId: Type.String(), reason: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).block(params.todoId, params.reason);
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Blocked ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });
  pi.registerTool({
    name: "todo_unblock",
    label: "Todo Unblock",
    description: "Move a blocked Gentic todo back to pending.",
    parameters: Type.Object({ todoId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).unblock(params.todoId);
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Unblocked ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });
  pi.registerTool({
    name: "todo_cancel",
    label: "Todo Cancel",
    description: "Cancel a Gentic todo with an optional reason.",
    parameters: Type.Object({
      todoId: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).cancel(params.todoId, params.reason);
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Cancelled ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });
  pi.registerTool({
    name: "todo_complete",
    label: "Todo Complete",
    description: "Complete a Gentic todo. Evidence is required.",
    promptGuidelines: [
      "Use todo_complete only with concrete evidence such as tests, changed files, or user confirmation.",
    ],
    parameters: Type.Object({
      todoId: Type.String(),
      evidence: EvidenceSchema,
      summary: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const todo = await service(pi, ctx).complete(
        params.todoId,
        normalizeEvidence(params.evidence),
        params.summary,
      );
      await updateWidget(pi, ctx);
      return {
        content: [{ type: "text", text: `Completed ${renderTodo(todo)}` }],
        details: { todo },
      };
    },
  });

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
      const svc = service(pi, ctx);
      if (params.action === "create") {
        const todo = await svc.create(createInput(params));
        await updateWidget(pi, ctx);
        return mutationResult("Created", todo);
      }
      if (params.action === "list") {
        const state = await svc.state();
        return {
          content: [
            {
              type: "text",
              text: renderTodoDocketLines(state, ansiTodoTheme, {
                width: 100,
                limit: 20,
                includeDone: params.includeDone,
              }).join("\n"),
            },
          ],
          details: { state },
        };
      }
      if (params.action === "next" || params.action === "next_ready") {
        const todo = await svc.next({
          actor: params.actor,
          actorCapabilities: params.actor_capabilities,
          actorScope: params.actor_scope,
        });
        return {
          content: [
            { type: "text", text: todo ? renderTodo(todo) : "No next todo." },
          ],
          details: { todo },
        };
      }
      if (params.action === "graph") {
        const graph = await svc.graph(params.todoId);
        return {
          content: [{ type: "text", text: JSON.stringify(graph) }],
          details: { graph },
        };
      }
      if (!params.todoId) throw new Error("todoId is required for this action");
      if (params.action === "get") {
        const todo = await svc.get(params.todoId);
        return {
          content: [{ type: "text", text: renderTodo(todo) }],
          details: { todo },
        };
      }
      if (params.action === "history") {
        const history = await svc.history(params.todoId);
        return {
          content: [
            {
              type: "text",
              text: history
                .map((event) => `${event.at} ${event.type}`)
                .join("\n"),
            },
          ],
          details: { history },
        };
      }

      const todo =
        params.action === "claim"
          ? await svc.claim(
              params.todoId,
              params.actor,
              params.actor_capabilities,
              params.actor_scope,
              params.leaseMs,
            )
          : params.action === "renew"
            ? await svc.renew(params.todoId, params.leaseMs)
            : params.action === "release"
              ? await svc.release(params.todoId, params.reason)
              : params.action === "start"
                ? await svc.start(params.todoId, params.actor)
                : params.action === "block"
                  ? await svc.block(params.todoId, params.reason || "")
                  : params.action === "unblock"
                    ? await svc.unblock(params.todoId)
                    : params.action === "cancel"
                      ? await svc.cancel(params.todoId, params.reason)
                      : params.action === "abandon"
                        ? await svc.abandon(params.todoId, params.reason)
                        : params.action === "complete"
                          ? await svc.complete(
                              params.todoId,
                              normalizeEvidence(params.evidence),
                              params.summary,
                            )
                          : params.action === "verify"
                            ? await svc.verify(
                                params.todoId,
                                normalizeEvidence(params.evidence),
                                params.summary,
                                params.actor_capabilities,
                              )
                            : params.action === "fail"
                              ? await svc.fail(
                                  params.todoId,
                                  params.reason,
                                  normalizeEvidence(params.evidence),
                                )
                              : params.action === "reopen"
                                ? await svc.reopen(params.todoId, params.reason)
                                : params.action === "link_dependency"
                                  ? await svc.linkDependency(
                                      params.todoId,
                                      params.dependencyTodoId || "",
                                    )
                                  : params.action === "split"
                                    ? (
                                        await svc.split(
                                          params.todoId,
                                          params.children ?? [],
                                          params.reason || "",
                                        )
                                      )[0]
                                    : params.action === "reprioritize"
                                      ? await svc.update(params.todoId, {
                                          priority: params.priority,
                                        })
                                      : params.action === "update"
                                        ? await svc.update(
                                            params.todoId,
                                            updatePatch(params),
                                          )
                                        : undefined;
      if (!todo) throw new Error(`unsupported todo action: ${params.action}`);
      await updateWidget(pi, ctx);
      return mutationResult(params.action, todo);
    },
  });

  pi.registerCommand("todo", {
    description:
      "Open the Gentic todo docket. Use /todo list or /todo next for text output.",
    getArgumentCompletions: (prefix) =>
      ["open", "list", "next"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const subcommand = args.trim() || "open";
      const svc = service(pi, ctx);
      if (subcommand === "next") {
        const todo = await svc.next();
        ctx.ui.notify(todo ? renderTodo(todo) : "No next todo.", "info");
        return;
      }
      if (subcommand === "list") {
        ctx.ui.notify(
          renderTodoDocketLines(await svc.state(), ansiTodoTheme, {
            width: 100,
            limit: 20,
          }).join("\n"),
          "info",
        );
        return;
      }
      await openTodoModal(pi, ctx);
      await updateWidget(pi, ctx);
    },
  });
}
