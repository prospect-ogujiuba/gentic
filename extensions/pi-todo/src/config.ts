import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_BASH_READONLY_ALLOWLIST, type ToolPolicyAction, type ToolPolicyConfig, type ToolPolicyRule } from "./domain/policy.ts";

export type PiTodoConfig = {
  $schema?: string;
  version?: number;
  docket?: {
    showCompletedFocus?: boolean;
  };
  enforcement?: {
    defaultAction?: ToolPolicyAction;
    rules?: ToolPolicyRule[];
    bashReadonlyAllowlist?: string[];
  };
};

export type EffectivePiTodoConfig = {
  version: number;
  docket: {
    showCompletedFocus: boolean;
  };
  enforcement: ToolPolicyConfig;
};

export type PiTodoConfigDiagnostic = {
  path: string;
  message: string;
};

export type LoadEffectiveTodoConfigOptions = {
  cwd?: string;
  homeDir?: string;
};

export type LoadEffectiveTodoConfigResult = {
  config: EffectivePiTodoConfig;
  diagnostics: PiTodoConfigDiagnostic[];
  paths: {
    global: string;
    project: string;
  };
};

export const DEFAULT_PI_TODO_CONFIG: Readonly<EffectivePiTodoConfig> = Object.freeze({
  version: 1,
  docket: Object.freeze({ showCompletedFocus: true }),
  enforcement: Object.freeze({
    defaultAction: "requireTodo",
    rules: Object.freeze([]),
    bashReadonlyAllowlist: DEFAULT_BASH_READONLY_ALLOWLIST,
  }),
});

export function loadEffectiveTodoConfig(options: LoadEffectiveTodoConfigOptions = {}): LoadEffectiveTodoConfigResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.homeDir ?? homedir();
  const globalPath = join(home, ".pi", "agent", "pi-todo.json");
  const projectPath = join(cwd, ".pi", "pi-todo.json");
  const diagnostics: PiTodoConfigDiagnostic[] = [];

  const globalConfig = readConfigFile(globalPath, diagnostics);
  const projectConfig = readConfigFile(projectPath, diagnostics);
  const config = applyEnforcementDiagnosticFallback(
    normalizeConfig(mergeConfig(DEFAULT_PI_TODO_CONFIG, globalConfig, projectConfig), diagnostics, "effective config"),
    diagnostics,
  );

  return { config, diagnostics, paths: { global: globalPath, project: projectPath } };
}

function applyEnforcementDiagnosticFallback(config: EffectivePiTodoConfig, diagnostics: PiTodoConfigDiagnostic[]): EffectivePiTodoConfig {
  if (config.enforcement.defaultAction !== "allow" || !diagnostics.some(isInvalidEnforcementDiagnostic)) return config;

  diagnostics.push({
    path: "effective config",
    message: "invalid enforcement config with defaultAction 'allow'; defaultAction forced to 'requireTodo' to avoid silently allowing tools",
  });
  return { ...config, enforcement: { ...config.enforcement, defaultAction: "requireTodo" } };
}

function isInvalidEnforcementDiagnostic(diagnostic: PiTodoConfigDiagnostic): boolean {
  return diagnostic.message.startsWith("invalid 'enforcement");
}

function readConfigFile(path: string, diagnostics: PiTodoConfigDiagnostic[]): PiTodoConfig | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) {
      diagnostics.push({ path, message: "pi-todo config must be a JSON object; ignoring file" });
      return undefined;
    }
    return normalizeConfigInput(parsed, diagnostics, path);
  } catch (error) {
    diagnostics.push({ path, message: `failed to parse pi-todo config: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function mergeConfig(...configs: Array<PiTodoConfig | EffectivePiTodoConfig | undefined>): PiTodoConfig {
  const merged: PiTodoConfig = {};

  for (const config of configs) {
    if (!config) continue;
    if (config.$schema !== undefined) merged.$schema = config.$schema;
    if (config.version !== undefined) merged.version = config.version;
    if (config.docket !== undefined) merged.docket = { ...(merged.docket ?? {}), ...config.docket };
    if (config.enforcement !== undefined) merged.enforcement = { ...(merged.enforcement ?? {}), ...config.enforcement };
  }

  return merged;
}

function normalizeConfigInput(input: Record<string, unknown>, diagnostics: PiTodoConfigDiagnostic[], path: string): PiTodoConfig {
  const normalized: PiTodoConfig = {};
  const known = new Set(["$schema", "version", "docket", "enforcement"]);

  for (const key of Object.keys(input)) {
    if (!known.has(key)) diagnostics.push({ path, message: `unknown pi-todo config field '${key}' ignored` });
  }

  if (typeof input.$schema === "string") normalized.$schema = input.$schema;
  else if (input.$schema !== undefined) diagnostics.push({ path, message: "invalid '$schema'; expected string" });

  if (Number.isInteger(input.version) && Number(input.version) >= 1) normalized.version = Number(input.version);
  else if (input.version !== undefined) diagnostics.push({ path, message: "invalid 'version'; expected integer >= 1" });

  if (isPlainObject(input.docket)) normalized.docket = normalizeDocket(input.docket as Record<string, unknown>, diagnostics, path);
  else if (input.docket !== undefined) diagnostics.push({ path, message: "invalid 'docket'; expected object" });

  if (isPlainObject(input.enforcement)) normalized.enforcement = normalizeEnforcement(input.enforcement as Record<string, unknown>, diagnostics, path);
  else if (input.enforcement !== undefined) diagnostics.push({ path, message: "invalid 'enforcement'; expected object" });

  return normalized;
}

function normalizeConfig(config: PiTodoConfig, diagnostics: PiTodoConfigDiagnostic[], path: string): EffectivePiTodoConfig {
  const normalized = normalizeConfigInput(config as Record<string, unknown>, diagnostics, path);

  return {
    version: normalized.version ?? DEFAULT_PI_TODO_CONFIG.version,
    docket: { ...DEFAULT_PI_TODO_CONFIG.docket, ...(normalized.docket ?? {}) },
    enforcement: {
      ...DEFAULT_PI_TODO_CONFIG.enforcement,
      ...(normalized.enforcement ?? {}),
      rules: normalized.enforcement?.rules ?? DEFAULT_PI_TODO_CONFIG.enforcement.rules,
      bashReadonlyAllowlist: normalized.enforcement?.bashReadonlyAllowlist ?? DEFAULT_PI_TODO_CONFIG.enforcement.bashReadonlyAllowlist,
    },
  };
}

function normalizeDocket(docket: Record<string, unknown>, diagnostics: PiTodoConfigDiagnostic[], path: string): { showCompletedFocus?: boolean } {
  const normalized: { showCompletedFocus?: boolean } = {};

  for (const key of Object.keys(docket)) {
    if (key !== "showCompletedFocus") diagnostics.push({ path, message: `unknown docket field '${key}' ignored` });
  }

  if (typeof docket.showCompletedFocus === "boolean") normalized.showCompletedFocus = docket.showCompletedFocus;
  else if (docket.showCompletedFocus !== undefined) diagnostics.push({ path, message: "invalid 'docket.showCompletedFocus'; expected boolean" });

  return normalized;
}

function normalizeEnforcement(enforcement: Record<string, unknown>, diagnostics: PiTodoConfigDiagnostic[], path: string): PiTodoConfig["enforcement"] {
  const normalized: PiTodoConfig["enforcement"] = {};

  for (const key of Object.keys(enforcement)) {
    if (key !== "defaultAction" && key !== "rules" && key !== "bashReadonlyAllowlist") diagnostics.push({ path, message: `unknown enforcement field '${key}' ignored` });
  }

  if (isToolPolicyAction(enforcement.defaultAction)) normalized.defaultAction = enforcement.defaultAction;
  else if (enforcement.defaultAction !== undefined) diagnostics.push({ path, message: "invalid 'enforcement.defaultAction'; expected 'allow' or 'requireTodo'" });

  if (Array.isArray(enforcement.rules)) normalized.rules = normalizeEnforcementRules(enforcement.rules, diagnostics, path);
  else if (enforcement.rules !== undefined) diagnostics.push({ path, message: "invalid 'enforcement.rules'; expected array" });

  if (Array.isArray(enforcement.bashReadonlyAllowlist)) normalized.bashReadonlyAllowlist = normalizeStringArray(enforcement.bashReadonlyAllowlist, diagnostics, path, "enforcement.bashReadonlyAllowlist");
  else if (enforcement.bashReadonlyAllowlist !== undefined) diagnostics.push({ path, message: "invalid 'enforcement.bashReadonlyAllowlist'; expected array" });

  return normalized;
}

function normalizeEnforcementRules(rules: unknown[], diagnostics: PiTodoConfigDiagnostic[], path: string): ToolPolicyRule[] {
  const normalized: ToolPolicyRule[] = [];

  for (const [index, rule] of rules.entries()) {
    if (!isPlainObject(rule)) {
      diagnostics.push({ path, message: `invalid 'enforcement.rules[${index}]'; expected object` });
      continue;
    }

    for (const key of Object.keys(rule)) {
      if (key !== "pattern" && key !== "action") diagnostics.push({ path, message: `unknown enforcement.rules[${index}] field '${key}' ignored` });
    }

    if (typeof rule.pattern !== "string" || rule.pattern.trim() === "") {
      diagnostics.push({ path, message: `invalid 'enforcement.rules[${index}].pattern'; expected non-empty string` });
      continue;
    }

    if (!isToolPolicyAction(rule.action)) {
      diagnostics.push({ path, message: `invalid 'enforcement.rules[${index}].action'; expected 'allow' or 'requireTodo'` });
      continue;
    }

    normalized.push({ pattern: rule.pattern, action: rule.action });
  }

  return normalized;
}

function normalizeStringArray(values: unknown[], diagnostics: PiTodoConfigDiagnostic[], path: string, field: string): string[] {
  const normalized: string[] = [];

  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.trim() === "") {
      diagnostics.push({ path, message: `invalid '${field}[${index}]'; expected non-empty string` });
      continue;
    }
    normalized.push(value.trim());
  }

  return normalized;
}

function isToolPolicyAction(value: unknown): value is ToolPolicyAction {
  return value === "allow" || value === "requireTodo";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
