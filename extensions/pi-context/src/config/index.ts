import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  type ContextPressurePolicy,
} from "../domain/index.ts";

export type PiContextPressureConfig = {
  warningPercent?: number;
  criticalPercent?: number;
  hysteresisPercent?: number;
  repeatCooldownMs?: number;
};

export type PiContextConfig = {
  $schema?: string;
  version?: number;
  pressure?: PiContextPressureConfig;
};

export type EffectivePiContextConfig = Readonly<{
  version: 1;
  pressure: ContextPressurePolicy;
}>;

export type PiContextConfigDiagnostic = {
  path: string;
  message: string;
};

export type LoadEffectiveContextConfigOptions = {
  cwd?: string;
  homeDir?: string;
};

export type LoadEffectiveContextConfigResult = {
  config: EffectivePiContextConfig;
  diagnostics: PiContextConfigDiagnostic[];
  paths: { global: string; project: string };
};

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 240;

export const DEFAULT_PI_CONTEXT_CONFIG: EffectivePiContextConfig = Object.freeze({
  version: 1,
  pressure: DEFAULT_CONTEXT_PRESSURE_POLICY,
});

export function loadEffectiveContextConfig(
  options: LoadEffectiveContextConfigOptions = {},
): LoadEffectiveContextConfigResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.homeDir ?? homedir();
  const globalPath = join(home, ".pi", "agent", "pi-context.json");
  const projectPath = join(cwd, ".pi", "pi-context.json");
  const diagnostics: PiContextConfigDiagnostic[] = [];
  const globalConfig = readConfigFile(globalPath, diagnostics);
  const projectConfig = readConfigFile(projectPath, diagnostics);
  const pressure = {
    ...DEFAULT_CONTEXT_PRESSURE_POLICY,
    ...(globalConfig?.pressure ?? {}),
    ...(projectConfig?.pressure ?? {}),
  };

  const config = isValidPolicy(pressure)
    ? Object.freeze({ version: 1 as const, pressure: Object.freeze(pressure) })
    : invalidPolicyFallback(diagnostics);

  return { config, diagnostics, paths: { global: globalPath, project: projectPath } };
}

function readConfigFile(path: string, diagnostics: PiContextConfigDiagnostic[]): PiContextConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(value)) {
      diagnoseRequired(diagnostics, path, "pi-context config must be a JSON object; ignoring file");
      return undefined;
    }
    if (value.version !== undefined && value.version !== 1) {
      diagnoseRequired(diagnostics, path, "unsupported version; expected version 1; ignoring file");
      return undefined;
    }
    return normalizeInput(value, diagnostics, path);
  } catch (error) {
    diagnoseRequired(diagnostics, path, `failed to parse pi-context config: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function normalizeInput(
  input: Record<string, unknown>,
  diagnostics: PiContextConfigDiagnostic[],
  path: string,
): PiContextConfig {
  const config: PiContextConfig = { version: 1 };
  for (const key of Object.keys(input)) {
    if (key !== "$schema" && key !== "version" && key !== "pressure") {
      diagnose(diagnostics, path, `unknown pi-context config field '${key}' ignored`);
    }
  }
  if (typeof input.$schema === "string") config.$schema = input.$schema;
  else if (input.$schema !== undefined) diagnoseRequired(diagnostics, path, "invalid '$schema'; expected string");

  if (input.pressure === undefined) return config;
  if (!isPlainObject(input.pressure)) {
    diagnoseRequired(diagnostics, path, "invalid 'pressure'; expected object");
    return config;
  }
  config.pressure = normalizePressure(input.pressure, diagnostics, path);
  return config;
}

function normalizePressure(
  input: Record<string, unknown>,
  diagnostics: PiContextConfigDiagnostic[],
  path: string,
): PiContextPressureConfig {
  const pressure: PiContextPressureConfig = {};
  const percentFields = ["warningPercent", "criticalPercent", "hysteresisPercent"] as const;
  const known = new Set([...percentFields, "repeatCooldownMs"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) diagnose(diagnostics, path, `unknown pressure field '${key}' ignored`);
  }
  for (const field of percentFields) {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) pressure[field] = value;
    else if (value !== undefined) diagnoseRequired(diagnostics, path, `invalid 'pressure.${field}'; expected number 0..100`);
  }
  const cooldown = input.repeatCooldownMs;
  if (Number.isInteger(cooldown) && Number(cooldown) >= 0) pressure.repeatCooldownMs = Number(cooldown);
  else if (cooldown !== undefined) diagnoseRequired(diagnostics, path, "invalid 'pressure.repeatCooldownMs'; expected integer >= 0");
  return pressure;
}

function isValidPolicy(policy: ContextPressurePolicy): boolean {
  return policy.criticalPercent > 0 &&
    policy.criticalPercent < policy.warningPercent &&
    policy.warningPercent < 100 &&
    policy.hysteresisPercent >= 0 &&
    policy.criticalPercent + policy.hysteresisPercent < policy.warningPercent &&
    policy.warningPercent + policy.hysteresisPercent <= 100;
}

function invalidPolicyFallback(diagnostics: PiContextConfigDiagnostic[]): EffectivePiContextConfig {
  diagnoseRequired(
    diagnostics,
    "effective config",
    "invalid pressure threshold ordering; expected 0 < critical < critical+hysteresis < warning and warning+hysteresis <= 100; using defaults",
  );
  return DEFAULT_PI_CONTEXT_CONFIG;
}

function diagnose(diagnostics: PiContextConfigDiagnostic[], path: string, message: string): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) return;
  diagnostics.push(createDiagnostic(path, message));
}

function diagnoseRequired(diagnostics: PiContextConfigDiagnostic[], path: string, message: string): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) {
    const unknownIndex = diagnostics.findLastIndex((diagnostic) => diagnostic.message.startsWith("unknown "));
    if (unknownIndex < 0) return;
    diagnostics.splice(unknownIndex, 1);
  }
  diagnostics.push(createDiagnostic(path, message));
}

function createDiagnostic(path: string, message: string): PiContextConfigDiagnostic {
  return {
    path: path.slice(0, MAX_DIAGNOSTIC_LENGTH),
    message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
