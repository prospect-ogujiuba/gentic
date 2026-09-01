import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  CANONICAL_FILE_PATTERN,
  isArtifactKind,
  normalizeSegment,
  projectRelative,
  resolveProjectPath,
  TIMESTAMP_PATTERN,
  toPosix,
  validateTimestamp,
  validateTopic,
} from "./normalize.ts";
import type {
  ArtifactClassification,
  ArtifactInventory,
  ArtifactInventoryEntry,
  AuditArtifactsOptions,
  MigrationConfig,
  MigrationMapping,
} from "./types.ts";

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".json", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".yaml", ".yml", ".txt"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv"]);
const CONFIG_RELATIVE = ".pi/model-artifacts-migration.json";

export function loadMigrationConfig(cwd: string): MigrationConfig {
  const root = realpathSync(resolve(cwd));
  const path = join(root, ".pi", "model-artifacts-migration.json");
  if (!existsSync(path)) return { schemaVersion: 1, mappings: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("migration config must be an object");
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!new Set(["schemaVersion", "mappings"]).has(key)) throw new Error(`unknown config key: ${key}`);
  if (object.schemaVersion !== 1) throw new Error(`unsupported migration config schemaVersion: ${String(object.schemaVersion)}`);
  if (!object.mappings || typeof object.mappings !== "object" || Array.isArray(object.mappings)) throw new Error("migration config mappings must be an object");
  const mappings: Record<string, MigrationMapping> = {};
  for (const source of Object.keys(object.mappings as object).sort()) {
    resolveProjectPath(root, source);
    const value = (object.mappings as Record<string, unknown>)[source];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`mapping must be an object: ${source}`);
    const mapping = value as Record<string, unknown>;
    for (const key of Object.keys(mapping)) if (!new Set(["kind", "topic", "timestamp", "shortName"]).has(key)) throw new Error(`unknown mapping key ${key}: ${source}`);
    if (!isArtifactKind(mapping.kind)) throw new Error(`unsupported artifact kind: ${String(mapping.kind)}`);
    const shortName = typeof mapping.shortName === "string" ? normalizeSegment(mapping.shortName) : "";
    if (!shortName) throw new Error(`mapping shortName must produce kebab-case: ${source}`);
    mappings[source] = {
      kind: mapping.kind,
      topic: validateTopic(mapping.topic),
      timestamp: validateTimestamp(mapping.timestamp),
      shortName,
    };
  }
  return { schemaVersion: 1, mappings };
}

export function auditArtifacts(options: AuditArtifactsOptions): ArtifactInventory {
  const root = realpathSync(resolve(options.cwd));
  const artifactRoot = join(root, ".model-artifacts");
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  const config = loadMigrationConfig(root);
  if (!existsSync(artifactRoot)) return emptyInventory(root, config);
  const artifactRootStat = lstatSync(artifactRoot);
  if (artifactRootStat.isSymbolicLink()) throw new Error(".model-artifacts root must not be a symlink");
  if (!artifactRootStat.isDirectory()) throw new Error(".model-artifacts must be a directory");
  if (realpathSync(artifactRoot) !== artifactRoot) throw new Error(".model-artifacts root escapes the project");

  const discovered = walk(root, artifactRoot, maxFiles);
  const candidateBytes = discovered.filter((entry) => entry.regular).reduce((sum, entry) => sum + entry.bytes, 0);
  if (candidateBytes > maxBytes) throw new Error(`artifact byte limit exceeded: ${candidateBytes} > ${maxBytes}`);
  const authority = discoverAuthority(root, discovered);
  const references = discoverReferences(root, discovered.map((entry) => entry.source), maxFiles);
  const diagnostics = [...authority.diagnostics];
  const entries = discovered.map((entry) => classifyEntry(root, entry, config, authority, references));
  entries.sort((a, b) => a.source.localeCompare(b.source));
  const totals = { "canonical-valid": 0, "legacy-movable": 0, protected: 0, ambiguous: 0, invalid: 0 } satisfies Record<ArtifactClassification, number>;
  for (const entry of entries) totals[entry.classification] += 1;
  return {
    schemaVersion: 1,
    projectRoot: root,
    configPath: existsSync(join(root, ".pi", "model-artifacts-migration.json")) ? CONFIG_RELATIVE : null,
    entries,
    totals,
    fileCount: entries.length,
    candidateBytes,
    diagnostics,
  };
}

type Discovered = { absolute: string; source: string; bytes: number; regular: boolean; symlink: boolean };

function walk(root: string, artifactRoot: string, maxFiles: number): Discovered[] {
  const output: Discovered[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, item.name);
      const source = toPosix(projectRelative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        output.push({ absolute, source, bytes: stat.size, regular: false, symlink: true });
      } else if (stat.isDirectory()) {
        visit(absolute);
      } else {
        output.push({ absolute, source, bytes: stat.size, regular: stat.isFile(), symlink: false });
      }
      if (output.length > maxFiles) throw new Error(`artifact file limit exceeded: ${output.length} > ${maxFiles}`);
    }
  };
  visit(artifactRoot);
  return output;
}

function discoverAuthority(root: string, files: Discovered[]): { exact: Set<string>; prefixes: string[]; diagnostics: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [".model-artifacts/logs/model-artifact-migration/"];
  const diagnostics: string[] = [];
  const contractIndexes = new Set<string>();
  for (const file of files.filter((entry) => /\/specs\/.+\/manifest\.json$/.test(entry.source))) {
    exact.add(file.source);
    if (!file.regular) continue;
    try {
      const manifest = JSON.parse(readFileSync(file.absolute, "utf8")) as Record<string, any>;
      addPath(exact, manifest.activeSpec?.path);
      addPath(exact, manifest.activePlan?.path);
      addPath(exact, manifest.approval?.reviewPath);
      addPath(exact, manifest.activeContract?.path);
      if (typeof manifest.activePlan?.contractRoot === "string") prefixes.push(manifest.activePlan.contractRoot.replace(/\/+$/, "") + "/");
      const indexPath = typeof manifest.activePlan?.contractRoot === "string" ? `${manifest.activePlan.contractRoot.replace(/\/+$/, "")}/contracts.json` : undefined;
      addPath(exact, indexPath);
      if (indexPath) contractIndexes.add(indexPath);
    } catch (error) {
      diagnostics.push(`${file.source}: malformed canonical manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const file of files.filter((entry) => /\/plans\/.+\/contracts\.json$/.test(entry.source))) {
    exact.add(file.source);
    contractIndexes.add(file.source);
  }
  for (const indexPath of [...contractIndexes].sort()) readContractAuthority(root, indexPath, exact, diagnostics);
  prefixes.sort();
  return { exact, prefixes, diagnostics };
}

function readContractAuthority(root: string, indexPath: string, exact: Set<string>, diagnostics: string[]): void {
  try {
    const absolute = resolveProjectPath(root, indexPath);
    if (!existsSync(absolute)) return;
    const index = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, any>;
    for (const contract of Array.isArray(index.contracts) ? index.contracts : []) addPath(exact, contract?.path);
    for (const record of Object.values(index.completionRecords ?? {}) as any[]) {
      addPath(exact, record?.contractPath);
      addPath(exact, record?.verification?.path);
      addPath(exact, record?.review?.path);
    }
  } catch (error) {
    diagnostics.push(`${indexPath}: malformed canonical contract index: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addPath(set: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.startsWith(".model-artifacts/")) set.add(value);
}

type ReferenceTrie = { children: Map<string, ReferenceTrie>; terminal?: string };

function discoverReferences(root: string, sources: string[], maxFiles: number): Map<string, string[]> {
  const trie = buildReferenceTrie(sources);
  const found = new Map<string, string[]>();
  let visited = 0;
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && SKIP_DIRECTORIES.has(item.name)) continue;
      const absolute = join(directory, item.name);
      const relative = toPosix(projectRelative(root, absolute));
      if (relative === CONFIG_RELATIVE || relative.startsWith(".model-artifacts/logs/model-artifact-migration/")) continue;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!item.isFile() || !TEXT_EXTENSIONS.has(extname(item.name).toLowerCase())) continue;
      visited += 1;
      if (visited > maxFiles) throw new Error(`reference scan file limit exceeded: ${visited} > ${maxFiles}`);
      const stat = lstatSync(absolute);
      if (stat.size > 1024 * 1024) continue;
      const content = readFileSync(absolute, "utf8");
      for (const source of matchReferences(content, trie)) {
        if (relative === source) continue;
        const list = found.get(source) ?? [];
        list.push(relative);
        found.set(source, list);
      }
    }
  };
  visit(root);
  for (const refs of found.values()) refs.sort();
  return found;
}

function buildReferenceTrie(sources: string[]): ReferenceTrie {
  const root: ReferenceTrie = { children: new Map() };
  for (const source of sources) {
    let node = root;
    for (const character of source) {
      let next = node.children.get(character);
      if (!next) {
        next = { children: new Map() };
        node.children.set(character, next);
      }
      node = next;
    }
    node.terminal = source;
  }
  return root;
}

function matchReferences(content: string, trie: ReferenceTrie): Set<string> {
  const matches = new Set<string>();
  let start = content.indexOf(".model-artifacts/");
  while (start >= 0) {
    let node: ReferenceTrie | undefined = trie;
    for (let index = start; index < content.length && node; index += 1) {
      node = node.children.get(content[index] ?? "");
      if (node?.terminal && isReferenceBoundary(content[index + 1])) matches.add(node.terminal);
    }
    start = content.indexOf(".model-artifacts/", start + 1);
  }
  return matches;
}

function isReferenceBoundary(value: string | undefined): boolean {
  return value === undefined || /[\s"'`()<>\[\]{},:;]/.test(value);
}

function classifyEntry(
  root: string,
  file: Discovered,
  config: MigrationConfig,
  authority: { exact: Set<string>; prefixes: string[] },
  references: Map<string, string[]>,
): ArtifactInventoryEntry {
  if (file.symlink) return base(file, "invalid", ["symlink-not-followed"]);
  if (!file.regular) return base(file, "invalid", ["unsupported-filesystem-entry"]);
  const protectedByAuthority = authority.exact.has(file.source) || authority.prefixes.some((prefix) => file.source.startsWith(prefix));
  if (protectedByAuthority) return hashed(file, "protected", ["canonical-authority"]);
  if (extname(file.source).toLowerCase() !== ".md") return base(file, "invalid", ["unsupported-artifact-type"]);
  if (parseCanonical(file.source)) return hashed(file, "canonical-valid", ["canonical-path"]);

  const inbound = references.get(file.source) ?? [];
  if (inbound.length) return hashed(file, "protected", inbound.map((source) => `inbound-reference:${source}`));
  const mapping = config.mappings[file.source] ?? inferMapping(root, file);
  if (!mapping) return hashed(file, "ambiguous", ["mapping-required"]);
  const destination = `.model-artifacts/${mapping.kind}/${mapping.topic}/${mapping.timestamp}-${mapping.shortName}.md`;
  if (destination === file.source) return hashed(file, "canonical-valid", ["canonical-path"]);
  return { ...hashed(file, "legacy-movable", [config.mappings[file.source] ? "explicit-mapping" : "deterministic-inference"]), destination };
}

function parseCanonical(source: string): boolean {
  const parts = source.split("/");
  return parts[0] === ".model-artifacts" && isArtifactKind(parts[1]) && parts.length >= 4 && CANONICAL_FILE_PATTERN.test(parts.at(-1) ?? "")
    && parts.slice(2, -1).every((segment) => normalizeSegment(segment) === segment && segment.length > 0);
}

function inferMapping(root: string, file: Discovered): MigrationMapping | undefined {
  const parts = file.source.split("/");
  const kind = isArtifactKind(parts[1]) ? parts[1] : undefined;
  const content = readFileSync(file.absolute, "utf8").slice(0, 64 * 1024);
  const topicMatch = content.match(/^Topic:\s*`?([^`\s]+)`?\s*$/mi);
  const topic = topicMatch ? safeTopic(topicMatch[1]) : parts.length > 3 && kind ? safeTopic(parts.slice(2, -1).join("/")) : undefined;
  const name = basename(file.source, ".md").replace(/\s*\[COMPLETE\]$/i, "");
  const match = name.match(/^(\d{4}-\d{2}-\d{2}_\d{4})-(.+)$/);
  const timestamp = match?.[1] && TIMESTAMP_PATTERN.test(match[1]) ? match[1] : gitFirstAddTimestamp(root, file.source);
  const shortName = normalizeSegment(match?.[2] ?? name);
  if (!kind || !topic || !timestamp || !shortName) return undefined;
  return { kind, topic, timestamp, shortName };
}

function safeTopic(value: string): string | undefined {
  try { return validateTopic(value); } catch { return undefined; }
}

function gitFirstAddTimestamp(root: string, source: string): string | undefined {
  try {
    const output = execFileSync("git", ["log", "--diff-filter=A", "--follow", "--format=%aI", "--", source], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).at(-1);
    if (!output) return undefined;
    const date = new Date(output);
    if (Number.isNaN(date.valueOf())) return undefined;
    return date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  } catch {
    return undefined;
  }
}

function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function base(file: Discovered, classification: ArtifactClassification, reasons: string[]): ArtifactInventoryEntry {
  return { source: file.source, classification, reasons, bytes: file.bytes };
}

function hashed(file: Discovered, classification: ArtifactClassification, reasons: string[]): ArtifactInventoryEntry {
  return { ...base(file, classification, reasons), contentHash: hashFile(file.absolute) };
}

function emptyInventory(root: string, config: MigrationConfig): ArtifactInventory {
  return {
    schemaVersion: 1,
    projectRoot: root,
    configPath: Object.keys(config.mappings).length ? CONFIG_RELATIVE : null,
    entries: [],
    totals: { "canonical-valid": 0, "legacy-movable": 0, protected: 0, ambiguous: 0, invalid: 0 },
    fileCount: 0,
    candidateBytes: 0,
    diagnostics: [],
  };
}
