import { normalizePriority, normalizeStatus } from "../domain/lifecycle.ts";
import { reduceTodoState } from "../domain/reducer.ts";
import { emptyScope, type Todo, type TodoEvent, type TodoPriority, type TodoScope, type TodoState, type TodoStatus } from "../domain/types.ts";

export interface TodoEventStore { read(): Promise<TodoEvent[]>; append(event: TodoEvent): Promise<void> }

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

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function createTodoRecord(input: CreateTodoInput, at: string, parent?: Todo): Todo {
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

export class TodoLedger {
  private readonly store: TodoEventStore;

  constructor(store: TodoEventStore) {
    this.store = store;
  }

  async state(): Promise<TodoState> { return reduceTodoState(await this.store.read()); }

  async events(): Promise<TodoEvent[]> { return this.store.read(); }

  async append(event: TodoEvent): Promise<void> { await this.store.append(event); }

  async create(input: CreateTodoInput): Promise<Todo> {
    const at = now();
    const todo = createTodoRecord(input, at);
    await this.append({ id: id("evt"), type: "todo.created", at, commandId: input.commandId, todo });
    return todo;
  }

  requireTodo(state: TodoState, todoId: string): Todo {
    const todo = state.todos[todoId];
    if (!todo) throw new Error(`todo not found: ${todoId}`);
    return todo;
  }
}
