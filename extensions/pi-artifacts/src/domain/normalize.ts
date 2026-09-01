import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { ARTIFACT_KINDS, type ArtifactKind } from "./types.ts";

export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}$/;
export const CANONICAL_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export function toPosix(value: string): string {
  return value.split(sep).join("/");
}

export function projectRelative(root: string, target: string): string {
  const value = toPosix(relative(root, target));
  if (!value || value === ".") return ".";
  if (value === ".." || value.startsWith("../") || isAbsolute(value)) throw new Error(`path escapes project root: ${target}`);
  return value;
}

export function resolveProjectPath(root: string, source: string): string {
  if (isAbsolute(source) || source.includes("\\")) throw new Error(`source must be a project-relative .model-artifacts path: ${source}`);
  const normalized = posix.normalize(source);
  if (!normalized.startsWith(".model-artifacts/") || normalized.includes("..") || normalized !== source) {
    throw new Error(`source must be a project-relative .model-artifacts path: ${source}`);
  }
  const target = resolve(root, ...normalized.split("/"));
  projectRelative(root, target);
  return target;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function normalizeSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function validateTopic(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("mapping topic must be a non-empty kebab-case path");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || normalizeSegment(segment) !== segment)) throw new Error(`mapping topic must be kebab-case: ${value}`);
  return value;
}

export function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) throw new Error(`mapping timestamp must match YYYY-MM-DD_HHMM: ${String(value)}`);
  const [date, time] = value.split("_");
  const parsed = new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 16).replace("T", "_").replace(":", "") !== value) {
    throw new Error(`mapping timestamp is invalid: ${value}`);
  }
  return value;
}
