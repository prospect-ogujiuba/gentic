import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import conciseOutput from "./primitives/concise-output/index.ts";
import implementationFileCompletion from "./primitives/implementation-file-completion/index.ts";
import modelArtifacts from "./primitives/model-artifacts/index.ts";

/** Legacy scaffold source contract only. The bundle never creates or loads contexts. */
export type PrimitiveContext = {
  name: string;
  dir: string;
  path(path: string): string;
  readText(path: string): string;
};
export type PrimitiveRegistrationReport = { loaded: string[]; skipped: string[]; failures: Array<{ name: string; error: string }> };
type PrimitiveConfig = { enabled?: boolean; disabled?: string[] };
const MAX_CONFIG_BYTES = 16384;
const MAX_DIAGNOSTIC_LENGTH = 512;
const CONFIG_PATH = fileURLToPath(new URL("./config.json", import.meta.url));
const NAMES = ["concise-output", "implementation-file-completion", "model-artifacts", "whimsical"];

function describeError(error: unknown): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    const truncated = raw.length > MAX_DIAGNOSTIC_LENGTH;
    const message = raw.slice(0, MAX_DIAGNOSTIC_LENGTH).replace(/\s+/g, " ").trim();
    if (!message) return "Unknown error";
    return truncated ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...` : message;
  } catch { return "Unknown error"; }
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
    if (config.disabled?.some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) throw new Error("disabled must contain kebab-case primitive names");
    if (config.disabled && new Set(config.disabled).size !== config.disabled.length) throw new Error("disabled must not contain duplicate primitive names");
    const unknownKeys = Object.keys(parsed).filter((key) => key !== "enabled" && key !== "disabled");
    if (unknownKeys.length) report.failures.push({ name: "config", error: describeError(`Unknown config fields: ${unknownKeys.join(", ")}; use enabled/disabled or native Pi package filters`) });
    return config;
  } catch (error) {
    report.failures.push({ name: "config", error: describeError(error) });
    return {};
  }
}

/** Fixed compatibility bundle, not an extension/plugin registration API. */
export async function registerPrimitives(pi: ExtensionAPI, options: { configPath?: string } = {}): Promise<PrimitiveRegistrationReport> {
  const report: PrimitiveRegistrationReport = { loaded: [], skipped: [], failures: [] };
  const config = readConfig(report, options.configPath ?? CONFIG_PATH);
  if (config.enabled === false) {
    report.skipped.push(...NAMES);
    return report;
  }
  const disabled = new Set(config.disabled ?? []);
  const unknownDisabled = [...disabled].filter((name) => !NAMES.includes(name));
  if (unknownDisabled.length) report.failures.push({ name: "config", error: describeError(`Unknown disabled primitives: ${unknownDisabled.join(", ")}`) });

  // Explicit policy boundaries preserve registration order and independent startup recovery.
  if (disabled.has("concise-output")) report.skipped.push("concise-output");
  else try { conciseOutput(pi); report.loaded.push("concise-output"); }
  catch (error) { report.failures.push({ name: "concise-output", error: describeError(error) }); }

  if (disabled.has("implementation-file-completion")) report.skipped.push("implementation-file-completion");
  else try { implementationFileCompletion(pi); report.loaded.push("implementation-file-completion"); }
  catch (error) { report.failures.push({ name: "implementation-file-completion", error: describeError(error) }); }

  if (disabled.has("model-artifacts")) report.skipped.push("model-artifacts");
  else try { modelArtifacts(pi); report.loaded.push("model-artifacts"); }
  catch (error) { report.failures.push({ name: "model-artifacts", error: describeError(error) }); }

  // Legacy name remains accepted; Pi owns the working indicator.
  if (disabled.has("whimsical")) report.skipped.push("whimsical");
  else report.loaded.push("whimsical");
  return report;
}

export function registerPrimitiveStatus(pi: ExtensionAPI, report: PrimitiveRegistrationReport): void {
  pi.on("session_start", (_event, ctx) => {
    const summary = `${report.loaded.length} registered${report.skipped.length ? `, ${report.skipped.length} disabled` : ""}${report.failures.length ? `, ${report.failures.length} failed` : ""}`;
    ctx.ui.setStatus("pi-primitives", summary);
    if (report.failures.length) ctx.ui.notify(`Primitive registration failures:\n${report.failures.map((failure) => `- ${failure.name}: ${failure.error}`).join("\n")}`, "warning");
    if (report.loaded.includes("whimsical")) ctx.ui.notify("pi-primitives: whimsical is deprecated and has no effect; Pi owns the working indicator. Disable whimsical in config.json to silence this notice.", "info");
  });
}

export default async function piPrimitives(pi: ExtensionAPI): Promise<void> {
  registerPrimitiveStatus(pi, await registerPrimitives(pi));
}
