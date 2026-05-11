import { isReadyStatus, isTerminalStatus } from "./lifecycle.ts";
import type { Todo, TodoState } from "./types.ts";

export type PolicyPhase = "claim" | "complete" | "verify";
export type EligibilityOptions = { capabilities?: string[] };

function phaseCapabilities(todo: Todo, phase: PolicyPhase): string[] {
  const prefix = `${phase}.requires:`;
  return (todo.scope?.policyTags ?? []).filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length).trim()).filter(Boolean);
}

export function requiredCapabilitiesFor(todo: Todo, phase: PolicyPhase): string[] {
  const phaseRequired = phaseCapabilities(todo, phase);
  return phase === "verify" ? phaseRequired : [...(todo.requiredCapabilities ?? []), ...phaseRequired];
}

export function missingCapabilities(todo: Todo, capabilities: readonly string[] | undefined, phase: PolicyPhase): string[] {
  const required = requiredCapabilitiesFor(todo, phase);
  if (required.length === 0) return [];
  const capabilitySet = new Set(capabilities ?? []);
  return required.filter((capability) => !capabilitySet.has(capability));
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
  const missing = missingCapabilities(todo, options.capabilities, "claim");
  if (missing.length > 0) reasons.push(`missing_capabilities:${missing.join(",")}`);
  return reasons;
}
