import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { mergePermissions, type Action, type Permissions } from "../domain/policy.ts";

export type Config = {
  $schema?: string;
  version?: number;
  enabled?: boolean;
  mode?: "strict" | "ask" | "permissive";
  defaultAction?: Action;
  audit?: { enabled?: boolean; path?: string };
  permissions?: Permissions;
};

export type LoadedConfig = Required<Omit<Config, "$schema">> & Pick<Config, "$schema">;

export const SCHEMA_URL = new URL("../../pi-gate.schema.json", import.meta.url).href;

let config: LoadedConfig = defaultConfig();
let configPaths: string[] = [];

export function defaultConfig(): LoadedConfig {
  return { version: 2, enabled: true, mode: "ask", defaultAction: "ask", audit: { enabled: true, path: ".pi/pi-gate/pi-gate-audit.jsonl" }, permissions: {} };
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

export function loadConfig(cwd: string): LoadedConfig {
  configPaths = [process.env.PI_GATE_CONFIG, globalConfigPath(), projectConfigPathForCwd(cwd)].filter(Boolean) as string[];
  config = defaultConfig();
  for (const p of configPaths) {
    const raw = readConfigJson(p);
    if (!raw) continue;
    config = { ...config, ...raw, audit: { ...config.audit, ...raw.audit }, permissions: mergePermissions(config.permissions, raw.permissions || {}) };
  }
  return config;
}

export function getConfig(): LoadedConfig {
  return config;
}

export function getConfigPaths(): string[] {
  return [...configPaths];
}
