import type { TodoPublicAction, TodoPublicRequest, TodoScope } from "./contract.ts";

/** Typed integration failure; no dependency on a workflow implementation. */
export class WorkflowTodoError extends Error {
  readonly code: "TODO_NOT_FOUND" | "INVALID_TRANSITION" | "UNSUPPORTED_WORKFLOW_ACTION";

  constructor(code: WorkflowTodoError["code"], message: string) {
    super(message);
    this.name = "WorkflowTodoError";
    this.code = code;
  }
}

/** Provider-neutral status. rawStatus retains authority-specific lifecycle detail. */
export type TodoViewStatus = "ready" | "active" | "blocked" | "implemented" | "complete" | "group";

export type TodoCapabilities = Readonly<{
  create: boolean;
  move: boolean;
  delete: boolean;
  start: boolean;
  finish: boolean;
  block: boolean;
  unblock: boolean;
}>;

export type TodoViewItem = {
  id: string;
  scope: Exclude<TodoScope, "all">;
  authorityId: string;
  title: string;
  status: TodoViewStatus;
  rawStatus: string;
  parentId?: string;
  depth: number;
  blockedReason?: string;
  waitingOn?: string[];
  ready: boolean;
  executable: boolean;
  capabilities: TodoCapabilities;
};

export type TodoView = {
  provider: "standalone" | "project" | "workflow" | "combined";
  scope: TodoScope;
  authorityId: string;
  authorityStatus?: string;
  revision?: number;
  items: TodoViewItem[];
};

export type TodoMutationResult = {
  item?: TodoViewItem;
  deletedCount?: number;
  view: TodoView;
};

/**
 * A backend owns exactly one authority. Selection is external and must be
 * repeated before each operation; callers must not cache a backend across
 * workflow focus or status changes.
 */
export interface TodoBackend {
  readonly kind: TodoView["provider"];
  view(): TodoView | Promise<TodoView>;
  execute(request: TodoPublicRequest): TodoMutationResult | Promise<TodoMutationResult>;
  supports(action: TodoPublicAction, itemId?: string): boolean | Promise<boolean>;
}

export const NO_TODO_CAPABILITIES: TodoCapabilities = Object.freeze({
  create: false,
  move: false,
  delete: false,
  start: false,
  finish: false,
  block: false,
  unblock: false,
});
