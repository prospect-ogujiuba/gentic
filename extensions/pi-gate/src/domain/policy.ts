export type Action = "allow" | "deny" | "ask";
export type Source = "agent" | "user";
export type Remember = false | "session" | "project" | "global";
export type PermissionChoice = { k: string; label: string; action: Action; remember: Remember };
export type Permissions = Partial<Record<Action, string[]>>;
export type Rule = { id: string; pattern: string; action: Action; reason?: string; match?: "glob" | "literal" };
export type Request = { source: Source; command: string; cwd: string };
export type Decision = { action: Action; ruleId: string; reason: string };

export type PolicyConfig = {
  enabled: boolean;
  mode: "strict" | "ask" | "permissive";
  defaultAction: Action;
  permissions: Permissions;
  literalPermissions?: Permissions;
};

export const BUILTIN_PERMISSIONS: Permissions = {
  ask: ["sudo *", "doas *", "rm *", "chmod -R *", "chown -R *", "mkfs *", "dd *"],
  allow: ["ls*", "pwd", "rg*", "grep*", "git status*", "git diff*", "git log*", "git branch*", "git remote*", "git rev-parse*"],
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${escapeRegex(pattern.trim()).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}

/** Shell control syntax is never authorized by a broad allow/remember rule. */
export function hasShellControlSyntax(command: string): boolean {
  return /[\n\r;|<>`]|&&|\|\||\$\(|\$\{|[<>]\(/.test(command);
}

function destructiveRootRemoval(command: string): boolean {
  const normalized = normalizeCommand(command).replace(/["']/g, "");
  // Conservatively inspect the final rm invocation even when wrappers/options precede it.
  const rm = normalized.match(/(?:^|\s)rm\s+(.+)$/i);
  if (!rm) return false;
  const tokens = rm[1]!.split(/\s+/);
  const options = tokens.filter((token) => token.startsWith("-"));
  const operands = tokens.filter((token) => !token.startsWith("-"));
  const recursive = options.some((option) => option === "--recursive" || /^-[^-]*r/i.test(option));
  const force = options.some((option) => option === "--force" || /^-[^-]*f/i.test(option));
  return recursive && force && operands.some((operand) => operand === "/" || operand === "~" || operand === "$HOME" || operand === "${HOME}");
}

function hit(rule: Rule, req: Request): boolean {
  const command = normalizeCommand(req.command);
  return rule.match === "literal" ? command === normalizeCommand(rule.pattern) : patternRegex(rule.pattern).test(command);
}

function firstHit(rules: Rule[], req: Request, action: Action): Rule | undefined {
  return rules.find((rule) => rule.action === action && hit(rule, req));
}

export function mergePermissions(...items: Permissions[]): Permissions {
  return {
    deny: items.flatMap((item) => item.deny || []),
    ask: items.flatMap((item) => item.ask || []),
    allow: items.flatMap((item) => item.allow || []),
  };
}

export function rulesFromPermissions(permissions: Permissions, prefix = "config", match: "glob" | "literal" = "glob"): Rule[] {
  const rules: Rule[] = [];
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const pattern of permissions[action] || []) rules.push({ id: `${prefix}:${action}:${pattern}`, pattern, action, reason: `${action} permission`, match });
  }
  return rules;
}

export function decideWithConfig(req: Request, config: PolicyConfig, remembered?: Action): Decision {
  if (!config.enabled) return { action: "allow", ruleId: "disabled", reason: "pi-gate disabled" };

  const rules = [
    ...rulesFromPermissions(config.literalPermissions || {}, "literal", "literal"),
    ...rulesFromPermissions(config.permissions),
    ...rulesFromPermissions(BUILTIN_PERMISSIONS, "builtin"),
  ];
  if (destructiveRootRemoval(req.command)) return { action: "deny", ruleId: "builtin:deny:destructive-root-removal", reason: "recursive forced removal of a root/home path" };
  const deny = firstHit(rules, req, "deny");
  if (deny) return { action: "deny", ruleId: deny.id, reason: deny.reason || deny.id };
  if (config.mode === "strict") return { action: "deny", ruleId: "mode", reason: "strict mode" };
  if (hasShellControlSyntax(req.command)) return { action: "ask", ruleId: "shell:control-syntax", reason: "compound shell syntax requires explicit confirmation" };
  if (remembered) return { action: remembered, ruleId: "remember:session:literal", reason: "remembered exact command decision" };
  const rule = firstHit(rules, req, "ask") || firstHit(rules, req, "allow");
  if (rule) return { action: rule.action, ruleId: rule.id, reason: rule.reason || rule.id };
  if (config.mode === "permissive") return { action: "allow", ruleId: "mode", reason: "permissive fallback" };
  return { action: config.defaultAction, ruleId: "default", reason: "default policy" };
}
