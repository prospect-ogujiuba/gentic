import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
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
const MAX_CONFIG_BYTES = 16_384;

export const DEFAULT_PI_CONTEXT_CONFIG: EffectivePiContextConfig = Object.freeze({
  version: 1,
  pressure: DEFAULT_CONTEXT_PRESSURE_POLICY,
});

export function loadEffectiveContextConfig(
  options: LoadEffectiveContextConfigOptions = {},
): LoadEffectiveContextConfigResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.homeDir ?? homedir();
  const globalPath = join(home, CONFIG_DIR_NAME, "agent", "pi-context.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-context.json");
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
  let descriptor: number | undefined;
  try {
    const initial = lstatSync(path);
    if (initial.isSymbolicLink()) {
      diagnoseRequired(diagnostics, path, "pi-context config must not be a symlink; ignoring file");
      return undefined;
    }
    if (!initial.isFile()) {
      diagnoseRequired(diagnostics, path, "pi-context config must be a regular file; ignoring file");
      return undefined;
    }
    if (initial.size > MAX_CONFIG_BYTES) {
      diagnoseRequired(diagnostics, path, `pi-context config must not exceed ${MAX_CONFIG_BYTES} bytes; ignoring file`);
      return undefined;
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlock = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      diagnoseRequired(diagnostics, path, "pi-context config must be a regular file; ignoring file");
      return undefined;
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytes = 0;
    while (bytes <= MAX_CONFIG_BYTES) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_CONFIG_BYTES) {
      diagnoseRequired(diagnostics, path, `pi-context config must not exceed ${MAX_CONFIG_BYTES} bytes; ignoring file`);
      return undefined;
    }
    const value: unknown = JSON.parse(buffer.toString("utf8", 0, bytes));
    if (!isPlainObject(value)) {
      diagnoseRequired(diagnostics, path, "pi-context config must be a JSON object; ignoring file");
      return undefined;
    }
    if (value.version !== undefined && value.version !== 1) {
      diagnoseRequired(diagnostics, path, "unsupported version; expected version 1; ignoring file");
      return undefined;
    }
    return normalizeInput(value, diagnostics, path);
  } catch {
    diagnoseRequired(diagnostics, path, "failed to parse or safely read pi-context config; ignoring file");
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Descriptor cleanup cannot make invalid config fatal. */ }
    }
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
    if (key === "repeatCooldownMs") {
      diagnose(diagnostics, path, "pressure.repeatCooldownMs was removed because notifications are transition-only; value ignored");
    } else if (!known.has(key)) diagnose(diagnostics, path, `unknown pressure field '${key}' ignored`);
  }
  for (const field of percentFields) {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) pressure[field] = value;
    else if (value !== undefined) diagnoseRequired(diagnostics, path, `invalid 'pressure.${field}'; expected number 0..100`);
  }
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
