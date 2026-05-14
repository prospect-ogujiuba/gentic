import { isReadyStatus, isTerminalStatus } from "./lifecycle.ts";
import type { Todo, TodoState } from "./types.ts";

export type PolicyPhase = "claim" | "complete" | "verify";
export type EligibilityOptions = { capabilities?: string[] };
export type ToolPolicyAction = "allow" | "requireTodo";
export type ToolPolicyRule = { pattern: string; action: ToolPolicyAction };
export type ToolPolicyConfig = { defaultAction: ToolPolicyAction; rules?: readonly ToolPolicyRule[] };
export type ToolPolicyDecision = {
  action: ToolPolicyAction;
  reason: "todo_tool" | "rule" | "default";
  pattern?: string;
};

export function matchesToolName(pattern: string, toolName: string): boolean {
  if (!pattern || !toolName) return false;
  if (!pattern.includes("*")) return pattern === toolName;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(toolName);
}

export function decideToolPolicy(toolName: string, config: ToolPolicyConfig): ToolPolicyDecision {
  if (toolName === "todo") return { action: "allow", reason: "todo_tool", pattern: "todo" };

  const matchingRules = (config.rules ?? [])
    .map((rule, index) => ({ rule, index, specificity: toolPatternSpecificity(rule.pattern) }))
    .filter(({ rule }) => matchesToolName(rule.pattern, toolName));

  matchingRules.sort((left, right) => {
    const actionPrecedence = toolActionPrecedence(right.rule.action) - toolActionPrecedence(left.rule.action);
    if (actionPrecedence !== 0) return actionPrecedence;
    const exactPrecedence = Number(!right.rule.pattern.includes("*")) - Number(!left.rule.pattern.includes("*"));
    if (exactPrecedence !== 0) return exactPrecedence;
    const specificityPrecedence = right.specificity - left.specificity;
    if (specificityPrecedence !== 0) return specificityPrecedence;
    return left.index - right.index;
  });

  const match = matchingRules[0]?.rule;
  if (match) return { action: match.action, reason: "rule", pattern: match.pattern };
  return { action: config.defaultAction, reason: "default" };
}

function toolActionPrecedence(action: ToolPolicyAction): number {
  return action === "requireTodo" ? 2 : 1;
}

function toolPatternSpecificity(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

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
