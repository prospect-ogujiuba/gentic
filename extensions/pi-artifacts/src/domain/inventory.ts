import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

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
const DEFAULT_MAX_REFERENCE_FILES = 20_000;
const DEFAULT_MAX_REFERENCE_BYTES = 256 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".json", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".yaml", ".yml", ".txt"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv"]);
const CONFIG_RELATIVE = ".pi/model-artifacts-migration.json";
const LEGACY_TRANSACTION_PREFIX = ".model-artifacts/logs/model-artifact-migration/";
const SYSTEM_TRANSACTION_PREFIX = ".model-artifacts/system/logs/model-artifact-migration/";

export function loadMigrationConfig(cwd: string): MigrationConfig {
  const root = realpathSync(resolve(cwd));
  const path = join(root, ".pi", "model-artifacts-migration.json");
  if (!existsSync(path)) return { schemaVersion: 1, mappings: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("migration config must be an object");
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!["schemaVersion", "mappings"].includes(key)) throw new Error(`unknown config key: ${key}`);
  if (object.schemaVersion !== 1) throw new Error(`unsupported migration config schemaVersion: ${String(object.schemaVersion)}`);
  if (!object.mappings || typeof object.mappings !== "object" || Array.isArray(object.mappings)) throw new Error("migration config mappings must be an object");
  const mappings: Record<string, MigrationMapping> = {};
  for (const source of Object.keys(object.mappings as object).sort()) {
    resolveProjectPath(root, source);
    const value = (object.mappings as Record<string, unknown>)[source];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`mapping must be an object: ${source}`);
    const mapping = value as Record<string, unknown>;
    for (const key of Object.keys(mapping)) if (!["kind", "topic", "timestamp", "shortName"].includes(key)) throw new Error(`unknown mapping key ${key}: ${source}`);
    if (!isArtifactKind(mapping.kind)) throw new Error(`unsupported artifact kind: ${String(mapping.kind)}`);
    const shortName = typeof mapping.shortName === "string" ? normalizeSegment(mapping.shortName) : "";
    if (!shortName) throw new Error(`mapping shortName must produce kebab-case: ${source}`);
    mappings[source] = { kind: mapping.kind, topic: validateTopic(mapping.topic), timestamp: validateTimestamp(mapping.timestamp), shortName };
  }
  return { schemaVersion: 1, mappings };
}

export function auditArtifacts(options: AuditArtifactsOptions): ArtifactInventory {
  const root = realpathSync(resolve(options.cwd));
  const artifactRoot = join(root, ".model-artifacts");
  const maxFiles = positiveBound(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maxBytes = positiveBound(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const maxReferenceFiles = positiveBound(options.maxReferenceFiles, DEFAULT_MAX_REFERENCE_FILES, "maxReferenceFiles");
  const maxReferenceBytes = positiveBound(options.maxReferenceBytes, DEFAULT_MAX_REFERENCE_BYTES, "maxReferenceBytes");
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
  const references = discoverReferences(root, discovered.map((entry) => entry.source), maxReferenceFiles, maxReferenceBytes);
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
    diagnostics: authority.diagnostics.sort(),
  };
}

type Discovered = { absolute: string; source: string; bytes: number; regular: boolean; symlink: boolean };
type Authority = { exact: Set<string>; prefixes: string[]; completeV1Topics: Set<string>; mixedTopics: Set<string>; diagnostics: string[] };

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function walk(root: string, artifactRoot: string, maxFiles: number): Discovered[] {
  const output: Discovered[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, item.name);
      const source = toPosix(projectRelative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) output.push({ absolute, source, bytes: stat.size, regular: false, symlink: true });
      else if (stat.isDirectory()) visit(absolute);
      else output.push({ absolute, source, bytes: stat.size, regular: stat.isFile(), symlink: false });
      if (output.length > maxFiles) throw new Error(`artifact file limit exceeded: ${output.length} > ${maxFiles}`);
    }
  };
  visit(artifactRoot);
  return output;
}

function discoverAuthority(root: string, files: Discovered[]): Authority {
  const exact = new Set<string>();
  const prefixes = [LEGACY_TRANSACTION_PREFIX, SYSTEM_TRANSACTION_PREFIX];
  const diagnostics: string[] = [];
  const completeV1Topics = new Set<string>();
  const mixedTopics = new Set<string>();
  const sources = new Set(files.map((file) => file.source));
  const v1Manifests = new Map<string, Discovered>();
  const v2Manifests = new Map<string, Discovered>();

  for (const file of files) {
    const v1 = file.source.match(/^\.model-artifacts\/specs\/(.+)\/manifest\.json$/);
    const v2 = file.source.match(/^\.model-artifacts\/initiatives\/(.+)\/specs\/manifest\.json$/);
    if (v1?.[1]) v1Manifests.set(v1[1], file);
    if (v2?.[1]) v2Manifests.set(v2[1], file);
  }
  for (const topic of [...v1Manifests.keys()].filter((value) => v2Manifests.has(value)).sort()) {
    mixedTopics.add(topic);
    diagnostics.push(`mixed authority for topic ${topic}: both kind-first and topic-first manifests exist`);
  }

  for (const [topic, file] of [...v1Manifests].sort(([a], [b]) => a.localeCompare(b))) {
    exact.add(file.source);
    if (mixedTopics.has(topic)) continue;
    const result = validateV1Authority(root, topic, file, sources);
    for (const path of result.paths) exact.add(path);
    prefixes.push(...result.prefixes);
    if (result.error) diagnostics.push(`${file.source}: ${result.error}`);
    else completeV1Topics.add(topic);
  }
  for (const [, file] of [...v2Manifests].sort(([a], [b]) => a.localeCompare(b))) {
    exact.add(file.source);
    readManifestAuthority(root, file, exact, prefixes, diagnostics);
  }
  for (const file of files.filter((entry) => /\/plans\/.+\/contracts\.json$/.test(entry.source))) {
    exact.add(file.source);
    readContractAuthority(root, file.source, exact, diagnostics);
  }
  for (const file of files.filter((entry) => entry.source === `${LEGACY_TRANSACTION_PREFIX}active.claim.json` || entry.source === `${SYSTEM_TRANSACTION_PREFIX}active.claim.json`)) {
    let detail = "owner=unknown operation=unknown";
    try {
      const claim = JSON.parse(readFileSync(file.absolute, "utf8")) as Record<string, unknown>;
      detail = `owner=${typeof claim.ownerToken === "string" ? claim.ownerToken : "unknown"} operation=${typeof claim.operation === "string" ? claim.operation : "unknown"}`;
    } catch { /* keep bounded unknown detail */ }
    diagnostics.push(`active migration claim blocks planning at ${file.source} (${detail}); recover or reconcile it first`);
  }
  return { exact, prefixes: [...new Set(prefixes)].sort(), completeV1Topics, mixedTopics, diagnostics };
}

function validateV1Authority(root: string, topic: string, file: Discovered, sources: Set<string>): { paths: string[]; prefixes: string[]; error?: string } {
  const paths = [file.source];
  const prefixes: string[] = [];
  try {
    if (!file.regular || file.symlink) return { paths, prefixes, error: "manifest must be a regular non-symlink file" };
    validateTopic(topic);
    const manifest = JSON.parse(readFileSync(file.absolute, "utf8")) as Record<string, any>;
    if (manifest.schemaVersion !== 1) return { paths, prefixes, error: `unsupported v1 manifest schemaVersion: ${String(manifest.schemaVersion)}` };
    if (manifest.topic !== topic && manifest.initiativeId !== topic) return { paths, prefixes, error: `ambiguous topic ownership; expected ${topic}` };
    const required = [manifest.activeSpec?.path, manifest.activePlan?.path, manifest.activePlan?.contractRoot];
    if (required.some((value) => typeof value !== "string")) return { paths, prefixes, error: "incomplete authority: active spec, plan, and contract root are required" };
    const declaredHashes = new Map<string, string>();
    if (typeof manifest.activeSpec?.contentHash === "string") declaredHashes.set(manifest.activeSpec.path, manifest.activeSpec.contentHash);
    if (typeof manifest.activePlan?.contentHash === "string") declaredHashes.set(manifest.activePlan.path, manifest.activePlan.contentHash);
    const contractRoot = String(manifest.activePlan.contractRoot).replace(/\/+$/, "");
    const contractIndex = `${contractRoot}/contracts.json`;
    required.slice(0, 2).forEach((value) => paths.push(value));
    paths.push(contractIndex);
    prefixes.push(`${contractRoot}/`);
    for (const candidate of paths) {
      if (!belongsToLegacyTopic(candidate, topic) || !sources.has(candidate)) return { paths, prefixes, error: `incomplete or cross-topic authority path: ${candidate}` };
    }
    const index = JSON.parse(readFileSync(resolveProjectPath(root, contractIndex), "utf8")) as Record<string, any>;
    if (!Array.isArray(index.contracts)) return { paths, prefixes, error: "unsupported contracts index: contracts must be an array" };
    for (const contract of index.contracts) {
      if (typeof contract?.path === "string") paths.push(contract.path);
      if (typeof contract?.path === "string" && typeof contract?.contentHash === "string") declaredHashes.set(contract.path, contract.contentHash);
    }
    for (const record of Object.values(index.completionRecords ?? {}) as any[]) {
      for (const candidate of [record?.contractPath, record?.verification?.path, record?.review?.path]) if (typeof candidate === "string") paths.push(candidate);
      if (typeof record?.verification?.path === "string" && typeof record?.verification?.contentHash === "string") declaredHashes.set(record.verification.path, record.verification.contentHash);
      if (typeof record?.review?.path === "string" && typeof record?.review?.contentHash === "string") declaredHashes.set(record.review.path, record.review.contentHash);
    }
    for (const candidate of paths) {
      if (!belongsToLegacyTopic(candidate, topic) || !sources.has(candidate)) return { paths, prefixes, error: `incomplete or cross-topic authority path: ${candidate}` };
      const absolute = resolveProjectPath(root, candidate);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) return { paths, prefixes, error: `unsafe authority path: ${candidate}` };
      const declared = declaredHashes.get(candidate);
      if (declared && hashFile(absolute) !== declared) return { paths, prefixes, error: `stale contentHash for authority path: ${candidate}` };
    }
    return { paths: [...new Set(paths)], prefixes };
  } catch (error) {
    return { paths, prefixes, error: `malformed or unsupported authority: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readManifestAuthority(root: string, file: Discovered, exact: Set<string>, prefixes: string[], diagnostics: string[]): void {
  try {
    const manifest = JSON.parse(readFileSync(file.absolute, "utf8")) as Record<string, any>;
    addPath(exact, manifest.activeSpec?.path);
    addPath(exact, manifest.activePlan?.path);
    addPath(exact, manifest.approval?.reviewPath);
    addPath(exact, manifest.activeContract?.path);
    if (typeof manifest.activePlan?.contractRoot === "string") {
      const contractRoot = manifest.activePlan.contractRoot.replace(/\/+$/, "");
      prefixes.push(`${contractRoot}/`);
      const indexPath = `${contractRoot}/contracts.json`;
      exact.add(indexPath);
      readContractAuthority(root, indexPath, exact, diagnostics);
    }
  } catch (error) {
    diagnostics.push(`${file.source}: malformed canonical manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
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
type ReferenceSnapshot = { sites: Map<string, string[]>; hashes: Map<string, string> };

function discoverReferences(root: string, sources: string[], maxFiles: number, maxBytes: number): ReferenceSnapshot {
  const trie = buildReferenceTrie(sources);
  const found = new Map<string, string[]>();
  const hashes = new Map<string, string>();
  let visited = 0;
  let scannedBytes = 0;
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && SKIP_DIRECTORIES.has(item.name)) continue;
      const absolute = join(directory, item.name);
      const relative = toPosix(projectRelative(root, absolute));
      if (relative === CONFIG_RELATIVE || relative.startsWith(LEGACY_TRANSACTION_PREFIX) || relative.startsWith(SYSTEM_TRANSACTION_PREFIX)) continue;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { visit(absolute); continue; }
      if (!item.isFile() || !TEXT_EXTENSIONS.has(extname(item.name).toLowerCase())) continue;
      visited += 1;
      if (visited > maxFiles) throw new Error(`reference scan file limit exceeded: ${visited} > ${maxFiles}`);
      const stat = lstatSync(absolute);
      scannedBytes += stat.size;
      if (scannedBytes > maxBytes) throw new Error(`reference scan byte limit exceeded: ${scannedBytes} > ${maxBytes}`);
      const bytes = readFileSync(absolute);
      const content = bytes.toString("utf8");
      const matches = [...matchReferences(content, trie)].filter((source) => relative !== source);
      if (matches.length > 0) hashes.set(relative, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      for (const source of matches) {
        const list = found.get(source) ?? [];
        list.push(relative);
        found.set(source, list);
      }
    }
  };
  visit(root);
  for (const refs of found.values()) refs.sort();
  return { sites: found, hashes };
}

function buildReferenceTrie(sources: string[]): ReferenceTrie {
  const root: ReferenceTrie = { children: new Map() };
  for (const source of sources) {
    let node = root;
    for (const character of source) {
      let next = node.children.get(character);
      if (!next) { next = { children: new Map() }; node.children.set(character, next); }
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

function classifyEntry(root: string, file: Discovered, config: MigrationConfig, authority: Authority, references: ReferenceSnapshot): ArtifactInventoryEntry {
  if (file.symlink) return base(file, "invalid", ["symlink-not-followed"]);
  if (!file.regular) return base(file, "invalid", ["unsupported-filesystem-entry"]);
  const referenceSites = references.sites.get(file.source) ?? [];
  const referenceSiteHashes = Object.fromEntries(referenceSites.map((site) => [site, references.hashes.get(site)!]));
  const withReferences = <T extends ArtifactInventoryEntry>(entry: T): T => ({ ...entry, referenceSites, referenceSiteHashes } as T);
  const v2 = parseV2Canonical(file.source);
  if (v2) {
    const protectedByAuthority = authority.exact.has(file.source) || authority.prefixes.some((prefix) => file.source.startsWith(prefix));
    return withReferences({ ...hashed(file, protectedByAuthority ? "protected" : "canonical-valid", [protectedByAuthority ? "canonical-authority" : "canonical-path"]), topic: v2.topic, authorityUnit: v2.unit });
  }
  if (file.source.startsWith(".model-artifacts/initiatives/") || file.source.startsWith(".model-artifacts/system/")) {
    return withReferences({ ...hashed(file, "invalid", ["invalid-layout-v2-path"]) });
  }
  const topic = [...authority.completeV1Topics, ...authority.mixedTopics]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .find((candidate) => belongsToLegacyTopic(file.source, candidate));
  if (topic && authority.mixedTopics.has(topic)) return withReferences({ ...hashed(file, "protected", ["mixed-authority"]), topic, authorityUnit: "initiative" });
  if (topic && authority.completeV1Topics.has(topic)) {
    if (![".md", ".json"].includes(extname(file.source).toLowerCase())) return withReferences({ ...hashed(file, "invalid", ["unsupported-artifact-type"]), topic, authorityUnit: "initiative" });
    const destination = relocateLegacyTopic(file.source, topic);
    if (!destination) return withReferences({ ...hashed(file, "invalid", ["unsupported-artifact-type"]), topic, authorityUnit: "initiative" });
    return withReferences({ ...hashed(file, "legacy-movable", ["complete-topic-authority"]), destination, topic, authorityUnit: "initiative" });
  }
  if (file.source.startsWith(LEGACY_TRANSACTION_PREFIX)) {
    return withReferences({ ...hashed(file, "legacy-movable", ["system-record"]), destination: file.source.replace(LEGACY_TRANSACTION_PREFIX, SYSTEM_TRANSACTION_PREFIX), authorityUnit: "system" });
  }
  const protectedByAuthority = authority.exact.has(file.source) || authority.prefixes.some((prefix) => file.source.startsWith(prefix));
  if (protectedByAuthority) return withReferences({ ...hashed(file, "protected", ["canonical-authority"]), topic });
  if (extname(file.source).toLowerCase() !== ".md") return base(file, "invalid", ["unsupported-artifact-type"]);
  if (referenceSites.length) return withReferences({ ...hashed(file, "protected", referenceSites.map((source) => `inbound-reference:${source}`)) });
  const mapping = config.mappings[file.source] ?? inferMapping(root, file);
  if (!mapping) return hashed(file, "ambiguous", ["mapping-required"]);
  const destination = `.model-artifacts/initiatives/${mapping.topic}/${mapping.kind}/${mapping.timestamp}-${mapping.shortName}.md`;
  return withReferences({ ...hashed(file, "legacy-movable", [config.mappings[file.source] ? "explicit-mapping" : "deterministic-inference"]), destination, topic: mapping.topic, authorityUnit: "isolated" });
}

function parseV2Canonical(source: string): { topic?: string; unit: "initiative" | "system" } | undefined {
  const parts = source.split("/");
  if (parts[0] !== ".model-artifacts") return undefined;
  const stable = source.match(/^\.model-artifacts\/initiatives\/(.+)\/(?:specs\/manifest\.json|plans\/revisions\/r[1-9]\d*\/(?:contracts\.json|phases\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9.-]*\.md))$/);
  if (stable?.[1] && isCanonicalTopic(stable[1])) return { topic: stable[1], unit: "initiative" };
  if (parts[1] === "initiatives" && parts.length >= 5 && parts.slice(2, -2).every((segment) => normalizeSegment(segment) === segment && segment.length > 0)
    && isArtifactKind(parts.at(-2)) && CANONICAL_FILE_PATTERN.test(parts.at(-1) ?? "")) return { topic: parts.slice(2, -2).join("/"), unit: "initiative" };
  if (parts[1] === "system" && parts.length >= 4 && (parts[2] === "logs" || parts[2] === "reports")
    && (CANONICAL_FILE_PATTERN.test(parts.at(-1) ?? "") || source.startsWith(SYSTEM_TRANSACTION_PREFIX))) return { unit: "system" };
  return undefined;
}

function isCanonicalTopic(value: string): boolean {
  try { return validateTopic(value) === value; } catch { return false; }
}

function belongsToLegacyTopic(source: string, topic: string): boolean {
  const parts = source.split("/");
  if (parts[0] !== ".model-artifacts" || !isArtifactKind(parts[1])) return false;
  const topicParts = topic.split("/");
  return parts.slice(2, 2 + topicParts.length).join("/") === topic && parts.length > 2 + topicParts.length;
}

function relocateLegacyTopic(source: string, topic: string): string | undefined {
  const parts = source.split("/");
  const kind = parts[1];
  const topicParts = topic.split("/");
  if (!isArtifactKind(kind) || parts.slice(2, 2 + topicParts.length).join("/") !== topic) return undefined;
  const rest = parts.slice(2 + topicParts.length);
  if (!rest.length) return undefined;
  return [".model-artifacts", "initiatives", ...topicParts, kind, ...rest].join("/");
}

function inferMapping(root: string, file: Discovered): MigrationMapping | undefined {
  const parts = file.source.split("/");
  const kind = isArtifactKind(parts[1]) ? parts[1] : undefined;
  const content = readFileSync(file.absolute, "utf8").slice(0, 64 * 1024);
  const topicMatch = content.match(/^Topic:\s*`?([^`\s]+)`?\s*$/mi);
  const topic = topicMatch ? safeTopic(topicMatch[1]) : undefined;
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
  } catch { return undefined; }
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
  return { schemaVersion: 1, projectRoot: root, configPath: Object.keys(config.mappings).length ? CONFIG_RELATIVE : null, entries: [], totals: { "canonical-valid": 0, "legacy-movable": 0, protected: 0, ambiguous: 0, invalid: 0 }, fileCount: 0, candidateBytes: 0, diagnostics: [] };
}
