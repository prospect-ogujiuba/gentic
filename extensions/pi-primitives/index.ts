import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type PrimitiveContext = {
  name: string;
  dir: string;
  path(path: string): string;
  readText(path: string): string;
};
export type Primitive = (pi: ExtensionAPI, ctx: PrimitiveContext) => void | Promise<void>;
export type PrimitiveLoadReport = { loaded: string[]; skipped: string[]; failures: Array<{ name: string; error: string }> };

type PrimitiveConfig = { enabled?: boolean; disabled?: string[] };
const ROOT = new URL(".", import.meta.url).pathname;
const PRIMITIVES_DIR = join(ROOT, "primitives");
const CONFIG_PATH = join(ROOT, "config.json");

function primitivePath(dir: string, path: string): string {
  const resolved = resolve(dir, path);
  const rel = relative(dir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Primitive path escapes primitive directory: ${path}`);
  return resolved;
}

function readConfig(report: PrimitiveLoadReport, configPath: string): PrimitiveConfig {
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as PrimitiveConfig;
    if (config.disabled !== undefined && (!Array.isArray(config.disabled) || config.disabled.some((name) => typeof name !== "string"))) {
      throw new Error("disabled must be an array of primitive names");
    }
    return config;
  } catch (error) {
    report.failures.push({ name: "config", error: error instanceof Error ? error.message : String(error) });
    return {};
  }
}

async function loadPrimitive(pi: ExtensionAPI, primitivesDir: string, name: string): Promise<boolean> {
  const dir = join(primitivesDir, name);
  const entrypoint = join(dir, "index.ts");
  if (!existsSync(entrypoint)) return false;
  const mod = (await import(`${pathToFileURL(entrypoint).href}?gentic=${Date.now()}-${encodeURIComponent(name)}`)) as { default?: Primitive };
  if (typeof mod.default !== "function") throw new Error("default export must be a primitive function");
  await mod.default(pi, {
    name,
    dir,
    path(path) { return primitivePath(dir, path); },
    readText(path) { return readFileSync(primitivePath(dir, path), "utf8"); },
  });
  return true;
}

export async function loadPrimitives(
  pi: ExtensionAPI,
  options: { primitivesDir?: string; configPath?: string } = {},
): Promise<PrimitiveLoadReport> {
  const primitivesDir = options.primitivesDir ?? PRIMITIVES_DIR;
  const report: PrimitiveLoadReport = { loaded: [], skipped: [], failures: [] };
  const config = readConfig(report, options.configPath ?? CONFIG_PATH);
  if (!existsSync(primitivesDir) || config.enabled === false) return report;
  const disabled = new Set(config.disabled ?? []);
  const primitiveNames = readdirSync(primitivesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const name of primitiveNames) {
    if (disabled.has(name)) {
      report.skipped.push(name);
      continue;
    }
    try {
      if (await loadPrimitive(pi, primitivesDir, name)) report.loaded.push(name);
      else report.skipped.push(name);
    } catch (error) {
      report.failures.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export default async function piPrimitives(pi: ExtensionAPI): Promise<void> {
  const report = await loadPrimitives(pi);
  pi.on("session_start", (_event, ctx) => {
    const summary = `${report.loaded.length} loaded${report.skipped.length ? `, ${report.skipped.length} disabled` : ""}${report.failures.length ? `, ${report.failures.length} failed` : ""}`;
    ctx.ui.setStatus("pi-primitives", summary);
    if (report.failures.length) ctx.ui.notify(`Primitive load failures:\n${report.failures.map((failure) => `- ${failure.name}: ${failure.error}`).join("\n")}`, "warning");
  });
}
