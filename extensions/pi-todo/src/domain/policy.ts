import { isReadyStatus, isTerminalStatus } from "./lifecycle.ts";
import type { Todo, TodoScope, TodoState } from "./types.ts";

export type PolicyPhase = "claim" | "complete" | "verify";
export type EligibilityOptions = { actor?: string; actorCapabilities?: string[]; actorScope?: Partial<TodoScope> };

function phaseCapabilities(todo: Todo, phase: PolicyPhase): string[] {
  const prefix = `${phase}.requires:`;
  return (todo.scope?.policyTags ?? []).filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length).trim()).filter(Boolean);
}

export function requiredCapabilitiesFor(todo: Todo, phase: PolicyPhase): string[] {
  const phaseRequired = phaseCapabilities(todo, phase);
  return phase === "verify" ? phaseRequired : [...(todo.requiredCapabilities ?? []), ...phaseRequired];
}

export function missingCapabilities(todo: Todo, actorCapabilities: readonly string[] | undefined, phase: PolicyPhase): string[] {
  const required = requiredCapabilitiesFor(todo, phase);
  if (required.length === 0) return [];
  const actorSet = new Set(actorCapabilities ?? []);
  return required.filter((capability) => !actorSet.has(capability));
}

export function scopeAllows(todoScope: TodoScope | undefined, actorScope?: Partial<TodoScope>): boolean {
  if (!todoScope || !actorScope) return true;
  for (const key of ["repo", "branch", "worktree", "component", "service", "domain"] as const) {
    if (todoScope[key] && actorScope[key] && todoScope[key] !== actorScope[key]) return false;
  }
  return true;
}

export function openDependencyIds(todo: Todo, state: TodoState): string[] {
  return todo.dependsOn.filter((id) => !state.todos[id] || !isTerminalStatus(state.todos[id].status));
}

export function openChildIds(todo: Todo, state: TodoState): string[] {
  return (todo.children ?? []).filter((id) => state.todos[id] && !isTerminalStatus(state.todos[id].status));
}

export function readyToClose(todo: Todo, state: TodoState): boolean {
  return (todo.children ?? []).length > 0 && openChildIds(todo, state).length === 0 && !isTerminalStatus(todo.status);
}

export function ineligibleReasons(todo: Todo, state: TodoState, options: EligibilityOptions = {}): string[] {
  const reasons: string[] = [];
  if (!isReadyStatus(todo.status) && !readyToClose(todo, state)) reasons.push(`status:${todo.status}`);
  if (openDependencyIds(todo, state).length > 0) reasons.push("open_dependencies");
  if ((todo.children ?? []).length > 0 && !readyToClose(todo, state)) reasons.push("open_children");
  if (todo.claimedBy && todo.claimedBy !== options.actor) reasons.push("claimed_by_other");
  if (!scopeAllows(todo.scope, options.actorScope)) reasons.push("scope_mismatch");
  const missing = missingCapabilities(todo, options.actorCapabilities, "claim");
  if (missing.length > 0) reasons.push(`missing_capabilities:${missing.join(",")}`);
  return reasons;
}
