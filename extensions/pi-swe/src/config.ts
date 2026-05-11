import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PiSweMode = "off" | "advisory" | "enforced";

export type PiSweStageCheckName = "plan" | "read" | "verification" | "scope";

export type PiSweStageCheckConfig = {
  enabled: boolean;
  mode: "advisory";
};

export type PiSweConfig = {
  $schema?: string;
  version?: number;
  enabled?: boolean;
  mode?: PiSweMode;
  stages?: Record<string, Record<string, unknown>>;
};

export type EffectivePiSweConfig = Required<Omit<PiSweConfig, "$schema">>;

export type PiSweConfigDiagnostic = {
  path: string;
  message: string;
};

export type LoadEffectiveSweConfigOptions = {
  cwd?: string;
  homeDir?: string;
};

export type LoadEffectiveSweConfigResult = {
  config: EffectivePiSweConfig;
  diagnostics: PiSweConfigDiagnostic[];
  paths: {
    global: string;
    project: string;
  };
};

const DEFAULT_CHECK: PiSweStageCheckConfig = Object.freeze({ enabled: true, mode: "advisory" });

export const DEFAULT_PI_SWE_CHECKS: Readonly<Record<PiSweStageCheckName, PiSweStageCheckConfig>> = Object.freeze({
  plan: DEFAULT_CHECK,
  read: DEFAULT_CHECK,
  verification: DEFAULT_CHECK,
  scope: DEFAULT_CHECK,
});

export const DEFAULT_PI_SWE_CONFIG: Readonly<EffectivePiSweConfig> = Object.freeze({
  version: 1,
  enabled: true,
  mode: "advisory",
  stages: DEFAULT_PI_SWE_CHECKS,
});

export function loadEffectiveSweConfig(options: LoadEffectiveSweConfigOptions = {}): LoadEffectiveSweConfigResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.homeDir ?? homedir();
  const globalPath = join(home, ".pi", "agent", "pi-swe.json");
  const projectPath = join(cwd, ".pi", "pi-swe.json");
  const diagnostics: PiSweConfigDiagnostic[] = [];

  const globalConfig = readConfigFile(globalPath, diagnostics);
  const projectConfig = readConfigFile(projectPath, diagnostics);
  const merged = mergeConfig(DEFAULT_PI_SWE_CONFIG, globalConfig, projectConfig);
  const config = normalizeConfig(merged, diagnostics, "effective config");

  return { config, diagnostics, paths: { global: globalPath, project: projectPath } };
}

function readConfigFile(path: string, diagnostics: PiSweConfigDiagnostic[]): PiSweConfig | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) {
      diagnostics.push({ path, message: "pi-swe config must be a JSON object; ignoring file" });
      return undefined;
    }
    return normalizeConfigInput(parsed, diagnostics, path);
  } catch (error) {
    diagnostics.push({ path, message: `failed to parse pi-swe config: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function mergeConfig(...configs: Array<PiSweConfig | EffectivePiSweConfig | undefined>): PiSweConfig {
  const merged: PiSweConfig = {};

  for (const config of configs) {
    if (!config) continue;
    if (config.$schema !== undefined) merged.$schema = config.$schema;
    if (config.version !== undefined) merged.version = config.version;
    if (config.enabled !== undefined) merged.enabled = config.enabled;
    if (config.mode !== undefined) merged.mode = config.mode;
    if (config.stages !== undefined) merged.stages = { ...(merged.stages ?? {}), ...config.stages };
  }

  return merged;
}

function normalizeConfigInput(input: Record<string, unknown>, diagnostics: PiSweConfigDiagnostic[], path: string): PiSweConfig {
  const normalized: PiSweConfig = {};
  const known = new Set(["$schema", "version", "enabled", "mode", "stages"]);

  for (const key of Object.keys(input)) {
    if (!known.has(key)) diagnostics.push({ path, message: `unknown pi-swe config field '${key}' ignored` });
  }

  if (typeof input.$schema === "string") normalized.$schema = input.$schema;
  else if (input.$schema !== undefined) diagnostics.push({ path, message: "invalid '$schema'; expected string" });

  if (Number.isInteger(input.version) && Number(input.version) >= 1) normalized.version = Number(input.version);
  else if (input.version !== undefined) diagnostics.push({ path, message: "invalid 'version'; expected integer >= 1" });

  if (typeof input.enabled === "boolean") normalized.enabled = input.enabled;
  else if (input.enabled !== undefined) diagnostics.push({ path, message: "invalid 'enabled'; expected boolean" });

  if (input.mode === "off" || input.mode === "advisory" || input.mode === "enforced") normalized.mode = input.mode;
  else if (input.mode !== undefined) diagnostics.push({ path, message: "invalid 'mode'; expected off, advisory, or enforced" });

  if (isPlainObject(input.stages)) normalized.stages = normalizeStages(input.stages as Record<string, unknown>, diagnostics, path);
  else if (input.stages !== undefined) diagnostics.push({ path, message: "invalid 'stages'; expected object" });

  return normalized;
}

function normalizeConfig(config: PiSweConfig, diagnostics: PiSweConfigDiagnostic[], path: string): EffectivePiSweConfig {
  const normalized = normalizeConfigInput(config as Record<string, unknown>, diagnostics, path);

  return {
    version: normalized.version ?? DEFAULT_PI_SWE_CONFIG.version,
    enabled: normalized.enabled ?? DEFAULT_PI_SWE_CONFIG.enabled,
    mode: normalized.mode ?? DEFAULT_PI_SWE_CONFIG.mode,
    stages: { ...DEFAULT_PI_SWE_CONFIG.stages, ...(normalized.stages ?? {}) },
  };
}

function normalizeStages(stages: Record<string, unknown>, diagnostics: PiSweConfigDiagnostic[], path: string): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {};

  for (const [name, value] of Object.entries(stages)) {
    if (!isPlainObject(value)) {
      diagnostics.push({ path, message: `invalid stages.${name}; expected object` });
      continue;
    }
    normalized[name] = { ...(value as Record<string, unknown>) };
  }

  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
