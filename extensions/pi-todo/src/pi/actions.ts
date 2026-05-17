import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SPLIT_SCAFFOLD_TAG, TodoService, TodoWorkflowError, type CreateArtifactInput, type CreateTodoInput, type TodoRepairHint } from "../app/service.ts";
import { readyToClose, summarizeTodos } from "../app/query.ts";
import { isTerminalStatus } from "../domain/lifecycle.ts";
import { loadEffectiveTodoConfig } from "../config.ts";
import type { EvidenceRef, Todo } from "../domain/types.ts";
import {
  createTodoDocketComponent,
  renderTodoDocketLines,
} from "../ui/docket.ts";
import { openTodoModal } from "../ui/modal.ts";
import { ansiTodoTheme } from "../ui/theme.ts";
import { syncTodoSessionName } from "./session-name.ts";
import { PiTodoEventStore } from "./store.ts";

const STATUS_KEY = "todo";
const TODO_COMMANDS = ["open", "list", "next", "graph", "history", "get", "split-check"];
const promptedDocketCleanupKeys = new Set<string>();

function service(pi: ExtensionAPI, ctx: ExtensionContext): TodoService {
  return new TodoService(new PiTodoEventStore(pi, ctx));
}

function renderTodo(todo: Todo): string {
  return `${todo.id} ${todo.title} - [${todo.status}]`;
}

function normalizeEvidence(raw: unknown): EvidenceRef[] {
  return Array.isArray(raw) ? raw.map((item) => item as EvidenceRef) : [];
}

function nextActions(todo: Todo): TodoRepairHint[] {
  if (todo.status === "ready") return [{ action: "start", params: { todoId: todo.id } }, { action: "begin", params: {} }];
  if (todo.status === "claimed" || todo.status === "in_progress") {
    const actions: TodoRepairHint[] = [
      { action: "create_artifact", params: { todoId: todo.id, kind: "todo", shortName: "work-note", purpose: "record durable work evidence", content: "" } },
      { action: "attach_evidence", params: { todoId: todo.id, evidence: [{ type: "manual_note", note: "describe verification or completed work" }] } },
    ];
    if (todo.evidence.length > 0) actions.push({ action: "finish", params: { todoId: todo.id } });
    return actions;
  }
  if (todo.status === "external_blocked") return [{ action: "unblock", params: { todoId: todo.id } }, { action: "cancel", params: { todoId: todo.id } }];
  if (todo.status === "completed") return [{ action: "verify", params: { todoId: todo.id } }];
  return [];
}

function mutationResult(action: string, todo: Todo, extraDetails: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: `${action} ${renderTodo(todo)}` }],
    details: { todo, nextActions: nextActions(todo), ...extraDetails },
  };
}

function organizedCreateResult(result: Awaited<ReturnType<TodoService["createOrganized"]>>) {
  if (result.todo) {
    const text = result.assessment.organization === "clarify"
      ? `Created vague todo via explicit fallback ${renderTodo(result.todo)}\nclarification recommended: ${result.assessment.reasons.join(", ")}`
      : `Created atomic todo ${renderTodo(result.todo)}`;
    return {
      content: [{ type: "text" as const, text }],
      details: { ...result, nextActions: nextActions(result.todo) },
    };
  }
  if (result.parent) {
    const text = [`compound request organized ${renderTodo(result.parent)}`, "children:", ...result.children.map((child) => `  - ${renderTodo(child)}`)].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: { ...result, nextActions: result.children.length > 0 ? [{ action: "start", params: { todoId: result.children[0].id } }, { action: "begin", params: {} }] : [] },
    };
  }
  if (result.assessment.organization === "container") {
    const suggested = result.assessment.suggestedChildren.map((child, index) => `  ${index + 1}. ${child.title}`).join("\n");
    const lines = [`intake needs explicit child tasks before creating docket entries: ${result.assessment.reasons.join(", ")}`];
    if (suggested) lines.push("non-durable suggestions:", suggested);
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { ...result, nextActions: [{ action: "create_organized", params: { title: result.assessment.parent?.title ?? "specific parent task", children: [{ title: "specific verifiable child" }] } }] },
    };
  }
  const questions = result.assessment.clarificationQuestions.map((question) => `  - ${question}`).join("\n");
  return {
    content: [{ type: "text" as const, text: `intake needs clarification: ${result.assessment.reasons.join(", ")}\nquestions:\n${questions}` }],
    details: { ...result, nextActions: [{ action: "create", params: { title: "specific outcome with acceptance criteria" } }] },
  };
}

function workflowErrorResult(error: TodoWorkflowError) {
  const repair = error.repair ? { action: error.repair.action, ...error.repair.params } : undefined;
  return {
    content: [{ type: "text" as const, text: repair ? `${error.message}\nnext_call: todo(${JSON.stringify(repair)})` : error.message }],
    details: { error: { code: error.code, message: error.message, repair, details: error.details } },
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
    `policy decision: ${result.policyDecision}`,
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

export function activeTodo(state: Awaited<ReturnType<TodoService["state"]>>): Todo | undefined {
  return Object.values(state.todos).find((todo) => todo.status === "in_progress" || todo.status === "claimed");
}

function isSplitContainer(todo: Todo): boolean {
  return todo.children.length > 0 && (todo.workDirectlyAllowed === false || todo.splitAssessment === "epic");
}

function hasSplitContainerAncestor(todo: Todo, state: Awaited<ReturnType<TodoService["state"]>>): boolean {
  const seen = new Set<string>();
  let parentId = todo.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = state.todos[parentId];
    if (!parent) return false;
    if (isSplitContainer(parent)) return true;
    parentId = parent.parentId;
  }
  return false;
}

function unresolvedSplitDocketItems(state: Awaited<ReturnType<TodoService["state"]>>): Todo[] {
  return Object.values(state.todos).filter((todo) => !isTerminalStatus(todo.status) && (
    todo.tags.includes(SPLIT_SCAFFOLD_TAG)
    || (isSplitContainer(todo) && readyToClose(todo, state))
    || hasSplitContainerAncestor(todo, state)
  ));
}

function docketCleanupMessage(state: Awaited<ReturnType<TodoService["state"]>>): { key: string; content: string } | undefined {
  const active = activeTodo(state);
  const splitItems = unresolvedSplitDocketItems(state);
  if (!active && splitItems.length === 0) return undefined;
  const items = active ? [active, ...splitItems.filter((todo) => todo.id !== active.id)] : splitItems;
  const key = items.map((todo) => `${todo.id}:${todo.status}:${todo.revision}`).sort().join("|");
  const lines = [
    "pi-todo note: todo ledger entries are still open before the final response.",
    "Wrap up completed work, abandon stale split scaffolds, or briefly explain why a task is intentionally still open.",
    "open entries:",
    ...items.slice(0, 6).map((todo) => `- ${todo.id} [${todo.status}] ${todo.title}`),
  ];
  if (items.length > 6) lines.push(`- ... ${items.length - 6} more`);
  return { key, content: lines.join("\n") };
}

export async function todoState(pi: ExtensionAPI, ctx: ExtensionContext) {
  return service(pi, ctx).state();
}

export async function reconcileTodoDocket(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await service(pi, ctx).reconcileSplitScaffolds();
  await updateTodoWidget(pi, ctx);
}

async function requestDocketCleanupTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deliverAs: "steer" | "followUp",
): Promise<void> {
  const svc = service(pi, ctx);
  await svc.reconcileSplitScaffolds();
  await updateTodoWidget(pi, ctx);
  const state = await svc.state();
  const reminder = docketCleanupMessage(state);
  if (!reminder) return;
  const key = `${ctx.sessionId ?? ctx.cwd ?? "session"}:${deliverAs}:${reminder.key}`;
  if (promptedDocketCleanupKeys.has(key)) return;
  promptedDocketCleanupKeys.add(key);
  ctx.ui.notify("pi-todo has open entries to wrap up before the final response", "info");
  pi.sendMessage(
    { customType: "gentic.todo.clean-docket", content: reminder.content, display: false },
    { triggerTurn: true, deliverAs },
  );
}

function messageRole(event: unknown): string | undefined {
  const message = (event as { message?: { role?: unknown } } | undefined)?.message;
  return typeof message?.role === "string" ? message.role : undefined;
}

export async function checkTodoDocketBeforeFinalMessage(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await reconcileTodoDocket(pi, ctx);
}

export async function checkTodoDocketAtMessageStart(pi: ExtensionAPI, ctx: ExtensionContext, event: unknown): Promise<void> {
  if (messageRole(event) !== "assistant") return;
  await requestDocketCleanupTurn(pi, ctx, "steer");
}

export async function checkTodoDocketAtAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await reconcileTodoDocket(pi, ctx);
}

export async function updateTodoWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const state = await service(pi, ctx).state();
  const config = loadEffectiveTodoConfig({ cwd: ctx.cwd }).config;
  const counts = summarizeTodos(state);
  syncTodoSessionName(pi, ctx, state);
  if (counts.total === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(
    STATUS_KEY,
    `todo open ${counts.open} · active ${counts.byStatus.in_progress} · done ${counts.byStatus.completed + counts.byStatus.verified}`,
  );
  ctx.ui.setWidget(STATUS_KEY, createTodoDocketComponent(state, { showCompletedFocus: config.docket.showCompletedFocus }));
}

export async function executeTodoAction(pi: ExtensionAPI, ctx: ExtensionContext, params: Record<string, unknown>) {
  try {
    return await executeTodoActionUnsafe(pi, ctx, params);
  } catch (error) {
    if (error instanceof TodoWorkflowError) return workflowErrorResult(error);
    throw error;
  }
}

async function executeTodoActionUnsafe(pi: ExtensionAPI, ctx: ExtensionContext, params: Record<string, unknown>) {
  const svc = service(pi, ctx);
  if (params.action === "create" || params.action === "create_organized") {
    if (params.action === "create" && params.autoOrganize !== true) {
      const todo = await svc.create(createInput(params));
      await updateTodoWidget(pi, ctx);
      return mutationResult("Created", todo);
    }
    const result = await svc.createOrganized(createInput(params), { children: params.children as CreateTodoInput[] | undefined, allowVagueTodo: params.allowVagueTodo as boolean | undefined });
    await updateTodoWidget(pi, ctx);
    return organizedCreateResult(result);
  }
  if (params.action === "list") {
    const state = await svc.state();
    return { content: [{ type: "text" as const, text: renderTodoDocketLines(state, ansiTodoTheme, { width: 100, limit: 20, includeDone: params.includeDone as boolean | undefined, detail: "summary" }).join("\n") }], details: { state } };
  }
  if (params.action === "next" || params.action === "next_ready") {
    const todo = await svc.next();
    return { content: [{ type: "text" as const, text: todo ? renderTodo(todo) : "No next todo." }], details: { todo, nextActions: todo ? nextActions(todo) : [{ action: "create", params: { title: "describe next task" } }] } };
  }
  const owner = (params.owner as string | undefined) ?? ctx.sessionId ?? ctx.cwd ?? null;
  if (params.action === "begin") {
    const todo = await svc.begin(params.requiredCapabilities as string[] | undefined, params.leaseMs as number | undefined, owner, { splitOverrideReason: params.reason as string | undefined });
    await updateTodoWidget(pi, ctx);
    return mutationResult("begin", todo);
  }
  if (params.action === "finish") {
    const todoId = params.todoId ? await svc.resolveId(params.todoId as string) : undefined;
    const todo = await svc.finish(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined, owner);
    await updateTodoWidget(pi, ctx);
    return mutationResult("finish", todo);
  }
  if (params.action === "note_artifact") {
    const todoId = params.todoId ? await svc.resolveId(params.todoId as string) : undefined;
    const result = await svc.noteArtifact(todoId, artifactInput(params), owner);
    await updateTodoWidget(pi, ctx);
    return mutationResult("note_artifact", result.todo, { artifactPath: result.path });
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
    await updateTodoWidget(pi, ctx);
    return { content: [{ type: "text" as const, text: splitCheckText(todo, splitCheck) }], details: { splitCheck } };
  }

  if (params.action === "split") {
    const parent = await svc.get(todoId);
    const existingChildren = params.children as CreateTodoInput[] | undefined;
    const splitCheck = await svc.splitCheck(todoId);
    const requestedCount = Math.max(1, Math.min(Number(params.count || splitCheck.recommendedChildCount || 3), 6));
    const children = existingChildren?.length ? existingChildren : params.auto ? splitCheck.suggestedChildren.slice(0, requestedCount).map((child) => ({ title: child.title, acceptanceCriteria: child.acceptanceCriteria, tags: [...(child.tags ?? []), SPLIT_SCAFFOLD_TAG] })) : [];
    if (children.length === 0) throw new Error("split children are required unless auto is true");
    const reason = (params.reason as string | undefined) || `split assessment ${splitCheck.assessment}: ${splitCheck.reasons.join(", ")}`;
    if (params.auto && !existingChildren?.length) {
      return {
        content: [{ type: "text" as const, text: `auto split is preview-only; provide explicit children to persist\n${splitCheckText(parent, { ...splitCheck, suggestedChildren: children })}` }],
        details: { splitCheck, children, nextActions: [{ action: "split", params: { todoId, children, reason } }] },
      };
    }
    const created = await svc.split(todoId, children, reason);
    await updateTodoWidget(pi, ctx);
    return { content: [{ type: "text" as const, text: `split ${todoId} into ${created.length} children\n${created.map(renderTodo).join("\n")}` }], details: { parent, children: created, splitCheck } };
  }
  if (params.action === "create_artifact") {
    const result = await svc.createArtifact(todoId, artifactInput(params));
    await updateTodoWidget(pi, ctx);
    return mutationResult("create_artifact", result.todo, { artifactPath: result.path });
  }
  const todo = params.action === "claim" ? await svc.claim(todoId, params.requiredCapabilities as string[] | undefined, params.leaseMs as number | undefined, owner)
    : params.action === "renew" ? await svc.renew(todoId, params.leaseMs as number | undefined)
    : params.action === "release" ? await svc.release(todoId, params.reason as string | undefined)
    : params.action === "start" ? await svc.start(todoId, params.requiredCapabilities as string[] | undefined, params.leaseMs as number | undefined, owner, { splitOverrideReason: params.reason as string | undefined })
    : params.action === "block" ? await svc.block(todoId, (params.reason as string | undefined) || "")
    : params.action === "unblock" ? await svc.unblock(todoId)
    : params.action === "cancel" ? await svc.cancel(todoId, params.reason as string | undefined)
    : params.action === "supersede" ? await svc.supersede(todoId, params.supersededBy as string | undefined, params.reason as string | undefined)
    : params.action === "abandon" ? await svc.abandon(todoId, params.reason as string | undefined)
    : params.action === "complete" ? await svc.complete(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined)
    : params.action === "attach_evidence" ? await svc.attachEvidence(todoId, normalizeEvidence(params.evidence))
    : params.action === "record_artifact" ? await svc.attachEvidence(todoId, [{ type: "generated_artifact", path: String(params.path || ""), summary: String(params.summary || "generated artifact"), createdByTodoId: todoId, recordedAt: new Date().toISOString() }])
    : params.action === "verify" ? await svc.verify(todoId, normalizeEvidence(params.evidence), params.summary as string | undefined, params.requiredCapabilities as string[] | undefined)
    : params.action === "fail" ? await svc.fail(todoId, params.reason as string | undefined, normalizeEvidence(params.evidence))
    : params.action === "reopen" ? await svc.reopen(todoId, params.reason as string | undefined)
    : params.action === "link_dependency" ? await svc.linkDependency(todoId, (params.dependencyTodoId as string | undefined) || "")
    : params.action === "split" ? (await svc.split(todoId, (params.children as CreateTodoInput[] | undefined) ?? [], (params.reason as string | undefined) || ""))[0]
    : params.action === "reprioritize" ? await svc.update(todoId, { priority: params.priority as Todo["priority"] | undefined })
    : params.action === "update" ? await svc.update(todoId, updatePatch(params))
    : undefined;
  if (!todo) throw new Error(`unsupported todo action: ${String(params.action)}`);
  await updateTodoWidget(pi, ctx);
  return mutationResult(String(params.action), todo);
}

export function getTodoCommandCompletions(prefix: string) {
  return TODO_COMMANDS
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
}

export async function executeTodoCommand(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  const [subcommandRaw, id] = args.trim().split(/\s+/, 2);
  const subcommand = subcommandRaw || "open";
  if (subcommand === "open") {
    await openTodoModal(pi, ctx);
    await updateTodoWidget(pi, ctx);
    return;
  }
  if (!TODO_COMMANDS.includes(subcommand)) {
    ctx.ui.notify("Unknown /todo command. Use /todo, /todo list, /todo next, /todo graph <id>, /todo history <id>, /todo get <id>, or /todo split-check <id>.", "error");
    return;
  }
  const action = subcommand === "next" ? "next_ready" : subcommand === "split-check" ? "split_check" : subcommand;
  const result = await executeTodoAction(pi, ctx, { action, todoId: id });
  ctx.ui.notify(result.content.map((item) => item.text).join("\n"), "info");
}
