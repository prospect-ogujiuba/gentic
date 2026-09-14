import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import conciseOutput from "./primitives/concise-output/index.ts";
import implementationFileCompletion from "./primitives/implementation-file-completion/index.ts";
import modelArtifacts from "./primitives/model-artifacts/index.ts";
import whimsical from "./primitives/whimsical/index.ts";

export type PrimitiveContext = {
  name: string;
  dir: string;
  path(path: string): string;
  readText(path: string): string;
};
export type Primitive = (pi: ExtensionAPI, ctx: PrimitiveContext) => void | Promise<void>;
export type PrimitiveDefinition = { name: string; dir: string; register: Primitive };
export type PrimitiveRegistrationReport = { loaded: string[]; skipped: string[]; failures: Array<{ name: string; error: string }> };

type PrimitiveConfig = { enabled?: boolean; disabled?: string[] };
const MAX_CONFIG_BYTES = 16384;
const MAX_DIAGNOSTIC_LENGTH = 512;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PRIMITIVES_DIR = join(ROOT, "primitives");
const CONFIG_PATH = join(ROOT, "config.json");
const EXPLICIT_PRIMITIVES: readonly PrimitiveDefinition[] = [
  { name: "concise-output", dir: join(PRIMITIVES_DIR, "concise-output"), register: conciseOutput },
  { name: "implementation-file-completion", dir: join(PRIMITIVES_DIR, "implementation-file-completion"), register: implementationFileCompletion },
  { name: "model-artifacts", dir: join(PRIMITIVES_DIR, "model-artifacts"), register: modelArtifacts },
  { name: "whimsical", dir: join(PRIMITIVES_DIR, "whimsical"), register: whimsical },
];

function isContained(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function primitivePath(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (!isContained(root, resolved)) throw new Error(`Primitive path escapes primitive directory: ${path}`);

  let existing = resolved;
  while (!pathEntryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let canonicalExisting: string;
  try { canonicalExisting = realpathSync(existing); }
  catch { throw new Error(`Primitive path cannot be resolved within primitive directory: ${path}`); }
  if (!isContained(root, canonicalExisting)) throw new Error(`Primitive path escapes primitive directory: ${path}`);
  return resolved;
}

function describeError(error: unknown): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    const truncated = raw.length > MAX_DIAGNOSTIC_LENGTH;
    const message = raw.slice(0, MAX_DIAGNOSTIC_LENGTH).replace(/\s+/g, " ").trim();
    if (!message) return "Unknown error";
    return truncated ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...` : message;
  } catch {
    return "Unknown error";
  }
}

function readConfig(report: PrimitiveRegistrationReport, configPath: string): PrimitiveConfig {
  if (!existsSync(configPath)) return {};
  try {
    if (statSync(configPath).size > MAX_CONFIG_BYTES) throw new Error(`config must not exceed ${MAX_CONFIG_BYTES} bytes`);
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be a JSON object");
    const config = parsed as PrimitiveConfig;
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (config.disabled !== undefined && (!Array.isArray(config.disabled) || config.disabled.some((name) => typeof name !== "string"))) {
      throw new Error("disabled must be an array of primitive names");
    }
    if (config.disabled?.some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      throw new Error("disabled must contain kebab-case primitive names");
    }
    if (config.disabled && new Set(config.disabled).size !== config.disabled.length) {
      throw new Error("disabled must not contain duplicate primitive names");
    }
    return config;
  } catch (error) {
    report.failures.push({ name: "config", error: describeError(error) });
    return {};
  }
}

function primitiveContext(name: string, dir: string): PrimitiveContext {
  let canonicalDir: string | undefined;
  const root = (): string => canonicalDir ??= realpathSync(dir);
  return {
    name,
    dir,
    path(path) { return primitivePath(root(), path); },
    readText(path) {
      const canonicalRoot = root();
      const resource = realpathSync(primitivePath(canonicalRoot, path));
      if (!isContained(canonicalRoot, resource)) throw new Error(`Primitive path escapes primitive directory: ${path}`);
      return readFileSync(resource, "utf8");
    },
  };
}

export async function registerPrimitives(
  pi: ExtensionAPI,
  options: { configPath?: string; primitives?: readonly PrimitiveDefinition[] } = {},
): Promise<PrimitiveRegistrationReport> {
  const report: PrimitiveRegistrationReport = { loaded: [], skipped: [], failures: [] };
  const primitives = options.primitives ?? EXPLICIT_PRIMITIVES;
  const config = readConfig(report, options.configPath ?? CONFIG_PATH);
  if (config.enabled === false) {
    report.skipped.push(...primitives.map((primitive) => primitive.name));
    return report;
  }
  const disabled = new Set(config.disabled ?? []);
  const known = new Set(primitives.map((primitive) => primitive.name));
  const unknownDisabled = [...disabled].filter((name) => !known.has(name));
  if (unknownDisabled.length) report.failures.push({ name: "config", error: describeError(new Error(`Unknown disabled primitives: ${unknownDisabled.join(", ")}`)) });

  for (const primitive of primitives) {
    if (disabled.has(primitive.name)) {
      report.skipped.push(primitive.name);
      continue;
    }
    try {
      await primitive.register(pi, primitiveContext(primitive.name, primitive.dir));
      report.loaded.push(primitive.name);
    } catch (error) {
      report.failures.push({ name: primitive.name, error: describeError(error) });
    }
  }
  return report;
}

export function registerPrimitiveStatus(pi: ExtensionAPI, report: PrimitiveRegistrationReport): void {
  pi.on("session_start", (_event, ctx) => {
    const summary = `${report.loaded.length} registered${report.skipped.length ? `, ${report.skipped.length} disabled` : ""}${report.failures.length ? `, ${report.failures.length} failed` : ""}`;
    ctx.ui.setStatus("pi-primitives", summary);
    if (report.failures.length) ctx.ui.notify(`Primitive registration failures:\n${report.failures.map((failure) => `- ${failure.name}: ${failure.error}`).join("\n")}`, "warning");
  });
}

export default async function piPrimitives(pi: ExtensionAPI): Promise<void> {
  registerPrimitiveStatus(pi, await registerPrimitives(pi));
}
