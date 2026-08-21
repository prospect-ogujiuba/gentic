import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mergePermissions, type Action, type Permissions } from "../domain/policy.ts";

export type Config = {
  $schema?: string;
  version?: number;
  enabled?: boolean;
  mode?: "strict" | "ask" | "permissive";
  defaultAction?: Action;
  projectTrust?: "defer" | "ask" | "allow" | "deny";
  audit?: { enabled?: boolean; path?: string; maxBytes?: number };
  permissions?: Permissions;
  literalPermissions?: Permissions;
  protectedPaths?: { read?: string[]; edit?: string[]; write?: string[] };
};

export type LoadedConfig = {
  $schema?: string;
  version: number;
  enabled: boolean;
  mode: "strict" | "ask" | "permissive";
  defaultAction: Action;
  projectTrust: "defer" | "ask" | "allow" | "deny";
  audit: { enabled: boolean; path: string; maxBytes: number };
  permissions: Permissions;
  literalPermissions: Permissions;
  protectedPaths: { read: string[]; edit: string[]; write: string[] };
};

export const SCHEMA_URL = new URL("../../pi-gate.schema.json", import.meta.url).href;
export const DEFAULT_AUDIT_PATH = ".pi/pi-gate/pi-gate-audit.jsonl";
export const LEGACY_AUDIT_PATH = ".pi/pi-gate-audit.jsonl";

let config: LoadedConfig = defaultConfig();
let configPaths: string[] = [];
let diagnostics: string[] = [];
const lastKnownGood = new Map<string, LoadedConfig>();

export function normalizeAuditPath(path: string | undefined): string | undefined {
  return path === LEGACY_AUDIT_PATH ? DEFAULT_AUDIT_PATH : path;
}

export function defaultConfig(): LoadedConfig {
  return {
    version: 3,
    enabled: true,
    mode: "ask",
    defaultAction: "ask",
    projectTrust: "defer",
    audit: { enabled: true, path: DEFAULT_AUDIT_PATH, maxBytes: 1_048_576 },
    permissions: {},
    literalPermissions: {},
    protectedPaths: { read: [], edit: [".env", ".git/"], write: [".env", ".git/"] },
  };
}

export function readConfigJson(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
}

export function globalConfigPath(): string {
  return join(process.env.HOME || "", ".pi/pi-gate/pi-gate.json");
}

export function projectConfigPathForCwd(cwd: string): string {
  return join(cwd, ".pi/pi-gate/pi-gate.json");
}

function stringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings`);
    return undefined;
  }
  return value;
}

function validate(raw: Partial<Config>, path: string): string[] {
  const errors: string[] = [];
  if (raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > 3)) errors.push("version must be an integer from 1 through 3");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push("enabled must be boolean");
  if (raw.mode !== undefined && !["strict", "ask", "permissive"].includes(raw.mode)) errors.push("mode is invalid");
  if (raw.defaultAction !== undefined && !["allow", "ask", "deny"].includes(raw.defaultAction)) errors.push("defaultAction is invalid");
  if (raw.projectTrust !== undefined && !["defer", "ask", "allow", "deny"].includes(raw.projectTrust)) errors.push("projectTrust is invalid");
  for (const [name, permissions] of [["permissions", raw.permissions], ["literalPermissions", raw.literalPermissions]] as const) {
    if (permissions === undefined) continue;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) errors.push(`${name} must be an object`);
    else for (const action of ["allow", "ask", "deny"] as const) stringArray(permissions[action], `${name}.${action}`, errors);
  }
  if (raw.audit !== undefined) {
    if (!raw.audit || typeof raw.audit !== "object" || Array.isArray(raw.audit)) errors.push("audit must be an object");
    else {
      if (raw.audit.enabled !== undefined && typeof raw.audit.enabled !== "boolean") errors.push("audit.enabled must be boolean");
      if (raw.audit.path !== undefined && typeof raw.audit.path !== "string") errors.push("audit.path must be string");
      if (raw.audit.maxBytes !== undefined && (!Number.isInteger(raw.audit.maxBytes) || raw.audit.maxBytes < 1024)) errors.push("audit.maxBytes must be an integer >= 1024");
    }
  }
  if (raw.protectedPaths !== undefined) {
    if (!raw.protectedPaths || typeof raw.protectedPaths !== "object" || Array.isArray(raw.protectedPaths)) errors.push("protectedPaths must be an object");
    else for (const tool of ["read", "edit", "write"] as const) stringArray(raw.protectedPaths[tool], `protectedPaths.${tool}`, errors);
  }
  return errors.map((error) => `${path}: ${error}`);
}

function merge(base: LoadedConfig, raw: Partial<Config>): LoadedConfig {
  return {
    ...base,
    ...raw,
    projectTrust: raw.projectTrust ?? base.projectTrust,
    audit: { ...base.audit, ...raw.audit, path: normalizeAuditPath(raw.audit?.path ?? base.audit.path) || DEFAULT_AUDIT_PATH },
    permissions: mergePermissions(base.permissions, raw.permissions || {}),
    literalPermissions: mergePermissions(base.literalPermissions, raw.literalPermissions || {}),
    protectedPaths: {
      read: raw.protectedPaths?.read ?? base.protectedPaths.read,
      edit: raw.protectedPaths?.edit ?? base.protectedPaths.edit,
      write: raw.protectedPaths?.write ?? base.protectedPaths.write,
    },
  } as LoadedConfig;
}

export function loadConfig(cwd: string, options: { includeProject?: boolean } = {}): LoadedConfig {
  const includeProject = options.includeProject !== false;
  configPaths = [process.env.PI_GATE_CONFIG, globalConfigPath(), includeProject ? projectConfigPathForCwd(cwd) : undefined].filter(Boolean) as string[];
  diagnostics = [];
  let candidate = defaultConfig();
  for (const path of configPaths) {
    let raw: Partial<Config> | undefined;
    try { raw = readConfigJson(path); }
    catch (error) { diagnostics.push(`${path}: invalid JSON: ${(error as Error).message}`); continue; }
    if (!raw) continue;
    const errors = validate(raw, path);
    diagnostics.push(...errors);
    if (errors.length === 0) candidate = merge(candidate, raw);
  }
  const key = `${cwd}:${includeProject}`;
  if (diagnostics.length > 0 && lastKnownGood.has(key)) config = lastKnownGood.get(key)!;
  else {
    config = candidate;
    if (diagnostics.length === 0) lastKnownGood.set(key, candidate);
  }
  return config;
}

export function getConfig(): LoadedConfig { return config; }
export function getConfigPaths(): string[] { return [...configPaths]; }
export function getConfigDiagnostics(): string[] { return [...diagnostics]; }
