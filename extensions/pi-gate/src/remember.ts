import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { globalConfigPath, loadConfig, projectConfigPathForCwd, readConfigJson, SCHEMA_URL, type Config } from "./config.ts";
import { normalizeCommand, type Action } from "./policy.ts";

const sessionMemory = new Map<string, Action>();

export function getSessionDecision(command: string): Action | undefined {
  return sessionMemory.get(normalizeCommand(command));
}

export function rememberSessionDecision(command: string, action: Action): void {
  sessionMemory.set(normalizeCommand(command), action);
}

export function projectConfigPath(ctx: ExtensionContext): string {
  return projectConfigPathForCwd(ctx.cwd);
}

export function persistRule(ctx: ExtensionContext, path: string, pattern: string, action: Action): void {
  const existing = readConfigJson(path) || {};
  const permissions = existing.permissions || {};
  const current = permissions[action] || [];
  const next = {
    $schema: existing.$schema || SCHEMA_URL,
    version: existing.version || 2,
    enabled: existing.enabled ?? true,
    mode: existing.mode || "ask",
    defaultAction: existing.defaultAction || "ask",
    audit: {
      enabled: existing.audit?.enabled ?? true,
      path: existing.audit?.path || ".pi/pi-gate/pi-gate-audit.jsonl",
    },
    permissions: {
      allow: permissions.allow || [],
      ask: permissions.ask || [],
      deny: permissions.deny || [],
      [action]: current.includes(pattern) ? current : [...current, pattern],
    },
  } satisfies Config;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  loadConfig(ctx.cwd);
  ctx.ui.notify(`pi-gate saved ${action} rule to ${path}`, "success");
}

export function persistGlobalRule(ctx: ExtensionContext, command: string, action: Action): void {
  persistRule(ctx, globalConfigPath(), normalizeCommand(command), action);
}

export function persistProjectRule(ctx: ExtensionContext, command: string, action: Action): void {
  persistRule(ctx, projectConfigPath(ctx), normalizeCommand(command), action);
}
