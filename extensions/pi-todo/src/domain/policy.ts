import { isReadyStatus, isTerminalStatus } from "./lifecycle.ts";
import type { Todo, TodoState } from "./types.ts";

export type PolicyPhase = "claim" | "complete" | "verify";
export type EligibilityOptions = { capabilities?: string[] };
export type ToolPolicyAction = "allow" | "requireTodo";
export type ToolPolicyRule = { pattern: string; action: ToolPolicyAction };
export type ToolPolicyConfig = {
  defaultAction: ToolPolicyAction;
  rules?: readonly ToolPolicyRule[];
  bashReadonlyAllowlist?: readonly string[];
};
export type ToolPolicyDecision = {
  action: ToolPolicyAction;
  reason: "todo_tool" | "bash_readonly" | "rule" | "default";
  pattern?: string;
};
export type BashReadonlyClassification = { readonly: boolean; reason: string };

export const DEFAULT_BASH_READONLY_ALLOWLIST = Object.freeze([
  "pwd",
  "ls",
  "find",
  "rg",
  "grep",
  "head",
  "tail",
  "wc",
  "file",
  "tree",
  "du",
  "stat",
  "cd",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "git grep",
  "git remote",
  "git describe",
] as const);

export function matchesToolName(pattern: string, toolName: string): boolean {
  if (!pattern || !toolName) return false;
  if (!pattern.includes("*")) return pattern === toolName;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(toolName);
}

export function decideToolPolicy(toolName: string, config: ToolPolicyConfig, input?: unknown): ToolPolicyDecision {
  if (toolName === "todo") return { action: "allow", reason: "todo_tool", pattern: "todo" };
  if (toolName === "bash" && isBashInputReadOnly(input, config.bashReadonlyAllowlist ?? DEFAULT_BASH_READONLY_ALLOWLIST)) {
    return { action: "allow", reason: "bash_readonly", pattern: "bashReadonlyAllowlist" };
  }

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

export function isBashInputReadOnly(input: unknown, allowlist: readonly string[] = DEFAULT_BASH_READONLY_ALLOWLIST): boolean {
  if (!isPlainObject(input) || typeof input.command !== "string") return false;
  return classifyBashReadonlyCommand(input.command, allowlist).readonly;
}

export function classifyBashReadonlyCommand(command: string, allowlist: readonly string[] = DEFAULT_BASH_READONLY_ALLOWLIST): BashReadonlyClassification {
  const trimmed = command.trim();
  if (!trimmed) return { readonly: false, reason: "empty_command" };
  if (trimmed.includes("\n") || trimmed.includes("\r")) return { readonly: false, reason: "multiline_command" };

  const tokenized = tokenizeReadonlyShell(trimmed);
  if (!tokenized.ok) return { readonly: false, reason: tokenized.reason };

  const commands = splitSimpleCommands(tokenized.tokens);
  if (!commands.ok) return { readonly: false, reason: commands.reason };
  if (commands.commands.length === 0) return { readonly: false, reason: "empty_command" };

  const allowed = buildBashAllowlist(allowlist);
  for (const words of commands.commands) {
    const classification = classifySimpleReadonlyCommand(words, allowed);
    if (!classification.readonly) return classification;
  }

  return { readonly: true, reason: "readonly_allowlist" };
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

type ShellWordToken = { type: "word"; value: string };
type ShellOperatorToken = { type: "operator"; value: "&&" | ";" };
type ShellToken = ShellWordToken | ShellOperatorToken;
type TokenizeResult = { ok: true; tokens: ShellToken[] } | { ok: false; reason: string };
type SplitCommandsResult = { ok: true; commands: string[][] } | { ok: false; reason: string };
type BashAllowlist = { simple: Set<string>; gitSubcommands: Set<string> };

function tokenizeReadonlyShell(command: string): TokenizeResult {
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;

  const flushWord = () => {
    if (word !== "") {
      tokens.push({ type: "word", value: word });
      word = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === "`" || (char === "$" && next === "(")) {
        return { ok: false, reason: "command_substitution" };
      } else if (char === "\\") {
        index += 1;
        if (index >= command.length) return { ok: false, reason: "dangling_escape" };
        word += command[index];
      } else {
        word += char;
      }
      continue;
    }

    if (/\s/.test(char)) {
      flushWord();
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      index += 1;
      if (index >= command.length) return { ok: false, reason: "dangling_escape" };
      word += command[index];
      continue;
    }

    if (char === "`" || (char === "$" && next === "(")) return { ok: false, reason: "command_substitution" };
    if (char === "<" || char === ">" || char === "|" || char === "(" || char === ")" || char === "{") return { ok: false, reason: "shell_metacharacter" };

    if (char === "&") {
      if (next !== "&") return { ok: false, reason: "background_operator" };
      flushWord();
      tokens.push({ type: "operator", value: "&&" });
      index += 1;
      continue;
    }

    if (char === ";") {
      flushWord();
      tokens.push({ type: "operator", value: ";" });
      continue;
    }

    word += char;
  }

  if (quote) return { ok: false, reason: "unterminated_quote" };
  flushWord();
  return { ok: true, tokens };
}

function splitSimpleCommands(tokens: readonly ShellToken[]): SplitCommandsResult {
  const commands: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token.type === "word") {
      current.push(token.value);
      continue;
    }

    if (current.length === 0) return { ok: false, reason: "empty_command_segment" };
    commands.push(current);
    current = [];
  }

  if (current.length === 0 && tokens.length > 0) return { ok: false, reason: "empty_command_segment" };
  if (current.length > 0) commands.push(current);
  return { ok: true, commands };
}

function buildBashAllowlist(allowlist: readonly string[]): BashAllowlist {
  const simple = new Set<string>();
  const gitSubcommands = new Set<string>();

  for (const entry of allowlist) {
    const parts = entry.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 1) simple.add(parts[0]);
    else if (parts[0] === "git" && parts.length === 2) gitSubcommands.add(parts[1]);
  }

  return { simple, gitSubcommands };
}

function classifySimpleReadonlyCommand(words: readonly string[], allowlist: BashAllowlist): BashReadonlyClassification {
  const command = words[0];
  if (!command || command.includes("/")) return { readonly: false, reason: "unknown_command" };
  if (command === "git") return classifyGitReadonlyCommand(words, allowlist);
  if (!allowlist.simple.has(command)) return { readonly: false, reason: `command_not_allowlisted:${command}` };
  if (hasDangerousReadOption(command, words.slice(1))) return { readonly: false, reason: `dangerous_option:${command}` };
  return { readonly: true, reason: "readonly_allowlist" };
}

function classifyGitReadonlyCommand(words: readonly string[], allowlist: BashAllowlist): BashReadonlyClassification {
  let index = 1;
  while (words[index] === "-C") index += 2;
  const subcommand = words[index];
  if (!subcommand || subcommand.startsWith("-")) return { readonly: false, reason: "git_subcommand_missing" };
  if (!allowlist.gitSubcommands.has(subcommand)) return { readonly: false, reason: `git_subcommand_not_allowlisted:${subcommand}` };
  if (words.some((word) => word === "--output" || word.startsWith("--output="))) return { readonly: false, reason: "dangerous_option:git" };
  return { readonly: true, reason: "readonly_allowlist" };
}

function hasDangerousReadOption(command: string, args: readonly string[]): boolean {
  if (command === "find") return args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"].includes(arg));
  if (command === "tree") return args.some((arg) => arg === "-o" || arg === "--output");
  if (command === "tail") return args.some((arg) => arg === "-f" || arg === "--follow" || arg.startsWith("--follow="));
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
