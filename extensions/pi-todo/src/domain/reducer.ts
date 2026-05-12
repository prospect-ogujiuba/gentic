import { isTerminalStatus, normalizeStatus } from "./lifecycle.ts";
import type { Todo, TodoClaim, TodoEvent, TodoState } from "./types.ts";

export function emptyTodoState(): TodoState {
  return { todos: {}, order: [], claims: {}, events: [] };
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function updateTodo(todo: Todo, patch: Partial<Todo>, at: string): Todo {
  return { ...todo, ...patch, updatedAt: at, revision: todo.revision + 1 };
}
function releaseClaim(claim: TodoClaim, at: string, reason?: string): TodoClaim {
  return { ...claim, status: "released", releasedAt: at, releaseReason: reason };
}
function releaseActiveClaim(claims: Record<string, TodoClaim>, todo: Todo, at: string, reason: string): void {
  if (todo.activeClaimId && claims[todo.activeClaimId]) claims[todo.activeClaimId] = releaseClaim(claims[todo.activeClaimId], at, reason);
}

export function applyTodoEvent(state: TodoState, event: TodoEvent): TodoState {
  const todos = { ...state.todos };
  const order = [...state.order];
  const claims = { ...state.claims };

  if (event.type === "todo.created") {
    todos[event.todo.id] = { ...event.todo, status: normalizeStatus(event.todo.status), children: event.todo.children ?? [], blocks: event.todo.blocks ?? [], blockers: event.todo.blockers ?? [], constraints: event.todo.constraints ?? [], definitionOfDone: event.todo.definitionOfDone ?? [], requiredCapabilities: event.todo.requiredCapabilities ?? [] };
    if (!order.includes(event.todo.id)) order.push(event.todo.id);
    if (event.todo.parentId && todos[event.todo.parentId]) todos[event.todo.parentId] = updateTodo(todos[event.todo.parentId], { children: unique([...todos[event.todo.parentId].children, event.todo.id]) }, event.at);
  } else if (event.type === "todo.split") {
    const parent = todos[event.todoId];
    for (const child of event.children) {
      todos[child.id] = { ...child, status: normalizeStatus(child.status) };
      if (!order.includes(child.id)) order.push(child.id);
    }
    if (parent) todos[event.todoId] = updateTodo(parent, { children: unique([...parent.children, ...event.children.map((child) => child.id)]), notes: [...parent.notes, `split: ${event.reason}`], splitAssessment: "epic", splitAssessmentConfidence: "high", splitAssessmentReasons: [event.reason], splitPolicySatisfied: false, splitCheckedAt: event.at, workDirectlyAllowed: false }, event.at);
  } else {
    const todo = todos[event.todoId];
    if (!todo) return { todos, order, claims, events: [...state.events, event], lastEventId: event.id };
    if (event.type === "todo.updated") todos[event.todoId] = updateTodo(todo, event.patch.status ? { ...event.patch, status: normalizeStatus(event.patch.status) } : event.patch, event.at);
    if (event.type === "todo.dependency_linked") {
      todos[event.todoId] = updateTodo(todo, { dependsOn: unique([...todo.dependsOn, event.dependencyTodoId]) }, event.at);
      const dep = todos[event.dependencyTodoId];
      if (dep) todos[event.dependencyTodoId] = updateTodo(dep, { blocks: unique([...dep.blocks, event.todoId]) }, event.at);
    }
    if (event.type === "todo.claimed") { claims[event.claim.id] = event.claim; todos[event.todoId] = updateTodo(todo, { status: "claimed", activeClaimId: event.claim.id, leaseExpiresAt: event.claim.leaseExpiresAt, owner: event.claim.owner ?? todo.owner }, event.at); }
    if (event.type === "todo.lease_renewed") { const claim = claims[event.claimId]; if (claim) claims[event.claimId] = { ...claim, lastHeartbeatAt: event.at, leaseExpiresAt: event.leaseExpiresAt }; todos[event.todoId] = updateTodo(todo, { leaseExpiresAt: event.leaseExpiresAt }, event.at); }
    if (event.type === "todo.released") { const claimId = event.claimId || todo.activeClaimId; if (claimId && claims[claimId]) claims[claimId] = releaseClaim(claims[claimId], event.at, event.reason); if (!isTerminalStatus(todo.status)) todos[event.todoId] = updateTodo(todo, { status: "ready", activeClaimId: null, leaseExpiresAt: null }, event.at); }
    if (event.type === "todo.claim_expired") { if (claims[event.claimId]) claims[event.claimId] = releaseClaim(claims[event.claimId], event.at, event.reason ?? "lease_expired"); if (todo.activeClaimId === event.claimId && !isTerminalStatus(todo.status)) todos[event.todoId] = updateTodo(todo, { status: "ready", activeClaimId: null, leaseExpiresAt: null }, event.at); }
    if (event.type === "todo.started") todos[event.todoId] = updateTodo(todo, { status: "in_progress", startedAt: event.at, blockedReason: undefined }, event.at);
    if (event.type === "todo.blocked") todos[event.todoId] = updateTodo(todo, { status: "blocked", blockedReason: event.reason, blockers: unique([...todo.blockers, event.reason]) }, event.at);
    if (event.type === "todo.unblocked") todos[event.todoId] = updateTodo(todo, { status: "ready", blockedReason: undefined, blockers: [] }, event.at);
    if (event.type === "todo.evidence_attached") todos[event.todoId] = updateTodo(todo, { evidence: [...todo.evidence, ...event.evidence] }, event.at);
    if (event.type === "todo.completed") { releaseActiveClaim(claims, todo, event.at, "completed"); todos[event.todoId] = updateTodo(todo, { status: "completed", completedAt: event.at, activeClaimId: null, leaseExpiresAt: null, evidence: [...todo.evidence, ...event.evidence], notes: event.summary ? [...todo.notes, event.summary] : todo.notes }, event.at); }
    if (event.type === "todo.failed") { releaseActiveClaim(claims, todo, event.at, "failed"); todos[event.todoId] = updateTodo(todo, { status: "failed", completedAt: event.at, activeClaimId: null, leaseExpiresAt: null, evidence: [...todo.evidence, ...(event.evidence ?? [])], notes: event.reason ? [...todo.notes, event.reason] : todo.notes }, event.at); }
    if (event.type === "todo.verified") { releaseActiveClaim(claims, todo, event.at, "verified"); todos[event.todoId] = updateTodo(todo, { status: "verified", activeClaimId: null, leaseExpiresAt: null, evidence: [...todo.evidence, ...(event.evidence ?? [])], notes: event.summary ? [...todo.notes, event.summary] : todo.notes }, event.at); }
    if (event.type === "todo.reopened") todos[event.todoId] = updateTodo(todo, { status: normalizeStatus(event.targetStatus ?? "ready"), completedAt: undefined, notes: event.reason ? [...todo.notes, `reopened: ${event.reason}`] : todo.notes }, event.at);
    if (event.type === "todo.cancelled") { releaseActiveClaim(claims, todo, event.at, "cancelled"); todos[event.todoId] = updateTodo(todo, { status: "cancelled", activeClaimId: null, leaseExpiresAt: null, notes: event.reason ? [...todo.notes, event.reason] : todo.notes }, event.at); }
    if (event.type === "todo.abandoned") { releaseActiveClaim(claims, todo, event.at, "abandoned"); todos[event.todoId] = updateTodo(todo, { status: "abandoned", activeClaimId: null, leaseExpiresAt: null, notes: event.reason ? [...todo.notes, event.reason] : todo.notes }, event.at); }
    if (event.type === "todo.note_added") todos[event.todoId] = updateTodo(todo, { notes: [...todo.notes, event.note] }, event.at);
  }
  return { todos, order, claims, events: [...state.events, event], lastEventId: event.id };
}

export function reduceTodoState(events: TodoEvent[]): TodoState { return events.reduce(applyTodoEvent, emptyTodoState()); }
export { isTerminalStatus };
