import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizePriority, normalizeStatus, isSuccessStatus, isTerminalStatus } from "../domain/lifecycle.ts";
import { ineligibleReasons, missingCapabilities, openDependencyIds, type EligibilityOptions } from "../domain/policy.ts";
import { reduceTodoState } from "../domain/reducer.ts";
import { assessSplitPolicy, assessTodoIntake, defaultSplitPolicy, shouldBlockForSplit, splitTitleSimilarityProblems } from "../domain/splitting.ts";
import { nextTodo } from "./query.ts";
import { emptyScope, type EvidenceRef, type SplitCheckResult, type Todo, type TodoClaim, type TodoEvent, type TodoIntakeAssessment, type TodoPolicy, type TodoPriority, type TodoScope, type TodoState, type TodoStatus } from "../domain/types.ts";

export interface TodoEventStore { read(): Promise<TodoEvent[]>; append(event: TodoEvent): Promise<void> }
type LifecycleEventPayload =
  | Omit<Extract<TodoEvent, { type: "todo.failed" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.verified" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.reopened" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.cancelled" }>, "id" | "at" | "todoId">
  | Omit<Extract<TodoEvent, { type: "todo.abandoned" }>, "id" | "at" | "todoId">;
export const defaultTodoPolicy: TodoPolicy = { requireEvidenceForDone: true, maxInProgress: 1, splitting: defaultSplitPolicy };
export const MODEL_ARTIFACTS_DIR = ".model-artifacts/";
export const MODEL_TODO_ARTIFACTS_DIR = ".model-artifacts/todo/";
export const SPLIT_SCAFFOLD_TAG = "pi-todo:split-scaffold";
const ARTIFACT_FOLDERS = new Set(["reports", "logs", "specs", "plans", "findings", "todo"]);

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export type ArtifactKind = "reports" | "logs" | "specs" | "plans" | "findings" | "todo";
export type CreateArtifactInput = { kind: ArtifactKind; shortName: string; purpose: string; content: string; category?: string; subcategory?: string };
export type StartTodoOptions = { splitOverrideReason?: string };
export type CreateOrganizedTodoOptions = { children?: CreateTodoInput[]; allowVagueTodo?: boolean };
export type CreateOrganizedTodoResult = { assessment: TodoIntakeAssessment; todo?: Todo; parent?: Todo; children: Todo[] };
export type TodoRepairHint = { action: string; params: Record<string, unknown> };

export class TodoWorkflowError extends Error {
  readonly code: string;
  readonly repair?: TodoRepairHint;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, repair?: TodoRepairHint, details?: Record<string, unknown>) {
    super(repair ? `${message}; repair: todo(${JSON.stringify({ action: repair.action, ...repair.params })})` : message);
    this.name = "TodoWorkflowError";
    this.code = code;
    this.repair = repair;
    this.details = details;
  }
}

function workflowError(code: string, message: string, repair?: TodoRepairHint, details?: Record<string, unknown>): TodoWorkflowError {
  return new TodoWorkflowError(code, message, repair, details);
}

export type CreateTodoInput = {
  title: string;
  description?: string;
  type?: string;
  status?: TodoStatus | string;
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

function artifactTopic(todo: Todo, input: Pick<CreateArtifactInput, "category" | "subcategory" | "shortName">): string[] {
  const candidates = [
    input.category,
    todo.scope.component,
    todo.scope.service,
    todo.scope.domain,
    ...todo.tags,
    todo.title,
    input.shortName,
  ].filter(Boolean) as string[];
  const primary = candidates.map((value) => value.match(/\b(?:pi|gentic)-[a-z0-9][a-z0-9-]*\b/i)?.[0] ?? "").find(Boolean)
    ?? candidates.map((value) => value.match(/\bgentic\b/i)?.[0] ?? "").find(Boolean)
    ?? candidates[0]
    ?? "general";
  const topic = kebabCase(primary);
  const subtopic = input.subcategory ? kebabCase(input.subcategory) : undefined;
  return subtopic && subtopic !== topic ? [topic, subtopic] : [topic];
}

function artifactPath(kind: ArtifactKind, shortName: string, at: string, todo: Todo, input: Pick<CreateArtifactInput, "category" | "subcategory" | "shortName">): string {
  const stamp = at.slice(0, 16).replace("T", "_").replace(/:/g, "");
  const topic = artifactTopic(todo, input).join("/");
  return `${MODEL_ARTIFACTS_DIR}${kind}/${topic}/${stamp}-${kebabCase(shortName)}.md`;
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
    status: normalizeStatus(input.status),
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
    this.policy = { ...defaultTodoPolicy, ...policy, splitting: { ...defaultSplitPolicy, ...(policy.splitting ?? {}) } };
  }

  async state(): Promise<TodoState> { return reduceTodoState(await this.store.read()); }

  async create(input: CreateTodoInput): Promise<Todo> {
    const at = now();
    const todo = createTodoRecord(input, at);
    await this.append({ id: id("evt"), type: "todo.created", at, commandId: input.commandId, todo });
    return todo;
  }

  async createOrganized(input: CreateTodoInput, options: CreateOrganizedTodoOptions = {}): Promise<CreateOrganizedTodoResult> {
    const assessment = assessTodoIntake(input, this.policy.splitting);
    if (assessment.organization === "todo" || (assessment.organization === "clarify" && options.allowVagueTodo)) {
      const todo = await this.create(input);
      return { assessment, todo, children: [] };
    }
    if (assessment.organization === "clarify") return { assessment, children: [] };

    const childInputs = options.children?.length ? options.children : [];
    if (childInputs.length === 0) return { assessment, children: [] };
    const problems = splitTitleSimilarityProblems(input.title, childInputs.map((child) => child.title));
    if (problems.length > 0) throw new Error(`organized intake child titles must be distinct; ${problems.join("; ")}; make each child title/scope more specific`);

    const at = now();
    const parent = {
      ...createTodoRecord(input, at),
      workDirectlyAllowed: false,
      splitAssessment: assessment.assessment,
      splitAssessmentConfidence: assessment.confidence,
      splitAssessmentReasons: assessment.reasons,
      splitPolicySatisfied: false,
      splitCheckedAt: at,
    };
    const children = childInputs.map((child) => createTodoRecord(child, at, parent));
    const reason = `intake organization ${assessment.assessment}: ${assessment.reasons.join(", ")}`;
    await this.append({ id: id("evt"), type: "todo.created", at, commandId: input.commandId, todo: parent });
    await this.append({ id: id("evt"), type: "todo.split", at, commandId: input.commandId, todoId: parent.id, children, reason });
    const state = await this.state();
    return { assessment, parent: this.requireTodo(state, parent.id), children: children.map((child) => this.requireTodo(state, child.id)) };
  }

  async update(todoId: string, patch: Partial<Todo>): Promise<Todo> {
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.updated", at: now(), todoId, patch });
    return this.get(todoId);
  }

  async split(todoId: string, children: CreateTodoInput[], reason: string): Promise<Todo[]> {
    if (!reason.trim()) throw new Error("split reason is required");
    const parent = await this.get(todoId);
    const problems = splitTitleSimilarityProblems(parent.title, children.map((child) => child.title));
    if (problems.length > 0) throw new Error(`split child titles must be distinct; ${problems.join("; ")}; make each child title/scope more specific`);
    const at = now();
    const created = children.map((child) => createTodoRecord(child, at, parent));
    await this.append({ id: id("evt"), type: "todo.split", at, todoId, children: created, reason });
    return created;
  }

  async splitCheck(todoId: string): Promise<SplitCheckResult> {
    const todo = await this.get(todoId);
    const result = assessSplitPolicy(todo, this.policy.splitting);
    await this.append({
      id: id("evt"),
      type: "todo.updated",
      at: now(),
      todoId,
      patch: {
        splitAssessment: result.assessment,
        splitAssessmentConfidence: result.confidence,
        splitAssessmentReasons: result.reasons,
        splitPolicySatisfied: result.splitPolicySatisfied,
        splitCheckedAt: now(),
      },
    });
    return result;
  }

  async linkDependency(todoId: string, dependencyTodoId: string): Promise<Todo> {
    await this.requireExisting(dependencyTodoId);
    await this.requireExisting(todoId);
    await this.append({ id: id("evt"), type: "todo.dependency_linked", at: now(), todoId, dependencyTodoId });
    return this.get(todoId);
  }

  async claim(todoId: string, capabilities: string[] = [], leaseMs?: number, owner?: string | null): Promise<Todo> {
    const state = await this.expireClaims(await this.state());
    const todo = this.requireTodo(state, todoId);
    const reasons = ineligibleReasons(todo, state, { capabilities });
    if (reasons.length > 0) throw new Error(`todo is not claimable: ${reasons.join(", ")}`);
    const at = now();
    const claim: TodoClaim = { id: id("claim"), todoId, capabilities, scope: emptyScope(todo.scope), status: "active", claimedAt: at, leaseMs, leaseExpiresAt: leaseMs ? new Date(Date.now() + leaseMs).toISOString() : undefined, owner };
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

  async active(owner?: string | null): Promise<Todo | undefined> {
    return this.findActiveTodo(await this.expireClaims(await this.state()), owner);
  }

  async begin(capabilities: string[] = [], leaseMs?: number, owner?: string | null, options: StartTodoOptions = {}): Promise<Todo> {
    const state = await this.expireClaims(await this.state());
    const active = this.findActiveTodo(state, owner);
    if (active) return active;
    const todo = nextTodo(state, { capabilities });
    if (!todo) throw workflowError("NO_READY_TODO", "no ready todo is available", { action: "list", params: {} });
    return this.start(todo.id, capabilities, leaseMs, owner, options);
  }

  async finish(todoId?: string, evidence: EvidenceRef[] = [], summary?: string, owner?: string | null): Promise<Todo> {
    const target = todoId ? await this.get(todoId) : await this.active(owner);
    if (!target) throw workflowError("NO_ACTIVE_TODO", "no active todo to finish", { action: "begin", params: {} });
    return this.complete(target.id, evidence, summary);
  }

  async noteArtifact(todoId: string | undefined, input: CreateArtifactInput, owner?: string | null): Promise<{ todo: Todo; path: string }> {
    const target = todoId ? await this.get(todoId) : await this.active(owner);
    if (!target) throw workflowError("NO_ACTIVE_TODO", "no active todo for artifact", { action: "begin", params: {} });
    return this.createArtifact(target.id, input);
  }

  async start(todoId: string, capabilities: string[] = [], leaseMs?: number, owner?: string | null, options: StartTodoOptions = {}): Promise<Todo> {
    let state = await this.expireClaims(await this.state());
    let todo = this.requireTodo(state, todoId);
    if (todo.status === "blocked") throw workflowError("TODO_BLOCKED", "cannot start blocked todo", { action: "get", params: { todoId } });
    const splitResult = await this.splitCheck(todoId);
    if (shouldBlockForSplit(splitResult, this.policy.splitting, options.splitOverrideReason)) {
      const nextAction = splitResult.assessment === "too_vague" ? "clarify expected outcome and acceptance criteria" : splitResult.assessment === "epic" ? "split into child tasks or mark as parent-only" : "split into child tasks";
      throw workflowError(
        "SPLIT_REQUIRED",
        `blocked: task requires splitting; assessment:${splitResult.assessment}; reason:${splitResult.reasons.join(", ")}; next_action:${nextAction}`,
        { action: "split", params: { todoId, auto: true, apply: false } },
        { splitCheck: splitResult },
      );
    }
    if (options.splitOverrideReason?.trim() && !splitResult.splitPolicySatisfied) {
      await this.append({ id: id("evt"), type: "todo.updated", at: now(), todoId, patch: { splitOverrideReason: options.splitOverrideReason.trim(), splitPolicySatisfied: true } });
    }
    state = await this.state();
    todo = this.requireTodo(state, todoId);
    const eligibilityTodo = { ...todo, status: todo.status === "claimed" ? "ready" as TodoStatus : todo.status };
    const reasons = ineligibleReasons(eligibilityTodo, state, { capabilities });
    const openDeps = openDependencyIds(todo, state);
    if (openDeps.length > 0) throw workflowError("DEPENDENCY_OPEN", `dependency not done: ${openDeps[0]}`, { action: "get", params: { todoId: openDeps[0] } });
    if (reasons.length > 0 && todo.status !== "claimed") throw workflowError("TODO_NOT_READY", `todo is not ready: ${reasons.join(", ")}`, { action: "next_ready", params: {} }, { reasons });
    const effectiveOwner = owner ?? todo.owner ?? null;
    const ownerActive = this.findActiveTodo(state, effectiveOwner, todoId);
    if (this.activeCount(state, todoId, effectiveOwner) >= this.policy.maxInProgress) throw workflowError("MAX_IN_PROGRESS", "max in-progress todos reached", ownerActive ? { action: "get", params: { todoId: ownerActive.id } } : { action: "list", params: {} });
    const globalActive = this.findActiveTodo(state, undefined, todoId);
    if (this.policy.globalMaxInProgress !== undefined && this.globalActiveCount(state, todoId) >= this.policy.globalMaxInProgress) throw workflowError("GLOBAL_MAX_IN_PROGRESS", "global max in-progress todos reached", globalActive ? { action: "get", params: { todoId: globalActive.id } } : { action: "list", params: {} });
    if (!todo.activeClaimId) {
      await this.claim(todoId, capabilities, leaseMs, effectiveOwner);
      state = await this.state();
      todo = this.requireTodo(state, todoId);
    }
    await this.append({ id: id("evt"), type: "todo.started", at: now(), todoId });
    return this.get(todoId);
  }

  async complete(todoId: string, evidence: EvidenceRef[] = [], summary?: string): Promise<Todo> {
    const todo = await this.get(todoId);
    if (this.policy.requireEvidenceForDone && todo.evidence.length + evidence.length === 0) {
      throw workflowError(
        "EVIDENCE_REQUIRED",
        "evidence is required to complete a todo",
        { action: "attach_evidence", params: { todoId, evidence: [{ type: "manual_note", note: "describe verification or completed work" }] } },
      );
    }
    await this.append({ id: id("evt"), type: "todo.completed", at: now(), todoId, evidence, summary });
    await this.closeStaleSplitScaffold(todoId);
    return this.get(todoId);
  }

  async reconcileSplitScaffolds(): Promise<TodoState> {
    let state = await this.state();
    let changed = false;
    for (const todo of Object.values(state.todos)) {
      if (!todo.children.length) continue;
      const parentChanged = await this.reconcileSplitParent(todo.id, state, undefined, { closeReadyParent: true });
      if (parentChanged) {
        changed = true;
        state = await this.state();
      }
    }
    return changed ? this.state() : state;
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
    const existing = await this.get(todoId);
    if (!ARTIFACT_FOLDERS.has(input.kind)) throw new Error("invalid artifact kind");
    if (!input.purpose.trim()) throw new Error("artifact purpose is required");
    const at = now();
    const path = artifactPath(input.kind, input.shortName, at, existing, input);
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

  async next(options: EligibilityOptions = {}): Promise<Todo | undefined> { return nextTodo(await this.expireClaims(await this.state()), options); }
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

  private isSplitScaffold(todo: Todo): boolean {
    return todo.tags.includes(SPLIT_SCAFFOLD_TAG);
  }

  private async closeStaleSplitScaffold(completedTodoId: string): Promise<void> {
    const state = await this.state();
    const completed = state.todos[completedTodoId];
    if (!completed?.parentId) return;
    await this.reconcileSplitParent(completed.parentId, state, completedTodoId);
  }

  private async reconcileSplitParent(parentId: string, state: TodoState, completedTodoId?: string, options: { closeReadyParent?: boolean } = {}): Promise<boolean> {
    const parent = state.todos[parentId];
    if (!parent || isTerminalStatus(parent.status) || (parent.workDirectlyAllowed !== false && parent.splitAssessment !== "epic")) return false;
    const children = parent.children.map((childId) => state.todos[childId]).filter((child): child is Todo => Boolean(child));
    if (!children.some((child) => isSuccessStatus(child.status))) return false;

    let changed = false;
    for (const child of children) {
      if (child.id === completedTodoId || isTerminalStatus(child.status) || child.status === "in_progress" || child.activeClaimId || !this.isSplitScaffold(child)) continue;
      await this.append({ id: id("evt"), type: "todo.cancelled", at: now(), todoId: child.id, reason: "stale split scaffold closed after sibling completion" });
      changed = true;
    }

    const currentState = changed ? await this.state() : state;
    const currentParent = currentState.todos[parent.id];
    if ((changed || options.closeReadyParent) && currentParent && !isTerminalStatus(currentParent.status) && currentParent.children.length > 0 && currentParent.children.every((childId) => currentState.todos[childId] && isTerminalStatus(currentState.todos[childId].status))) {
      await this.append({ id: id("evt"), type: "todo.completed", at: now(), todoId: currentParent.id, evidence: [{ type: "manual_note", note: "split container completed after child work and stale scaffolding closed" }], summary: "split container completed" });
      changed = true;
    }
    return changed;
  }

  private activeCount(state: TodoState, exceptTodoId: string, owner?: string | null): number {
    return Object.values(state.todos).filter((todo) => todo.status === "in_progress" && todo.id !== exceptTodoId && (owner ? todo.owner === owner : true) && !isTerminalStatus(todo.status)).length;
  }

  private globalActiveCount(state: TodoState, exceptTodoId: string): number {
    return Object.values(state.todos).filter((todo) => todo.status === "in_progress" && todo.id !== exceptTodoId && !isTerminalStatus(todo.status)).length;
  }

  private async expireClaims(state: TodoState): Promise<TodoState> {
    const at = now();
    for (const claim of Object.values(state.claims)) {
      if (claim.status === "active" && claim.leaseExpiresAt && claim.leaseExpiresAt <= at) {
        await this.append({ id: id("evt"), type: "todo.claim_expired", at, todoId: claim.todoId, claimId: claim.id, reason: "lease_expired" });
      }
    }
    return this.state();
  }

  private async requireExisting(todoId: string): Promise<void> { this.requireTodo(await this.state(), todoId); }
  private async validateGeneratedArtifact(todoId: string, path: string, createdByTodoId: string): Promise<void> {
    const repair = { action: "create_artifact", params: { todoId, kind: "todo", shortName: "artifact", purpose: "generated artifact", content: "" } };
    if (createdByTodoId !== todoId) throw workflowError("ARTIFACT_TODO_MISMATCH", "generated artifact createdByTodoId must match todoId", repair);
    if (path.startsWith("/") || path.includes("..") || !path.startsWith(MODEL_ARTIFACTS_DIR)) throw workflowError("ARTIFACT_PATH_INVALID", "generated artifacts must be under .model-artifacts/", repair);
    const parts = path.split("/");
    const folder = parts[1];
    const name = parts.pop()?.toLowerCase() ?? "";
    if (!ARTIFACT_FOLDERS.has(folder)) throw workflowError("ARTIFACT_PATH_INVALID", "generated artifacts must use an approved .model-artifacts subfolder", repair);
    if (parts.length < 3) throw workflowError("ARTIFACT_PATH_INVALID", "generated artifact paths must include a topic directory", repair);
    if (folder === "todo" && parts.length < 3) throw workflowError("ARTIFACT_PATH_INVALID", `todo artifacts must be under ${MODEL_TODO_ARTIFACTS_DIR}<topic>/`, repair);
    if (name.includes("todo") && !path.startsWith(MODEL_TODO_ARTIFACTS_DIR)) throw workflowError("ARTIFACT_PATH_INVALID", `todo files must be under ${MODEL_TODO_ARTIFACTS_DIR}`, repair);
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) throw workflowError("ARTIFACT_PATH_INVALID", "generated artifact filenames must be YYYY-MM-DD_HHMM-short-kebab-name.md", repair);
    try {
      const text = await readFile(path, "utf8");
      if (!/^# .+\n\nCreated: .+\nPurpose: .+/m.test(text)) throw workflowError("ARTIFACT_FORMAT_INVALID", "generated artifact markdown must start with heading, Created, and Purpose", repair);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private findActiveTodo(state: TodoState, owner?: string | null, exceptTodoId?: string): Todo | undefined {
    return Object.values(state.todos).find((todo) => todo.id !== exceptTodoId && (todo.status === "in_progress" || todo.status === "claimed") && (owner ? todo.owner === owner : true));
  }
  private async append(event: TodoEvent): Promise<void> { await this.store.append(event); }
  private requireTodo(state: TodoState, todoId: string): Todo { const todo = state.todos[todoId]; if (!todo) throw new Error(`todo not found: ${todoId}`); return todo; }
}
