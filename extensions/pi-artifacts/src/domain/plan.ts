import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

import type { ArtifactInventory, ArtifactInventoryEntry } from "./types.ts";

export type MigrationMove = {
  source: string;
  destination: string;
  sourceHash: string;
  bytes: number;
  reason: string;
};

export type MigrationRewrite = {
  path: string;
  sourceHash: string;
  expectedHash: string;
  sourceBytes: number;
  expectedBytes: number;
  replacements: Array<{ from: string; to: string }>;
};

export type MigrationPlanBlocker = {
  code:
    | "inventory-diagnostic"
    | "unsafe-entry"
    | "missing-identity"
    | "destination-exists"
    | "duplicate-destination"
    | "destination-case-collision"
    | "reference-cycle"
    | "stale-source"
    | "stale-reference"
    | "affected-bytes-limit"
    | "reference-limit"
    | "rewrite-limit"
    | "staging-bytes-limit"
    | "rollback-bytes-limit"
    | "no-moves";
  source: string;
  message: string;
};

export type MigrationPlanBounds = {
  maxAffectedBytes: number;
  maxReferences: number;
  maxRewriteRecords: number;
  maxStagingBytes: number;
  maxRollbackBytes: number;
  affectedBytes: number;
  references: number;
  rewriteRecords: number;
  stagingBytes: number;
  rollbackBytes: number;
};

export type MigrationPlan = {
  schemaVersion: 1;
  generatedAt: string;
  durationMs: number;
  projectRoot: string;
  configPath: string | null;
  configFingerprint: string;
  moves: MigrationMove[];
  rewrites: MigrationRewrite[];
  expectedPostTransformHashes: Record<string, string>;
  authorityUnits: string[];
  bounds: MigrationPlanBounds;
  blockers: MigrationPlanBlocker[];
  eligible: boolean;
  fingerprint: string;
};

export type CreateMigrationPlanOptions = {
  generatedAt?: string;
  configFingerprint: string;
  maxAffectedBytes?: number;
  maxReferences?: number;
  maxRewriteRecords?: number;
  maxStagingBytes?: number;
  maxRollbackBytes?: number;
};

const DEFAULT_MAX_AFFECTED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_REFERENCES = 100_000;
const DEFAULT_MAX_REWRITE_RECORDS = 20_000;
const DEFAULT_MAX_STAGING_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ROLLBACK_BYTES = 64 * 1024 * 1024;

export function createMigrationPlan(inventory: ArtifactInventory, options: CreateMigrationPlanOptions): MigrationPlan {
  const startedAt = Date.now();
  const moves: MigrationMove[] = [];
  const blockers: MigrationPlanBlocker[] = inventory.diagnostics.map((message) => ({ code: "inventory-diagnostic", source: ".model-artifacts", message }));
  revalidateInventory(inventory, blockers);
  const sources = new Set(inventory.entries.map((entry) => entry.source));
  for (const entry of inventory.entries) {
    if (entry.classification === "legacy-movable") {
      if (!entry.destination || !entry.contentHash) {
        blockers.push({ code: "missing-identity", source: entry.source, message: "movable entry lacks destination or content hash" });
        continue;
      }
      if (sources.has(entry.destination) && entry.destination !== entry.source) blockers.push({ code: "destination-exists", source: entry.source, message: `destination already exists: ${entry.destination}` });
      moves.push({ source: entry.source, destination: entry.destination, sourceHash: entry.contentHash, bytes: entry.bytes, reason: entry.reasons.join(",") });
      continue;
    }
    if (isUnsafeLegacyEntry(entry)) blockers.push({ code: "unsafe-entry", source: entry.source, message: entry.reasons.join(", ") || entry.classification });
  }
  moves.sort((a, b) => a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination));
  const byDestination = new Map<string, MigrationMove[]>();
  for (const move of moves) byDestination.set(move.destination, [...(byDestination.get(move.destination) ?? []), move]);
  for (const [destination, group] of [...byDestination].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    for (const move of group) blockers.push({ code: "duplicate-destination", source: move.source, message: `multiple sources target ${destination}` });
  }
  const byFoldedDestination = new Map<string, MigrationMove[]>();
  for (const move of moves) {
    const folded = move.destination.toLocaleLowerCase("en-US");
    byFoldedDestination.set(folded, [...(byFoldedDestination.get(folded) ?? []), move]);
  }
  for (const group of byFoldedDestination.values()) {
    if (group.length < 2 || new Set(group.map((move) => move.destination)).size === 1) continue;
    for (const move of group) blockers.push({ code: "destination-case-collision", source: move.source, message: `case-fold destination collision: ${group.map((item) => item.destination).sort().join(", ")}` });
  }

  const relocation = new Map(moves.map((move) => [move.source, move.destination]));
  const reverseRelocation = new Map<string, string>();
  for (const move of moves) if (!reverseRelocation.has(move.destination)) reverseRelocation.set(move.destination, move.source);
  const transformed = buildTransforms(inventory, relocation, reverseRelocation, blockers);
  const expectedPostTransformHashes = Object.fromEntries(moves.map((move) => [move.destination, transformed.hashes.get(move.source) ?? move.sourceHash]).sort(([a], [b]) => a.localeCompare(b)));
  const rewrites = [...transformed.rewrites].sort((a, b) => a.path.localeCompare(b.path));
  const references = rewrites.reduce((sum, rewrite) => sum + rewrite.replacements.length, 0);
  const affectedPaths = new Set([...moves.map((move) => move.source), ...rewrites.map((rewrite) => rewrite.path)]);
  const affectedBytes = inventory.entries.filter((entry) => affectedPaths.has(entry.source)).reduce((sum, entry) => sum + entry.bytes, 0)
    + rewrites.filter((rewrite) => !sources.has(rewrite.path)).reduce((sum, rewrite) => sum + (transformed.originalBytes.get(rewrite.path) ?? 0), 0);
  const stagingBytes = moves.reduce((sum, move) => sum + (transformed.transformedBytes.get(move.source) ?? move.bytes), 0)
    + rewrites.filter((rewrite) => !relocation.has(rewrite.path)).reduce((sum, rewrite) => sum + (transformed.transformedBytes.get(rewrite.path) ?? 0), 0);
  const rollbackBytes = moves.reduce((sum, move) => sum + move.bytes, 0) + rewrites.filter((rewrite) => !relocation.has(rewrite.path)).reduce((sum, rewrite) => sum + (transformed.originalBytes.get(rewrite.path) ?? 0), 0);
  const bounds: MigrationPlanBounds = {
    maxAffectedBytes: positive(options.maxAffectedBytes, DEFAULT_MAX_AFFECTED_BYTES, "maxAffectedBytes"),
    maxReferences: positive(options.maxReferences, DEFAULT_MAX_REFERENCES, "maxReferences"),
    maxRewriteRecords: positive(options.maxRewriteRecords, DEFAULT_MAX_REWRITE_RECORDS, "maxRewriteRecords"),
    maxStagingBytes: positive(options.maxStagingBytes, DEFAULT_MAX_STAGING_BYTES, "maxStagingBytes"),
    maxRollbackBytes: positive(options.maxRollbackBytes, DEFAULT_MAX_ROLLBACK_BYTES, "maxRollbackBytes"),
    affectedBytes,
    references,
    rewriteRecords: rewrites.length,
    stagingBytes,
    rollbackBytes,
  };
  if (affectedBytes > bounds.maxAffectedBytes) blockers.push({ code: "affected-bytes-limit", source: ".model-artifacts", message: `affected bytes ${affectedBytes} exceed ${bounds.maxAffectedBytes}` });
  if (references > bounds.maxReferences) blockers.push({ code: "reference-limit", source: ".model-artifacts", message: `references ${references} exceed ${bounds.maxReferences}` });
  if (rewrites.length > bounds.maxRewriteRecords) blockers.push({ code: "rewrite-limit", source: ".model-artifacts", message: `rewrite records ${rewrites.length} exceed ${bounds.maxRewriteRecords}` });
  if (stagingBytes > bounds.maxStagingBytes) blockers.push({ code: "staging-bytes-limit", source: ".model-artifacts", message: `staging bytes ${stagingBytes} exceed ${bounds.maxStagingBytes}` });
  if (rollbackBytes > bounds.maxRollbackBytes) blockers.push({ code: "rollback-bytes-limit", source: ".model-artifacts", message: `rollback bytes ${rollbackBytes} exceed ${bounds.maxRollbackBytes}` });
  if (moves.length === 0) blockers.push({ code: "no-moves", source: ".model-artifacts", message: "no eligible legacy artifacts were found" });
  blockers.sort((a, b) => a.source.localeCompare(b.source) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  const authorityUnits = [...new Set(inventory.entries.filter((entry) => entry.classification === "legacy-movable").map((entry) => entry.authorityUnit === "initiative" ? `initiative:${entry.topic}` : entry.authorityUnit ?? "isolated"))].sort();
  const logical = { schemaVersion: 1 as const, projectRoot: inventory.projectRoot, configPath: inventory.configPath, configFingerprint: options.configFingerprint, moves, rewrites, expectedPostTransformHashes, authorityUnits, bounds, blockers };
  return { ...logical, generatedAt: options.generatedAt ?? new Date().toISOString(), durationMs: Date.now() - startedAt, eligible: blockers.length === 0, fingerprint: fingerprint(logical) };
}

function revalidateInventory(inventory: ArtifactInventory, blockers: MigrationPlanBlocker[]): void {
  for (const entry of inventory.entries) {
    if (entry.contentHash) {
      try {
        const bytes = readSafeSnapshot(inventory.projectRoot, entry.source, entry.contentHash);
        if (bytes.byteLength !== entry.bytes) throw new Error(`byte size changed: expected ${entry.bytes}, observed ${bytes.byteLength}`);
      } catch (error) {
        const unsafe = /symlink|regular file|escapes|project-relative/.test(error instanceof Error ? error.message : String(error));
        blockers.push({
          code: unsafe ? "unsafe-entry" : "stale-source",
          source: entry.source,
          message: `inventory source changed after audit: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    for (const site of entry.referenceSites ?? []) {
      const expectedHash = entry.referenceSiteHashes?.[site];
      try {
        if (!expectedHash) throw new Error("missing audit fingerprint");
        readSafeSnapshot(inventory.projectRoot, site, expectedHash);
      } catch (error) {
        blockers.push({ code: "stale-reference", source: site, message: `reference site changed after audit: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
}

function collectReferenceHashes(inventory: ArtifactInventory): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of inventory.entries) {
    for (const [path, hash] of Object.entries(entry.referenceSiteHashes ?? {})) {
      const previous = result.get(path);
      if (previous && previous !== hash) throw new Error(`conflicting audit fingerprints for reference site: ${path}`);
      result.set(path, hash);
    }
  }
  return result;
}

function readSafeSnapshot(root: string, path: string, expectedHash: string): Buffer {
  const absolute = safeProjectPath(root, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("path must remain a regular non-symlink file");
  if (realpathSync(absolute) !== absolute) throw new Error("path resolves through a symlink");
  const bytes = readFileSync(absolute);
  const observedHash = hashBytes(bytes);
  if (observedHash !== expectedHash) throw new Error(`content hash mismatch: expected ${expectedHash}, observed ${observedHash}`);
  return bytes;
}

function safeProjectPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../")) {
    throw new Error(`path must be project-relative: ${path}`);
  }
  const absolute = resolve(root, ...path.split("/"));
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) throw new Error(`path escapes project root: ${path}`);
  return absolute;
}

function buildTransforms(inventory: ArtifactInventory, relocation: Map<string, string>, reverseRelocation: Map<string, string>, blockers: MigrationPlanBlocker[]): { rewrites: MigrationRewrite[]; hashes: Map<string, string>; originalBytes: Map<string, number>; transformedBytes: Map<string, number> } {
  const allEntries = new Map(inventory.entries.map((entry) => [entry.source, entry]));
  const referenceHashes = collectReferenceHashes(inventory);
  const affected = new Set<string>(relocation.keys());
  for (const source of relocation.keys()) for (const site of allEntries.get(source)?.referenceSites ?? []) affected.add(site);
  const replacements = [...relocation].sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  const contents = new Map<string, string>();
  const originals = new Map<string, string>();
  const originalBytes = new Map<string, number>();
  const dependencies = new Map<string, Set<string>>();
  const hashPointers = new Map<string, Array<{ path: string; oldHash: string }>>();

  for (const path of [...affected].sort()) {
    try {
      const expectedHash = allEntries.get(path)?.contentHash ?? referenceHashes.get(path);
      if (!expectedHash) throw new Error("missing audit fingerprint");
      const bytes = readSafeSnapshot(inventory.projectRoot, path, expectedHash);
      let content = bytes.toString("utf8");
      originals.set(path, content);
      originalBytes.set(path, bytes.byteLength);
      const used: Array<{ from: string; to: string }> = [];
      for (const [from, to] of replacements) {
        const replaced = replaceExactReferences(content, from, to);
        if (replaced === content) continue;
        content = replaced;
        used.push({ from, to });
      }
      if (/^\.model-artifacts\/specs\/.+\/manifest\.json$/.test(path)) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed.schemaVersion === 1) {
          parsed.schemaVersion = 2;
          replaceContractRoots(parsed, relocation);
          content = `${JSON.stringify(parsed, null, 2)}\n`;
        }
      }
      contents.set(path, content);
      const pointers: Array<{ path: string; oldHash: string }> = [];
      if (path.endsWith(".json")) collectHashPointers(JSON.parse(content), pointers);
      hashPointers.set(path, pointers);
      dependencies.set(path, new Set(pointers.map((pointer) => reverseRelocation.get(pointer.path)).filter((value): value is string => Boolean(value))));
      if (used.length === 0 && !relocation.has(path)) affected.delete(path);
    } catch (error) {
      blockers.push({ code: "stale-reference", source: path, message: `cannot plan exact rewrite: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    if (visiting.has(path)) { blockers.push({ code: "reference-cycle", source: path, message: "structured content-hash dependency cycle" }); return; }
    visiting.add(path);
    for (const child of [...(dependencies.get(path) ?? [])].sort()) visit(child);
    visiting.delete(path);
    visited.add(path);
    order.push(path);
  };
  for (const path of [...affected].sort()) visit(path);

  const hashes = new Map<string, string>();
  const transformedBytes = new Map<string, number>();
  for (const path of order) {
    let content = contents.get(path);
    if (content === undefined) continue;
    if (path.endsWith(".json")) {
      const parsed = JSON.parse(content) as unknown;
      replaceHashPointers(parsed, (destination, previous) => {
        const source = reverseRelocation.get(destination);
        return source ? hashes.get(source) ?? previous : previous;
      });
      content = `${JSON.stringify(parsed, null, 2)}\n`;
      contents.set(path, content);
    }
    hashes.set(path, hashBytes(content));
    transformedBytes.set(path, Buffer.byteLength(content));
  }

  const rewrites: MigrationRewrite[] = [];
  for (const path of [...affected].sort()) {
    const content = contents.get(path);
    if (content === undefined) continue;
    const original = originals.get(path);
    if (original === undefined) continue;
    if (content === original) continue;
    const used = replacements.filter(([from, to]) => replaceExactReferences(original, from, to) !== original).map(([from, to]) => ({ from, to }));
    rewrites.push({
      path,
      sourceHash: hashBytes(original),
      expectedHash: hashes.get(path) ?? hashBytes(content),
      sourceBytes: Buffer.byteLength(original),
      expectedBytes: Buffer.byteLength(content),
      replacements: used,
    });
  }
  return { rewrites, hashes, originalBytes, transformedBytes };
}

function replaceContractRoots(value: unknown, relocation: Map<string, string>): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceContractRoots(child, relocation)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.contractRoot === "string") {
    const contractRoot = object.contractRoot;
    const roots = [...relocation].flatMap(([source, destination]) => {
      if (!source.startsWith(`${contractRoot}/`)) return [];
      const suffix = source.slice(contractRoot.length);
      return [destination.slice(0, -suffix.length)];
    });
    const uniqueRoots = [...new Set(roots)];
    if (uniqueRoots.length === 1) object.contractRoot = uniqueRoots[0];
  }
  Object.values(object).forEach((child) => replaceContractRoots(child, relocation));
}

function collectHashPointers(value: unknown, output: Array<{ path: string; oldHash: string }>): void {
  if (Array.isArray(value)) { value.forEach((child) => collectHashPointers(child, output)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.contentHash === "string") output.push({ path: object.path, oldHash: object.contentHash });
  Object.values(object).forEach((child) => collectHashPointers(child, output));
}

function replaceHashPointers(value: unknown, replacement: (path: string, previous: string) => string): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceHashPointers(child, replacement)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.contentHash === "string") object.contentHash = replacement(object.path, object.contentHash);
  Object.values(object).forEach((child) => replaceHashPointers(child, replacement));
}

function replaceExactReferences(content: string, from: string, to: string): string {
  let cursor = 0;
  let output = "";
  let changed = false;
  while (cursor < content.length) {
    const index = content.indexOf(from, cursor);
    if (index < 0) { output += content.slice(cursor); break; }
    const before = content[index - 1];
    const after = content[index + from.length];
    const validBefore = before === undefined || /[\s"'`()<>\[\]{},:;]/.test(before);
    const validAfter = after === undefined || /[\s"'`()<>\[\]{},:;]/.test(after);
    output += content.slice(cursor, index);
    if (validBefore && validAfter) { output += to; changed = true; }
    else output += from;
    cursor = index + from.length;
  }
  return changed ? output : content;
}

export function isNoopMigrationPlan(plan: MigrationPlan): boolean {
  return plan.moves.length === 0 && plan.blockers.length === 1 && plan.blockers[0]?.code === "no-moves";
}

export function fingerprint(value: unknown): string {
  return hashBytes(stableJson(value));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
}

function hashBytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function isUnsafeLegacyEntry(entry: ArtifactInventoryEntry): boolean {
  if (entry.classification === "ambiguous" && entry.source.endsWith(".md")) return true;
  if (entry.classification === "protected" && entry.reasons.some((reason) => reason.startsWith("inbound-reference:") || reason === "mixed-authority")) return true;
  return entry.classification === "invalid";
}
