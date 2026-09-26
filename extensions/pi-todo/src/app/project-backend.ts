import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { TodoPublicAction, TodoPublicRequest } from "../../../../src/todo-contracts/contract.ts";
import type { TodoBackend, TodoCapabilities, TodoMutationResult, TodoView, TodoViewItem } from "../../../../src/todo-contracts/provider.ts";
import { ProjectTodoStore, type ProjectTodoSnapshot } from "./project-store.ts";
import { BranchTodoCore, TODO_EVENT_CUSTOM_TYPE, TODO_EVENT_VERSION, type TodoBranchEntry, type TodoCoreState } from "../domain/state-core.ts";

/** Durable lightweight backend. .pi-todos.json is its only authority. */
export class ProjectTodoBackend implements TodoBackend {
  readonly kind = "project" as const;
  private readonly store: ProjectTodoStore;

  constructor(cwdOrStore: string | ProjectTodoStore) {
    this.store = typeof cwdOrStore === "string" ? new ProjectTodoStore(cwdOrStore) : cwdOrStore;
  }

  view(): TodoView {
    return projectTodoView(this.store.read(), basename(this.store.root));
  }

  supports(action: TodoPublicAction, itemId?: string): boolean {
    if (action === "list" || action === "create") return true;
    const item = itemId ? this.view().items.find((candidate) => candidate.id === itemId) : undefined;
    return Boolean(item?.capabilities[action as keyof TodoCapabilities]);
  }

  execute(request: TodoPublicRequest): TodoMutationResult {
    const snapshot = this.store.read();
    const before = projectTodoView(snapshot, basename(this.store.root));
    if (request.action === "list") return { view: before };
    const branch: TodoBranchEntry[] = snapshot.state.order.map((id, index) => ({
      type: "custom",
      customType: TODO_EVENT_CUSTOM_TYPE,
      data: {
        version: TODO_EVENT_VERSION,
        event: { id: `snapshot-${index}`, type: "todo.created", at: "1970-01-01T00:00:00.000Z", todo: snapshot.state.todos[id] },
      },
    }));
    const core = new BranchTodoCore({
      getBranch: () => branch,
      appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
      createId: (prefix) => prefix === "todo" ? `ptodo_${randomUUID()}` : `event_${randomUUID()}`,
    });
    let item;
    let deletedCount: number | undefined;
    if (request.action === "create") item = core.create(request.title, request.parentTodoId);
    else if (request.action === "move") item = core.move(request.todoId, request.beforeTodoId, request.afterTodoId);
    else if (request.action === "delete") ({ todo: item, deletedCount } = core.delete(request.todoId));
    else if (request.action === "start") item = core.start(request.todoId);
    else if (request.action === "finish") item = core.finish(request.todoId, request.summary);
    else if (request.action === "block") item = core.block(request.todoId, request.reason);
    else item = core.unblock(request.todoId);
    const stored = this.store.write(snapshot, core.state());
    const view = projectTodoView(stored, basename(this.store.root));
    return { item: item ? view.items.find((candidate) => candidate.id === item.id) ?? before.items.find((candidate) => candidate.id === item.id) : undefined, deletedCount, view };
  }
}

export function projectSessionTodoView(state: TodoCoreState): TodoView {
  return lightweightTodoView(state, "session", "current-session");
}

export function projectTodoView(snapshot: ProjectTodoSnapshot, projectName: string): TodoView {
  return lightweightTodoView(snapshot.state, "project", `${projectName}/${basename(snapshot.path)}`, snapshot.revision);
}

function lightweightTodoView(
  state: TodoCoreState,
  scope: "session" | "project",
  authorityId: string,
  revision?: number,
): TodoView {
  const depth = (id: string): number => {
    let value = 0;
    let parentId = state.todos[id]?.parentTodoId;
    const seen = new Set([id]);
    while (parentId && state.todos[parentId] && !seen.has(parentId)) {
      seen.add(parentId);
      value += 1;
      parentId = state.todos[parentId]?.parentTodoId;
    }
    return value;
  };
  return {
    provider: scope === "session" ? "standalone" : "project",
    scope,
    authorityId,
    revision,
    items: state.order.map((id) => state.todos[id]).filter(Boolean).map((todo) => {
      const capabilities: TodoCapabilities = {
        create: false,
        move: true,
        delete: true,
        start: todo.status === "ready" && !state.activeTodoId,
        finish: todo.status === "in_progress" && !hasOpenDescendant(state, todo.id),
        block: todo.status === "ready" || todo.status === "in_progress",
        unblock: todo.status === "external_blocked",
      };
      const status = todo.status === "in_progress" ? "active" : todo.status === "external_blocked" ? "blocked" : todo.status === "completed" ? "complete" : "ready";
      return {
        id: todo.id,
        scope,
        authorityId,
        title: todo.title,
        status,
        rawStatus: todo.status,
        parentId: todo.parentTodoId,
        depth: depth(todo.id),
        blockedReason: todo.blockedReason,
        ready: todo.status === "ready",
        executable: true,
        capabilities,
      } satisfies TodoViewItem;
    }),
  };
}

function hasOpenDescendant(state: TodoCoreState, todoId: string): boolean {
  const queue = [todoId];
  const seen = new Set(queue);
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const id of state.order) {
      const todo = state.todos[id];
      if (!todo || seen.has(id) || todo.parentTodoId !== parentId) continue;
      if (todo.status !== "completed") return true;
      seen.add(id);
      queue.push(id);
    }
  }
  return false;
}
