import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_AUDIT_PATH, globalConfigPath, loadConfig, normalizeAuditPath, projectConfigPathForCwd, readConfigJson, SCHEMA_URL, type Config } from "../config/index.ts";
import { normalizeCommand, type Action } from "../domain/policy.ts";

const sessionMemory = new Map<string, Action>();

export function getSessionDecision(command: string): Action | undefined {
  return sessionMemory.get(normalizeCommand(command));
}

export function rememberSessionDecision(command: string, action: Action): void {
  sessionMemory.set(normalizeCommand(command), action);
}

export function clearSessionDecisions(): void { sessionMemory.clear(); }

export function projectConfigPath(ctx: ExtensionContext): string {
  return projectConfigPathForCwd(ctx.cwd);
}

/** Persist remembered commands as exact literals, never as shell globs. */
export function persistRule(ctx: ExtensionContext, path: string, pattern: string, action: Action): void {
  const existing = readConfigJson(path) || {};
  const literalPermissions = existing.literalPermissions || {};
  const current = literalPermissions[action] || [];
  const literal = normalizeCommand(pattern);
  const next = {
    ...existing,
    $schema: existing.$schema || SCHEMA_URL,
    version: 3,
    enabled: existing.enabled ?? true,
    mode: existing.mode || "ask",
    defaultAction: existing.defaultAction || "ask",
    audit: {
      enabled: existing.audit?.enabled ?? true,
      path: normalizeAuditPath(existing.audit?.path) || DEFAULT_AUDIT_PATH,
      maxBytes: existing.audit?.maxBytes ?? 1_048_576,
    },
    permissions: existing.permissions || {},
    literalPermissions: {
      allow: literalPermissions.allow || [],
      ask: literalPermissions.ask || [],
      deny: literalPermissions.deny || [],
      [action]: current.includes(literal) ? current : [...current, literal],
    },
  } satisfies Config;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  loadConfig(ctx.cwd);
  ctx.ui.notify(`pi-gate saved exact ${action} rule to ${path}`, "info");
}

export function persistGlobalRule(ctx: ExtensionContext, command: string, action: Action): void {
  persistRule(ctx, globalConfigPath(), command, action);
}

export function persistProjectRule(ctx: ExtensionContext, command: string, action: Action): void {
  persistRule(ctx, projectConfigPath(ctx), command, action);
}
