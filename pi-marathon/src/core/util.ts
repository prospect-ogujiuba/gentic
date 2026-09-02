import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const nowIso = (): string => new Date().toISOString();
export const makeId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("hex");
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const errorMessage = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error);
export const clamp = (value: number, min: number, max: number): number => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
export async function canonicalPath(input: string): Promise<string> { try { return await realpath(input); } catch { return path.resolve(input); } }
export async function ensureDir(directory: string): Promise<void> { await mkdir(directory, { recursive: true, mode: 0o700 }); }
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
}
export function parseJson<T>(value: string | null | undefined, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
export function truncate(value: string, max = 12_000): string {
  if (value.length <= max) return value;
  const half = Math.floor(max / 2);
  return `${value.slice(0, half)}\n\n…[truncated ${value.length - max} characters]…\n\n${value.slice(-half)}`;
}
export function uniqueStrings(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(); const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim(); if (!text || seen.has(text)) continue;
    seen.add(text); result.push(text); if (result.length >= max) break;
  }
  return result;
}
export function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const output = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = output[key];
    output[key] = current && value && typeof current === "object" && typeof value === "object" && !Array.isArray(current) && !Array.isArray(value)
      ? deepMerge(current, value) : value;
  }
  return output as T;
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true });
  });
}
