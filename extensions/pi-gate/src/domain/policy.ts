export type Action = "allow" | "deny" | "ask";
export type Source = "agent" | "user";
export type Remember = false | "session" | "project" | "global";
export type PermissionChoice = { k: string; label: string; action: Action; remember: Remember };
export type Permissions = Partial<Record<Action, string[]>>;
export type Rule = { id: string; pattern: string; action: Action; reason?: string; timeoutSeconds?: number; defaultOnTimeout?: Action };
export type Request = { source: Source; command: string; cwd: string };
export type Decision = { action: Action; ruleId: string; reason: string; timeoutSeconds?: number; defaultOnTimeout?: Action };

export type PolicyConfig = {
  enabled: boolean;
  mode: "strict" | "ask" | "permissive";
  defaultAction: Action;
  permissions: Permissions;
};

export const BUILTIN_PERMISSIONS: Permissions = {
  deny: ["rm * -rf /", "rm * -rf ~", "rm * -rf $HOME"],
  ask: ["sudo *", "doas *", "curl * | sh", "curl * | bash", "curl * | zsh", "wget * | sh", "wget * | bash", "wget * | zsh", "rm *", "chmod -R *", "chown -R *", "mkfs *", "dd *"],
  allow: ["ls*", "pwd", "rg*", "grep*", "git status*", "git diff*", "git log*", "git branch*", "git remote*", "git rev-parse*"],
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${escapeRegex(pattern.trim()).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function hit(rule: Rule, req: Request): boolean {
  return patternRegex(rule.pattern).test(normalizeCommand(req.command));
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

export function rulesFromPermissions(permissions: Permissions, prefix = "config"): Rule[] {
  const rules: Rule[] = [];
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const pattern of permissions[action] || []) rules.push({ id: `${prefix}:${action}:${pattern}`, pattern, action, reason: `${action} permission` });
  }
  return rules;
}

export function decideWithConfig(req: Request, config: PolicyConfig, remembered?: Action): Decision {
  if (!config.enabled) return { action: "allow", ruleId: "disabled", reason: "pi-gate disabled" };
  if (config.mode === "permissive") return { action: "allow", ruleId: "mode", reason: "permissive mode" };
  if (config.mode === "strict") return { action: "deny", ruleId: "mode", reason: "strict mode" };
  const all = [...rulesFromPermissions(config.permissions), ...rulesFromPermissions(BUILTIN_PERMISSIONS, "builtin")];
  const deny = firstHit(all, req, "deny");
  if (deny) return { action: deny.action, ruleId: deny.id, reason: deny.reason || deny.id, timeoutSeconds: deny.timeoutSeconds, defaultOnTimeout: deny.defaultOnTimeout };
  if (remembered) return { action: remembered, ruleId: "remember:session", reason: "remembered decision" };
  const rule = firstHit(all, req, "ask") || firstHit(all, req, "allow");
  if (rule) return { action: rule.action, ruleId: rule.id, reason: rule.reason || rule.id, timeoutSeconds: rule.timeoutSeconds, defaultOnTimeout: rule.defaultOnTimeout };
  return { action: config.defaultAction, ruleId: "default", reason: "default policy" };
}
