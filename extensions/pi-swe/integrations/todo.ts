import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SweService } from "../src/app/service.ts";
import type { SweSurfaceController } from "../src/pi/register.ts";
import { readyWork, type Initiative, type WorkItem } from "../src/domain/initiative.ts";
import type { TodoPublicAction, TodoPublicRequest } from "../../../src/pi-todo/contract.ts";
import {
  TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT,
  TODO_WORKFLOW_PROVIDER_REQUEST_EVENT,
  type TodoWorkflowProvider,
} from "../../../src/pi-todo/workflow-integration.ts";
import {
  NO_TODO_CAPABILITIES,
  type TodoBackend,
  type TodoCapabilities,
  type TodoMutationResult,
  type TodoView,
  type TodoViewItem,
  type TodoViewStatus,
} from "../../../src/pi-todo/provider.ts";
import { WorkflowTodoError } from "../../../src/pi-todo/provider.ts";
export { WorkflowTodoError } from "../../../src/pi-todo/provider.ts";

/** Publish the optional projection through Pi's native cross-extension event bus. */
export function registerWorkflowTodoProvider(pi: ExtensionAPI, swe: SweSurfaceController): void {
  if (!pi.events) return;
  const provider: TodoWorkflowProvider = {
    resolve(ctx: ExtensionContext) {
      const authority = swe.focusedAuthority(ctx);
      return authority ? new WorkflowTodoBackend(authority.service, authority.initiativeId) : undefined;
    },
  };
  const announce = () => { pi.events.emit(TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT, provider); };
  pi.events.on(TODO_WORKFLOW_PROVIDER_REQUEST_EVENT, announce);
  announce();
}

/** A projection adapter only: workflow.json remains the sole state authority. */
export class WorkflowTodoBackend implements TodoBackend {
  readonly kind = "workflow" as const;
  private readonly service: SweService;
  private readonly initiativeId: string;

  constructor(service: SweService, initiativeId: string) {
    this.service = service;
    this.initiativeId = initiativeId;
  }

  view(): TodoView {
    return projectWorkflowTodoView(this.service.status(this.initiativeId).initiative);
  }

  supports(action: TodoPublicAction, itemId?: string): boolean {
    if (action === "list") return true;
    const view = this.view();
    const item = itemId ? view.items.find((candidate) => candidate.id === itemId) : undefined;
    return Boolean(item?.capabilities[action as keyof TodoCapabilities]);
  }

  async execute(request: TodoPublicRequest): Promise<TodoMutationResult> {
    // Reread immediately before every mutation; the service then performs its
    // own revision/hash compare-and-swap against this authority.
    const before = this.view();
    if (request.action === "list") return { view: before };
    if (request.action === "start") {
      requireCapability(before, request.todoId, "start");
      await this.service.start(this.initiativeId, request.todoId);
      return resultFor(this.view(), request.todoId);
    }
    if (request.action === "finish") {
      const todoId = request.todoId ?? onlyActive(before)?.id;
      if (!todoId) throw new WorkflowTodoError("INVALID_TRANSITION", "no active workflow work to mark implemented");
      requireCapability(before, todoId, "finish");
      await this.service.markImplemented(this.initiativeId, todoId);
      return resultFor(this.view(), todoId);
    }
    throw new WorkflowTodoError(
      "UNSUPPORTED_WORKFLOW_ACTION",
      `todo ${request.action} cannot change workflow structure or lifecycle; use an intentional swe revision`,
    );
  }
}

export function projectWorkflowTodoView(initiative: Initiative): TodoView {
  const parents = new Set(initiative.work.flatMap((item) => item.parentId ? [item.parentId] : []));
  const ready = new Set(readyWork(initiative).map((item) => item.id));
  const byId = new Map(initiative.work.map((item) => [item.id, item]));
  const depthOf = (item: WorkItem): number => {
    let depth = 0; let parentId = item.parentId; const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) { seen.add(parentId); depth += 1; parentId = byId.get(parentId)?.parentId; }
    return depth;
  };
  return {
    provider: "workflow",
    scope: "initiative",
    authorityId: initiative.id,
    authorityStatus: initiative.status,
    revision: initiative.revision,
    items: initiative.work.slice(0, 1_000).map((item) => projectItem(item, initiative.id, initiative.status === "active", parents.has(item.id), ready.has(item.id), depthOf(item))),
  };
}

function projectItem(item: WorkItem, authorityId: string, authorityActive: boolean, isParent: boolean, isReady: boolean, depth: number): TodoViewItem {
  const executable = item.kind !== "phase" && !isParent;
  const status = viewStatus(item);
  const capabilities: TodoCapabilities = {
    ...NO_TODO_CAPABILITIES,
    start: authorityActive && executable && item.status === "pending" && isReady && !item.disposition,
    finish: authorityActive && executable && item.status === "active" && !item.disposition,
  };
  return {
    id: item.id,
    scope: "initiative",
    authorityId,
    title: item.title,
    status,
    rawStatus: item.status ?? item.kind,
    parentId: item.parentId,
    depth,
    blockedReason: item.status === "blocked" ? "blocked; revise or resume through swe" : undefined,
    waitingOn: [...(item.dependsOn ?? [])],
    ready: isReady,
    executable,
    capabilities,
  };
}

function viewStatus(item: WorkItem): TodoViewStatus {
  if (item.kind === "phase") return "group";
  if (item.status === "active") return "active";
  if (item.status === "blocked") return "blocked";
  if (item.status === "implemented") return "implemented";
  if (item.status === "complete") return "complete";
  return "ready";
}

function onlyActive(view: TodoView): TodoViewItem | undefined {
  const active = view.items.filter((item) => item.status === "active" && item.executable);
  return active.length === 1 ? active[0] : undefined;
}

function requireCapability(view: TodoView, todoId: string, action: "start" | "finish"): TodoViewItem {
  const item = view.items.find((candidate) => candidate.id === todoId);
  if (!item) throw new WorkflowTodoError("TODO_NOT_FOUND", `workflow work not found: ${todoId}`);
  if (!item.capabilities[action]) throw new WorkflowTodoError("INVALID_TRANSITION", `workflow work ${todoId} cannot ${action} from ${item.rawStatus}`);
  return item;
}

function resultFor(view: TodoView, todoId: string): TodoMutationResult {
  return { view, item: view.items.find((candidate) => candidate.id === todoId) };
}
