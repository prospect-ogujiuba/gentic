import { normalizePriority, isTerminalStatus } from "../domain/lifecycle.ts";
import { ineligibleReasons, missingCapabilities, openDependencyIds, type EligibilityOptions } from "../domain/policy.ts";
import { reduceTodoState } from "../domain/reducer.ts";
import { nextTodo } from "./query.ts";
import { emptyScope, type EvidenceRef, type Todo, type TodoClaim, type TodoEvent, type TodoPolicy, type TodoPriority, type TodoScope, type TodoState, type TodoStatus } from "../domain/types.ts";

export interface TodoEventStore { read(): Promise<TodoEvent[]>; append(event: TodoEvent): Promise<void> }
type LifecycleEventPayload =
  | Omit<Extract<TodoEvent, { type: "todo.failed" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.verified" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.reopened" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.cancelled" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.abandoned" }>, "id" | "at" | "todoId">;
export const defaultTodoPolicy: TodoPolicy = { requireEvidenceForDone: true, maxInProgress: 1 };

const DEFAULT_ACTOR = "agent.default";
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export type CreateTodoInput = {
  title: string;
  description?: string;
  type?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  owner?: string | null;
  parentId?: string | null;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  dependsOn?: string[];
  tags?: string[];
  scope?: Partial<TodoScope>;
  inputs?: { goal?: string; context?: string; environment?: string; constraints?: string[] };
  constraints?: string[];
  requiredCapabilities?: string[];
  actor?: string;
  commandId?: string;
};

function createTodoRecord(input: CreateTodoInput, at: string, parent?: Todo): Todo {
  if (!input.title.trim()) throw new Error("title is required");
  return {
    id: id("todo"),
    title: input.title.trim(),
    description: input.description,
    type: input.type ?? parent?.type ?? "task",
    status: input.status ?? "ready",
    priority: normalizePriority(input.priority ?? parent?.priority),
    owner: input.owner ?? parent?.owner,
    claimedBy: null,
    activeClaimId: null,
    leaseExpiresAt: null,
    parentId: input.parentId ?? parent?.id ?? null,
    children: [],
    dependsOn: input.dependsOn ?? [],
    blocks: [],
    scope: emptyScope(input.scope ?? parent?.scope),
    inputs: { goal: input.inputs?.goal, context: input.inputs?.context, environment: input.inputs?.environment, constraints: input.inputs?.constraints ?? [] },
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    definitionOfDone: input.definitionOfDone ?? [],
    requiredCapabilities: input.requiredCapabilities ?? parent?.requiredCapabilities ?? [],
    createdAt: at,
    updatedAt: at,
    blockers: [],
    tags: input.tags ?? parent?.tags ?? [],
    evidence: [],
    notes: [],
    revision: 0,
    createdBy: input.actor,
    updatedBy: input.actor,
  };
}

export class TodoService {
  private store: TodoEventStore;
  private policy: TodoPolicy;

  constructor(store: TodoEventStore, policy: TodoPolicy = defaultTodoPolicy) {
    this.store = store;
    this.policy = policy;
  }

  async state(): Promise<TodoState> { return reduceTodoState(await this.store.read()); }

  async create(input: CreateTodoInput): Promise<Todo> {
    const at = now();
    const todo = createTodoRecord(input, at);
    await this.append({ id: id("evt"), type: "todo.created", at, commandId: input.commandId, todo });
    return todo;
  }

  async update(todoId: string, patch: Partial<Todo>): Promise<Todo> {
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.updated", at: now(), todoId, patch });
    return this.get(todoId);
  }

  async split(todoId: string, children: CreateTodoInput[], reason: string): Promise<Todo[]> {
    if (!reason.trim()) throw new Error("split reason is required");
    const parent = await this.get(todoId);
    const at = now();
    const created = children.map((child) => createTodoRecord(child, at, parent));
    await this.append({ id: id("evt"), type: "todo.split", at, todoId, children: created, reason });
    return created;
  }

  async linkDependency(todoId: string, dependencyTodoId: string): Promise<Todo> {
    await this.requireExisting(dependencyTodoId);
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.dependency_linked", at: now(), todoId, dependencyTodoId });
    return this.get(todoId);
  }

  async claim(todoId: string, actor = DEFAULT_ACTOR, actorCapabilities: string[] = [], actorScope?: Partial<TodoScope>, leaseMs?: number): Promise<Todo> {
    const state = await this.state();
    const todo = this.requireTodo(state, todoId);
    const reasons = ineligibleReasons(todo, state, { actor, actorCapabilities, actorScope });
    if (reasons.length > 0) throw new Error(`todo is not claimable: ${reasons.join(", ")}`);
    const at = now();
    const claim: TodoClaim = { id: id("claim"), todoId, actor, capabilities: actorCapabilities, scope: emptyScope(actorScope ?? todo.scope), status: "active", claimedAt: at, leaseMs, leaseExpiresAt: leaseMs ? new Date(Date.now() + leaseMs).toISOString() : undefined };
    await this.append({ id: id("evt"), type: "todo.claimed", at, todoId, claim });
    return this.get(todoId);
  }

  async renew(todoId: string, leaseMs?: number): Promise<Todo> {
    const todo = await this.get(todoId);
    if (!todo.activeClaimId) throw new Error("todo has no active claim");
    const leaseExpiresAt = leaseMs ? new Date(Date.now() + leaseMs).toISOString() : undefined;
    await this.append({ id: id("evt"), type: "todo.lease_renewed", at: now(), todoId, claimId: todo.activeClaimId, leaseExpiresAt });
    return this.get(todoId);
  }

  async release(todoId: string, reason?: string): Promise<Todo> {
    const todo = await this.get(todoId);
    await this.append({ id: id("evt"), type: "todo.released", at: now(), todoId, claimId: todo.activeClaimId ?? undefined, reason });
    return this.get(todoId);
  }

  async start(todoId: string, actor?: string): Promise<Todo> {
    const state = await this.state();
    const todo = this.requireTodo(state, todoId);
    if (todo.status === "blocked") throw new Error("cannot start blocked todo");
    const eligibilityTodo = { ...todo, status: todo.status === "claimed" ? "ready" as TodoStatus : todo.status };
    const reasons = ineligibleReasons(eligibilityTodo, state, { actor });
    const openDeps = openDependencyIds(todo, state);
    if (openDeps.length > 0) throw new Error(`dependency not done: ${openDeps[0]}`);
    if (reasons.length > 0 && todo.status !== "claimed") throw new Error(`todo is not ready: ${reasons.join(", ")}`);
    if (this.activeCount(state, todoId) >= this.policy.maxInProgress) throw new Error("max in-progress todos reached");
    await this.append({ id: id("evt"), type: "todo.started", at: now(), todoId, actor });
    return this.get(todoId);
  }

  async complete(todoId: string, evidence: EvidenceRef[] = [], summary?: string): Promise<Todo> {
    if (this.policy.requireEvidenceForDone && evidence.length === 0) throw new Error("evidence is required to complete a todo");
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.completed", at: now(), todoId, evidence, summary });
    return this.get(todoId);
  }

  async verify(todoId: string, evidence: EvidenceRef[] = [], summary?: string, actorCapabilities?: string[]): Promise<Todo> {
    const todo = await this.get(todoId);
    const missing = missingCapabilities(todo, actorCapabilities, "verify");
    if (missing.length > 0) throw new Error(`verify requires actor_capabilities=${missing.join(",")}`);
    return this.lifecycle(todoId, { type: "todo.verified", evidence, summary });
  }
  async fail(todoId: string, reason?: string, evidence: EvidenceRef[] = []): Promise<Todo> { return this.lifecycle(todoId, { type: "todo.failed", reason, evidence }); }
  async reopen(todoId: string, reason?: string, targetStatus: TodoStatus = "ready"): Promise<Todo> { return this.lifecycle(todoId, { type: "todo.reopened", reason, targetStatus }); }
  async cancel(todoId: string, reason?: string): Promise<Todo> { return this.lifecycle(todoId, { type: "todo.cancelled", reason }); }
  async abandon(todoId: string, reason?: string): Promise<Todo> { return this.lifecycle(todoId, { type: "todo.abandoned", reason }); }

  async block(todoId: string, reason: string): Promise<Todo> {
    if (!reason.trim()) throw new Error("block reason is required");
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.blocked", at: now(), todoId, reason });
    return this.get(todoId);
  }

  async unblock(todoId: string): Promise<Todo> {
    const todo = await this.get(todoId);
    if (todo.status !== "blocked") throw new Error("only blocked todos can be unblocked");
    await this.append({ id: id("evt"), type: "todo.unblocked", at: now(), todoId });
    return this.get(todoId);
  }

  async next(options: EligibilityOptions = {}): Promise<Todo | undefined> { return nextTodo(await this.state(), options); }
  async get(todoId: string): Promise<Todo> { return this.requireTodo(await this.state(), todoId); }
  async history(todoId: string): Promise<TodoEvent[]> { await this.requireExisting(todoId); return (await this.store.read()).filter((event) => "todoId" in event ? event.todoId === todoId : event.type === "todo.created" && event.todo.id === todoId); }

  async graph(todoId?: string): Promise<{ nodes: { id: string; title: string; status: TodoStatus; parentId?: string | null }[]; edges: { from: string; to: string; kind: "depends_on" | "parent_child" }[] }> {
    const todos = Object.values((await this.state()).todos).filter((todo) => !todoId || todo.id === todoId || todo.parentId === todoId || todo.dependsOn.includes(todoId));
    return { nodes: todos.map((todo) => ({ id: todo.id, title: todo.title, status: todo.status, parentId: todo.parentId })), edges: todos.flatMap((todo) => [...todo.dependsOn.map((dep) => ({ from: todo.id, to: dep, kind: "depends_on" as const })), ...(todo.parentId ? [{ from: todo.parentId, to: todo.id, kind: "parent_child" as const }] : [])]) };
  }

  private async lifecycle(todoId: string, payload: LifecycleEventPayload): Promise<Todo> {
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), at: now(), todoId, ...payload } as TodoEvent);
    return this.get(todoId);
  }

  private activeCount(state: TodoState, exceptTodoId: string): number {
    return Object.values(state.todos).filter((todo) => todo.status === "in_progress" && todo.id !== exceptTodoId && !isTerminalStatus(todo.status)).length;
  }

  private async requireExisting(todoId: string): Promise<void> { this.requireTodo(await this.state(), todoId); }
  private async append(event: TodoEvent): Promise<void> { await this.store.append(event); }
  private requireTodo(state: TodoState, todoId: string): Todo { const todo = state.todos[todoId]; if (!todo) throw new Error(`todo not found: ${todoId}`); return todo; }
}
