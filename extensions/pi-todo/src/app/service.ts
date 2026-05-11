import { mkdir, readFile, writeFile } from "node:fs/promises";
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
export const MODEL_ARTIFACTS_DIR = ".model-artifacts/";
export const MODEL_TODO_ARTIFACTS_DIR = ".model-artifacts/todo/";
const ARTIFACT_FOLDERS = new Set(["reports", "logs", "specs", "plans", "findings", "todo"]);

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export type ArtifactKind = "reports" | "logs" | "specs" | "plans" | "findings" | "todo";
export type CreateArtifactInput = { kind: ArtifactKind; shortName: string; purpose: string; content: string };

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
  commandId?: string;
};

function kebabCase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "artifact";
}

function artifactPath(kind: ArtifactKind, shortName: string, at: string): string {
  const stamp = at.slice(0, 16).replace("T", "_").replace(/:/g, "");
  return `${MODEL_ARTIFACTS_DIR}${kind}/${stamp}-${kebabCase(shortName)}.md`;
}

function artifactBody(title: string, purpose: string, created: string, content: string): string {
  return `# ${title}\n\nCreated: ${created}\nPurpose: ${purpose.trim()}\n\n${content.trim()}\n`;
}

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

  async claim(todoId: string, capabilities: string[] = [], leaseMs?: number): Promise<Todo> {
    const state = await this.state();
    const todo = this.requireTodo(state, todoId);
    const reasons = ineligibleReasons(todo, state, { capabilities });
    if (reasons.length > 0) throw new Error(`todo is not claimable: ${reasons.join(", ")}`);
    const at = now();
    const claim: TodoClaim = { id: id("claim"), todoId, capabilities, scope: emptyScope(todo.scope), status: "active", claimedAt: at, leaseMs, leaseExpiresAt: leaseMs ? new Date(Date.now() + leaseMs).toISOString() : undefined };
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

  async start(todoId: string): Promise<Todo> {
    const state = await this.state();
    const todo = this.requireTodo(state, todoId);
    if (todo.status === "blocked") throw new Error("cannot start blocked todo");
    const eligibilityTodo = { ...todo, status: todo.status === "claimed" ? "ready" as TodoStatus : todo.status };
    const reasons = ineligibleReasons(eligibilityTodo, state);
    const openDeps = openDependencyIds(todo, state);
    if (openDeps.length > 0) throw new Error(`dependency not done: ${openDeps[0]}`);
    if (reasons.length > 0 && todo.status !== "claimed") throw new Error(`todo is not ready: ${reasons.join(", ")}`);
    if (this.activeCount(state, todoId) >= this.policy.maxInProgress) throw new Error("max in-progress todos reached");
    await this.append({ id: id("evt"), type: "todo.started", at: now(), todoId });
    return this.get(todoId);
  }

  async complete(todoId: string, evidence: EvidenceRef[] = [], summary?: string): Promise<Todo> {
    if (this.policy.requireEvidenceForDone && evidence.length === 0) throw new Error("evidence is required to complete a todo");
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.completed", at: now(), todoId, evidence, summary });
    return this.get(todoId);
  }

  async attachEvidence(todoId: string, evidence: EvidenceRef[] = []): Promise<Todo> {
    await this.requireExisting(todoId);
    if (evidence.length === 0) throw new Error("evidence is required");
    for (const item of evidence) {
      if (item.type === "generated_artifact") await this.validateGeneratedArtifact(todoId, item.path, item.createdByTodoId);
    }
    await this.append({ id: id("evt"), type: "todo.evidence_attached", at: now(), todoId, evidence });
    return this.get(todoId);
  }

  async createArtifact(todoId: string, input: CreateArtifactInput): Promise<{ todo: Todo; path: string }> {
    await this.requireExisting(todoId);
    if (!ARTIFACT_FOLDERS.has(input.kind)) throw new Error("invalid artifact kind");
    if (!input.purpose.trim()) throw new Error("artifact purpose is required");
    const at = now();
    const path = artifactPath(input.kind, input.shortName, at);
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, artifactBody(input.shortName, input.purpose, at, input.content), "utf8");
    const todo = await this.attachEvidence(todoId, [{ type: "generated_artifact", path, summary: input.purpose.trim(), createdByTodoId: todoId, recordedAt: at }]);
    return { todo, path };
  }

  async verify(todoId: string, evidence: EvidenceRef[] = [], summary?: string, capabilities?: string[]): Promise<Todo> {
    const todo = await this.get(todoId);
    const missing = missingCapabilities(todo, capabilities, "verify");
    if (missing.length > 0) throw new Error(`verify requires capabilities=${missing.join(",")}`);
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
  async resolveId(todoIdOrTitle: string): Promise<string> {
    const state = await this.state();
    if (state.todos[todoIdOrTitle]) return todoIdOrTitle;
    const matches = Object.values(state.todos).filter((todo) => todo.title === todoIdOrTitle);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`todo title is ambiguous: ${todoIdOrTitle}`);
    throw new Error(`todo not found: ${todoIdOrTitle}`);
  }
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
  private async validateGeneratedArtifact(todoId: string, path: string, createdByTodoId: string): Promise<void> {
    if (createdByTodoId !== todoId) throw new Error("generated artifact createdByTodoId must match todoId");
    if (path.startsWith("/") || path.includes("..") || !path.startsWith(MODEL_ARTIFACTS_DIR)) throw new Error("generated artifacts must be under .model-artifacts/");
    const parts = path.split("/");
    const folder = parts[1];
    const name = parts.pop()?.toLowerCase() ?? "";
    if (!ARTIFACT_FOLDERS.has(folder)) throw new Error("generated artifacts must use an approved .model-artifacts subfolder");
    if (name.includes("todo") && !path.startsWith(MODEL_TODO_ARTIFACTS_DIR)) throw new Error(`todo files must be under ${MODEL_TODO_ARTIFACTS_DIR}`);
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) throw new Error("generated artifact filenames must be YYYY-MM-DD_HHMM-short-kebab-name.md");
    try {
      const text = await readFile(path, "utf8");
      if (!/^# .+\n\nCreated: .+\nPurpose: .+/m.test(text)) throw new Error("generated artifact markdown must start with heading, Created, and Purpose");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async append(event: TodoEvent): Promise<void> { await this.store.append(event); }
  private requireTodo(state: TodoState, todoId: string): Todo { const todo = state.todos[todoId]; if (!todo) throw new Error(`todo not found: ${todoId}`); return todo; }
}
