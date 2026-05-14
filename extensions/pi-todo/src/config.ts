import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PiTodoConfig = {
  $schema?: string;
  version?: number;
  docket?: {
    showCompletedFocus?: boolean;
  };
};

export type EffectivePiTodoConfig = {
  version: number;
  docket: {
    showCompletedFocus: boolean;
  };
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
});

export function loadEffectiveTodoConfig(options: LoadEffectiveTodoConfigOptions = {}): LoadEffectiveTodoConfigResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.homeDir ?? homedir();
  const globalPath = join(home, ".pi", "agent", "pi-todo.json");
  const projectPath = join(cwd, ".pi", "pi-todo.json");
  const diagnostics: PiTodoConfigDiagnostic[] = [];

  const globalConfig = readConfigFile(globalPath, diagnostics);
  const projectConfig = readConfigFile(projectPath, diagnostics);
  const config = normalizeConfig(mergeConfig(DEFAULT_PI_TODO_CONFIG, globalConfig, projectConfig), diagnostics, "effective config");

  return { config, diagnostics, paths: { global: globalPath, project: projectPath } };
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
  }

  return merged;
}

function normalizeConfigInput(input: Record<string, unknown>, diagnostics: PiTodoConfigDiagnostic[], path: string): PiTodoConfig {
  const normalized: PiTodoConfig = {};
  const known = new Set(["$schema", "version", "docket"]);

  for (const key of Object.keys(input)) {
    if (!known.has(key)) diagnostics.push({ path, message: `unknown pi-todo config field '${key}' ignored` });
  }

  if (typeof input.$schema === "string") normalized.$schema = input.$schema;
  else if (input.$schema !== undefined) diagnostics.push({ path, message: "invalid '$schema'; expected string" });

  if (Number.isInteger(input.version) && Number(input.version) >= 1) normalized.version = Number(input.version);
  else if (input.version !== undefined) diagnostics.push({ path, message: "invalid 'version'; expected integer >= 1" });

  if (isPlainObject(input.docket)) normalized.docket = normalizeDocket(input.docket as Record<string, unknown>, diagnostics, path);
  else if (input.docket !== undefined) diagnostics.push({ path, message: "invalid 'docket'; expected object" });

  return normalized;
}

function normalizeConfig(config: PiTodoConfig, diagnostics: PiTodoConfigDiagnostic[], path: string): EffectivePiTodoConfig {
  const normalized = normalizeConfigInput(config as Record<string, unknown>, diagnostics, path);

  return {
    version: normalized.version ?? DEFAULT_PI_TODO_CONFIG.version,
    docket: { ...DEFAULT_PI_TODO_CONFIG.docket, ...(normalized.docket ?? {}) },
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
