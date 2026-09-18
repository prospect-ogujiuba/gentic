import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { loadWorkflow, saveWorkflow, withWorkflowMutationLock, workflowPath } from "./store.ts";
import { isValidTopic, parseWorkflow, type Workflow } from "./workflow.ts";
import {
  archivedReceiptPath,
  canonicalReceiptPath,
  migrationPlanHash,
  parseGate1Authorization,
  parseSweMigrationJournal,
  parseSweMigrationReceipt,
  receiptEquals,
  stableJson,
  type Gate1Authorization,
  type SweMigrationJournal,
  type SweMigrationReceipt,
  type SweMigrationReceiptV2,
} from "../../../src/swe-migration-record.ts";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_REPORT_BYTES = 256 * 1024;
const DEFAULT_MAX_TOPICS = 100;
const DEFAULT_MAX_DIRECTORIES = 1_000;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_ENTRIES_PER_DIRECTORY = 1_000;
const HARD_MAX_FILE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_FILES = 100_000;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const HARD_MAX_REPORT_BYTES = 1024 * 1024;
const HARD_MAX_TOPICS = 1_000;
const HARD_MAX_DIRECTORIES = 10_000;
const HARD_MAX_DEPTH = 64;
const HARD_MAX_ENTRIES_PER_DIRECTORY = 10_000;
const SENSITIVE_METADATA = /(?:api[-_]?key|credential|password|secret|token)/i;

export type WorkflowMigrationClassification =
  | "native-v1"
  | "native-v1-complete"
  | "current-v2"
  | "current-v2-complete"
  | "historical-contracts"
  | "historical-contracts-complete"
  | "kind-first-artifacts"
  | "layout-conflict"
  | "malformed"
  | "unsupported-workflow"
  | "unsupported-topic";

export type WorkflowMigrationAction =
  | "migrate-native-v1"
  | "decide-completed-workflow"
  | "import-historical"
  | "run-pi-artifacts-migration"
  | "none"
  | "block";

export type WorkflowMigrationBlocker =
  | "canonical-and-kind-first-layouts"
  | "canonical-workflow-and-historical-manifest"
  | "invalid-topic"
  | "malformed-historical-contracts"
  | "malformed-workflow"
  | "topic-mismatch"
  | "unsupported-manifest-version"
  | "unsupported-workflow-version"
  | "live-workflow-authority"
  | "unknown-workflow-ownership"
  | "controlling-workflow-excluded";

export type WorkflowMigrationInventoryEntry = {
  topic: string;
  classification: WorkflowMigrationClassification;
  action: WorkflowMigrationAction;
  sourcePaths: string[];
  contentHash?: string;
  blocker?: WorkflowMigrationBlocker;
  guidance?: string;
};

export type WorkflowMigrationAuditRow = {
  topic: string;
  classification: WorkflowMigrationClassification;
  action: WorkflowMigrationAction;
  storedVersion: number | null;
  state: string;
  ownership: "inactive" | "live" | "unknown" | "controlling-excluded";
  contentHash: string | null;
  blocker: WorkflowMigrationBlocker | null;
  proposedDisposition: "continue" | "operator-review" | "none" | "block" | "excluded";
  controllingExcluded: boolean;
  rollbackEvidencePath: string | null;
  sourcePaths: string[];
};
export type WorkflowMigrationAudit = { schemaVersion: 2; payload: string; hash: string; rows: WorkflowMigrationAuditRow[] };
export type WorkflowMigrationInventory = {
  schemaVersion: 1;
  complete: boolean;
  entries: WorkflowMigrationInventoryEntry[];
  totals: Record<WorkflowMigrationClassification, number>;
  audit: WorkflowMigrationAudit;
};

export type WorkflowMigrationInventoryOptions = {
  maxFileBytes?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxReportBytes?: number;
  maxTopics?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxEntriesPerDirectory?: number;
};

type Bounds = Required<WorkflowMigrationInventoryOptions>;
type Candidate = {
  topic: string;
  workflows: string[];
  manifests: string[];
  kindFirstRoots: Set<string>;
};
type DiscoveredFile = { absolute: string; path: string; bytes: number };

/**
 * Inspect every workflow migration authority without changing repository bytes.
 * The report deliberately contains only classifications, approved paths, and
 * SHA-256 content identities; workflow payloads and parser details never leave
 * this trust boundary.
 */
export function inventoryWorkflowMigrations(cwd: string, options: WorkflowMigrationInventoryOptions = {}): WorkflowMigrationInventory {
  const bounds = normalizeBounds(options);
  const requestedRoot = resolve(cwd);
  const root = realpathSync(requestedRoot);
  const artifactRoot = resolve(root, ".model-artifacts");
  if (!existsSync(artifactRoot)) return emptyInventory();
  const artifactStat = lstatSync(artifactRoot);
  if (artifactStat.isSymbolicLink() || !artifactStat.isDirectory()) throw new Error("workflow inventory root must be a non-symlink directory");
  if (realpathSync(artifactRoot) !== artifactRoot) throw new Error("workflow inventory root has symlinked ancestry");

  const files = walkArtifacts(root, artifactRoot, bounds);
  const candidates = discoverCandidates(files);
  if (candidates.size > bounds.maxTopics) throw new Error(`workflow inventory topic limit exceeded: ${candidates.size} > ${bounds.maxTopics}`);

  const entries = [...candidates.values()]
    .map((candidate) => classifyCandidate(root, candidate, bounds))
    .sort((a, b) => a.topic.localeCompare(b.topic));
  const totals = emptyTotals();
  for (const entry of entries) totals[entry.classification] += 1;
  const audit = buildWorkflowMigrationAudit(root, entries, bounds.maxFileBytes);
  const report: WorkflowMigrationInventory = {
    schemaVersion: 1,
    complete: audit.rows.every((row) => row.action === "none" || row.controllingExcluded),
    entries,
    totals,
    audit,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > bounds.maxReportBytes) throw new Error(`workflow inventory report byte limit exceeded: ${bounds.maxReportBytes}`);
  return report;
}

function walkArtifacts(root: string, artifactRoot: string, bounds: Bounds): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  let directories = 0;
  let bytes = 0;
  const visit = (directory: string, depth: number): void => {
    assertSafeAbsolute(root, directory);
    directories += 1;
    if (directories > bounds.maxDirectories) throw new Error(`workflow inventory directory limit exceeded: ${directories} > ${bounds.maxDirectories}`);
    if (depth > bounds.maxDepth) throw new Error(`workflow inventory depth limit exceeded: ${depth} > ${bounds.maxDepth}`);
    for (const entry of readDirectory(directory, bounds.maxEntriesPerDirectory)) {
      const absolute = resolve(directory, entry.name);
      const path = toPosix(relative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`workflow inventory rejects symlinked ancestry: ${path}`);
      if (stat.isDirectory()) visit(absolute, depth + 1);
      else if (stat.isFile()) {
        if (isMigrationAuthorityPath(path) && stat.size > bounds.maxFileBytes) throw new Error(`workflow inventory file byte limit exceeded: ${path}`);
        files.push({ absolute, path, bytes: stat.size });
        bytes += stat.size;
        if (files.length > bounds.maxFiles) throw new Error(`workflow inventory file limit exceeded: ${files.length} > ${bounds.maxFiles}`);
        if (bytes > bounds.maxBytes) throw new Error(`workflow inventory byte limit exceeded: ${bytes} > ${bounds.maxBytes}`);
      }
    }
  };
  visit(artifactRoot, 0);
  return files;
}

function readDirectory(directory: string, maximum: number): Dirent[] {
  const handle = opendirSync(directory);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entries.length >= maximum) throw new Error(`workflow inventory directory entry limit exceeded: more than ${maximum}`);
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function discoverCandidates(files: DiscoveredFile[]): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  const candidate = (topic: string): Candidate => {
    let found = candidates.get(topic);
    if (!found) {
      found = { topic, workflows: [], manifests: [], kindFirstRoots: new Set() };
      candidates.set(topic, found);
    }
    return found;
  };
  for (const file of files) {
    const workflow = file.path.match(/^\.model-artifacts\/initiatives\/(.+)\/workflow\.json$/);
    if (workflow?.[1]) candidate(workflow[1]).workflows.push(file.absolute);
    const manifest = file.path.match(/^\.model-artifacts\/initiatives\/(.+)\/specs\/manifest\.json$/);
    if (manifest?.[1]) candidate(manifest[1]).manifests.push(file.absolute);
    const kindFirst = file.path.match(/^\.model-artifacts\/(specs|plans|todo|findings|reports|logs)\/(.+)\/[^/]+$/);
    if (kindFirst?.[1] && kindFirst[2]) {
      const topic = kindFirst[2];
      candidate(topic).kindFirstRoots.add(`.model-artifacts/${kindFirst[1]}/${topic}`);
    }
  }
  return candidates;
}

function classifyCandidate(root: string, candidate: Candidate, bounds: Bounds): WorkflowMigrationInventoryEntry {
  const sourcePaths = [
    ...candidate.workflows.map((path) => projectPath(root, path)),
    ...candidate.manifests.map((path) => projectPath(root, path)),
    ...candidate.kindFirstRoots,
  ].sort();
  if (!isValidTopic(candidate.topic)) return blocked(redact(candidate.topic), "unsupported-topic", sourcePaths.map(redact), "invalid-topic");
  const canonical = candidate.workflows.length > 0 || candidate.manifests.length > 0;
  if (canonical && candidate.kindFirstRoots.size) {
    return blocked(candidate.topic, "layout-conflict", sourcePaths, "canonical-and-kind-first-layouts", "Run pi-artifacts audit and migrate the kind-first layout before SWE semantic migration.");
  }
  if (!canonical) {
    return {
      topic: candidate.topic,
      classification: "kind-first-artifacts",
      action: "run-pi-artifacts-migration",
      sourcePaths,
      guidance: "Kind-first relocation is owned by pi-artifacts; run its audit and migration before SWE semantic migration.",
    };
  }
  if (candidate.workflows.length > 1 || candidate.manifests.length > 1) {
    return blocked(candidate.topic, "malformed", sourcePaths, "malformed-workflow");
  }
  if (candidate.workflows.length === 1) {
    return classifyWorkflow(root, candidate, sourcePaths, bounds);
  }
  return classifyHistorical(root, candidate, sourcePaths, bounds);
}

function classifyWorkflow(root: string, candidate: Candidate, sourcePaths: string[], bounds: Bounds): WorkflowMigrationInventoryEntry {
  const path = candidate.workflows[0]!;
  const read = readBoundedJson(root, path, bounds.maxFileBytes);
  if (!read.ok) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-workflow");
  const value = read.value;
  if (!record(value)) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-workflow");
  if (value.version !== 1 && value.version !== 2) return blocked(candidate.topic, "unsupported-workflow", sourcePaths, "unsupported-workflow-version");
  if (value.topic !== candidate.topic) return blocked(candidate.topic, "malformed", sourcePaths, "topic-mismatch");
  try { parseWorkflow(value, "1970-01-01T00:00:00.000Z"); }
  catch { return blocked(candidate.topic, "malformed", sourcePaths, "malformed-workflow"); }

  if (candidate.manifests.length) {
    const imported = record(value.importedFrom) && value.importedFrom.kind === "pi-swe-v2" && value.importedFrom.manifestPath === projectPath(root, candidate.manifests[0]!);
    if (!imported) return blocked(candidate.topic, "layout-conflict", sourcePaths, "canonical-workflow-and-historical-manifest");
  }
  const complete = value.status === "complete";
  if (value.version === 1) {
    return {
      topic: candidate.topic,
      classification: complete ? "native-v1-complete" : "native-v1",
      action: complete ? "decide-completed-workflow" : "migrate-native-v1",
      sourcePaths,
      contentHash: hashFile(root, path, bounds.maxFileBytes),
    };
  }
  return {
    topic: candidate.topic,
    classification: complete ? "current-v2-complete" : "current-v2",
    action: "none",
    sourcePaths,
    contentHash: hashFile(root, path, bounds.maxFileBytes),
  };
}

function classifyHistorical(root: string, candidate: Candidate, sourcePaths: string[], bounds: Bounds): WorkflowMigrationInventoryEntry {
  const manifestPath = candidate.manifests[0]!;
  const read = readBoundedJson(root, manifestPath, bounds.maxFileBytes);
  if (!read.ok || !record(read.value)) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts");
  const manifest = read.value;
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) return blocked(candidate.topic, "unsupported-workflow", sourcePaths, "unsupported-manifest-version");
  if ((typeof manifest.topic === "string" || typeof manifest.initiativeId === "string") && manifest.topic !== candidate.topic && manifest.initiativeId !== candidate.topic) return blocked(candidate.topic, "malformed", sourcePaths, "topic-mismatch");
  const activePlan = record(manifest.activePlan) ? manifest.activePlan : undefined;
  const contractRoot = typeof activePlan?.contractRoot === "string" ? activePlan.contractRoot : undefined;
  const expected = `.model-artifacts/initiatives/${candidate.topic}/plans/revisions/`;
  if (!contractRoot || !contractRoot.startsWith(expected) || !/^r[1-9][0-9]*$/.test(contractRoot.slice(expected.length))) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts");
  const contractPath = safeProjectPath(root, `${contractRoot}/contracts.json`);
  if (!existsSync(contractPath)) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts");
  const contracts = readBoundedJson(root, contractPath, bounds.maxFileBytes);
  if (!contracts.ok || !record(contracts.value) || !Array.isArray(contracts.value.contracts)) return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts");

  let located;
  try { located = loadWorkflow(root, candidate.topic, true); }
  catch { return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts"); }
  if (!located || located.kind !== "legacy") return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts");
  const planPath = typeof activePlan?.path === "string" ? safeProjectPath(root, activePlan.path) : undefined;
  const inputs = [
    manifestPath,
    contractPath,
    ...(planPath && existsSync(planPath) ? [planPath] : []),
    ...contracts.value.contracts.filter(record).flatMap((item) => typeof item.path === "string" ? [safeProjectPath(root, item.path)] : typeof item.canonicalPath === "string" ? [safeProjectPath(root, item.canonicalPath)] : []),
  ];
  const uniqueInputs = [...new Set(inputs)].sort();
  try { for (const path of uniqueInputs) readBounded(root, path, bounds.maxFileBytes); }
  catch { return blocked(candidate.topic, "malformed", sourcePaths, "malformed-historical-contracts"); }
  const complete = located.workflow.status === "complete";
  return {
    topic: candidate.topic,
    classification: complete ? "historical-contracts-complete" : "historical-contracts",
    action: complete ? "decide-completed-workflow" : "import-historical",
    sourcePaths: [...new Set([...sourcePaths, ...uniqueInputs.map((path) => projectPath(root, path))])].sort(),
    contentHash: hashAuthority(root, uniqueInputs, bounds.maxFileBytes),
  };
}

function readBoundedJson(root: string, path: string, maximum: number): { ok: true; value: unknown } | { ok: false } {
  try {
    const raw = readBounded(root, path, maximum);
    return { ok: true, value: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

function hashFile(root: string, path: string, maximum: number): string {
  return `sha256:${createHash("sha256").update(readBounded(root, path, maximum)).digest("hex")}`;
}

function hashAuthority(root: string, paths: string[], maximum: number): string {
  const hash = createHash("sha256");
  for (const path of paths) hash.update(projectPath(root, path)).update("\0").update(hashFile(root, path, maximum)).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function readBounded(root: string, path: string, maximum: number): Buffer {
  assertSafeAbsolute(root, path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) throw new Error(`workflow inventory file byte limit exceeded: ${path}`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const nonBlock = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximum) throw new Error(`workflow inventory file byte limit exceeded: ${path}`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw new Error(`workflow inventory file changed while reading: ${path}`);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function isMigrationAuthorityPath(path: string): boolean {
  return /\/workflow\.json$/.test(path) || /\/specs\/manifest\.json$/.test(path) || /\/contracts\.json$/.test(path);
}

function safeProjectPath(root: string, path: string): string {
  if (path.includes("\\")) throw new Error("unsafe workflow inventory path");
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("workflow inventory path escapes repository");
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("workflow inventory path traverses a symlink");
  }
  return absolute;
}

function blocked(topic: string, classification: WorkflowMigrationClassification, sourcePaths: string[], blocker: WorkflowMigrationBlocker, guidance?: string): WorkflowMigrationInventoryEntry {
  return { topic, classification, action: "block", sourcePaths, blocker, ...(guidance ? { guidance } : {}) };
}

function normalizeBounds(options: WorkflowMigrationInventoryOptions): Bounds {
  return {
    maxFileBytes: bound(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, "maxFileBytes"),
    maxFiles: bound(options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES, "maxFiles"),
    maxBytes: bound(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES, "maxBytes"),
    maxReportBytes: bound(options.maxReportBytes, DEFAULT_MAX_REPORT_BYTES, HARD_MAX_REPORT_BYTES, "maxReportBytes"),
    maxTopics: bound(options.maxTopics, DEFAULT_MAX_TOPICS, HARD_MAX_TOPICS, "maxTopics"),
    maxDirectories: bound(options.maxDirectories, DEFAULT_MAX_DIRECTORIES, HARD_MAX_DIRECTORIES, "maxDirectories"),
    maxDepth: bound(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH, "maxDepth"),
    maxEntriesPerDirectory: bound(options.maxEntriesPerDirectory, DEFAULT_MAX_ENTRIES_PER_DIRECTORY, HARD_MAX_ENTRIES_PER_DIRECTORY, "maxEntriesPerDirectory"),
  };
}

function bound(value: number | undefined, fallback: number, hardMaximum: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > hardMaximum) throw new Error(`${label} must be an integer between 1 and ${hardMaximum}`);
  return normalized;
}

function buildWorkflowMigrationAudit(root: string, entries: WorkflowMigrationInventoryEntry[], maximum: number): WorkflowMigrationAudit {
  const rows = entries.map((entry): WorkflowMigrationAuditRow => {
    let storedVersion: number | null = null;
    let state = "unknown";
    let ownership: WorkflowMigrationAuditRow["ownership"] = "unknown";
    const authorityPath = entry.sourcePaths.find((path) => /\/(?:workflow|manifest)\.json$/.test(path));
    if (authorityPath) {
      const read = readBoundedJson(root, safeProjectPath(root, authorityPath), maximum);
      if (read.ok && record(read.value)) {
        const version = read.value.version ?? read.value.schemaVersion;
        storedVersion = Number.isSafeInteger(version) ? version as number : null;
        state = typeof read.value.status === "string" && ["draft", "paused", "active", "blocked", "complete"].includes(read.value.status) ? read.value.status : "unknown";
        try {
          const located = loadWorkflow(root, entry.topic, true);
          ownership = located && hasLiveWorkflowAuthority(read.value, located.workflow) ? "live" : located ? "inactive" : "unknown";
        } catch { ownership = "unknown"; }
      }
    }
    const controllingExcluded = entry.topic === "swe-production-rollout";
    if (controllingExcluded) ownership = "controlling-excluded";
    const completed = entry.classification === "native-v1-complete" || entry.classification === "historical-contracts-complete";
    const migratable = ["native-v1", "native-v1-complete", "historical-contracts", "historical-contracts-complete"].includes(entry.classification);
    const current = entry.classification === "current-v2" || entry.classification === "current-v2-complete";
    const authorityBlocked = ownership === "live" || ownership === "unknown";
    const action: WorkflowMigrationAction = controllingExcluded || authorityBlocked ? "block" : entry.action;
    const blocker: WorkflowMigrationBlocker | null = controllingExcluded ? "controlling-workflow-excluded" : ownership === "live" ? "live-workflow-authority" : ownership === "unknown" ? entry.blocker ?? "unknown-workflow-ownership" : entry.blocker ?? null;
    const proposedDisposition: WorkflowMigrationAuditRow["proposedDisposition"] = controllingExcluded ? "excluded" : authorityBlocked ? "block" : completed ? "operator-review" : migratable ? "continue" : current ? "none" : "block";
    const rollbackEvidencePath = migratable && !controllingExcluded ? workflowMigrationReceiptPath(entry.topic) : null;
    return { topic: entry.topic, classification: entry.classification, action, storedVersion, state, ownership, contentHash: entry.contentHash ?? null, blocker, proposedDisposition, controllingExcluded, rollbackEvidencePath, sourcePaths: [...entry.sourcePaths] };
  }).sort((a, b) => a.topic.localeCompare(b.topic));
  const payload = stableJson({ schemaVersion: 2, rows });
  if (Buffer.byteLength(payload) > 128 * 1024) throw new Error("workflow migration audit payload byte limit exceeded: 131072");
  return { schemaVersion: 2, payload, hash: hashBytes(Buffer.from(payload)), rows };
}

function hasLiveWorkflowAuthority(raw: Record<string, unknown>, workflow: Workflow): boolean {
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const rawOrchestration = record(raw.orchestration) ? raw.orchestration : undefined;
  return raw.status === "active"
    || typeof raw.activeTask === "string"
    || rawTasks.some((task) => record(task) && task.status === "active")
    || record(raw.activeRun)
    || record(raw.lease)
    || !!rawOrchestration && (record(rawOrchestration.activeRun) || record(rawOrchestration.lease) || record(rawOrchestration.parent) && rawOrchestration.parent.valid === true)
    || workflow.status === "active"
    || typeof workflow.activeTask === "string"
    || workflow.tasks.some((task) => task.status === "active")
    || !!workflow.orchestration.activeRun
    || workflow.orchestration.parent?.valid === true;
}

function assertMigrationAuditAuthority(topic: string, row: WorkflowMigrationAuditRow | undefined): void {
  if (row?.controllingExcluded) throw new Error(`migration refused: controlling workflow ${topic} is excluded`);
  if (row?.ownership === "live") throw new Error(`migration refused: ${topic} has live workflow authority`);
  if (!row || row.ownership === "unknown") throw new Error(`migration refused: ${topic} workflow ownership is unknown`);
}

export function renderWorkflowMigrationAudit(report: WorkflowMigrationInventory): string {
  const lines = report.audit.rows.slice(0, 100).map((row) => `${row.topic}: ${row.classification}; ownership=${row.ownership}; action=${row.action}; next=${row.proposedDisposition}`);
  return `migration audit (${report.audit.rows.length} topics)\naudit schema: ${report.audit.schemaVersion}\naudit hash: ${report.audit.hash}\naudit payload: ${report.audit.payload}\n${lines.join("\n") || "no workflow migration candidates"}`;
}

function emptyInventory(): WorkflowMigrationInventory {
  const rows: WorkflowMigrationAuditRow[] = [];
  const payload = stableJson({ schemaVersion: 2, rows });
  return { schemaVersion: 1, complete: true, entries: [], totals: emptyTotals(), audit: { schemaVersion: 2, payload, hash: hashBytes(Buffer.from(payload)), rows } };
}

function emptyTotals(): Record<WorkflowMigrationClassification, number> {
  return {
    "native-v1": 0,
    "native-v1-complete": 0,
    "current-v2": 0,
    "current-v2-complete": 0,
    "historical-contracts": 0,
    "historical-contracts-complete": 0,
    "kind-first-artifacts": 0,
    "layout-conflict": 0,
    malformed: 0,
    "unsupported-workflow": 0,
    "unsupported-topic": 0,
  };
}

function assertSafeAbsolute(root: string, absolute: string): void {
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("workflow inventory path escapes repository");
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("workflow inventory path traverses a symlink");
  }
  if (existsSync(absolute) && lstatSync(absolute).isDirectory() && realpathSync(absolute) !== absolute) throw new Error("workflow inventory directory has symlinked ancestry");
}
export type WorkflowMigrationDisposition = "continue" | "reopen" | "grandfather-read-only" | "operator-review";
export type WorkflowMigrationPlan = {
  schemaVersion: 2;
  topic: string;
  classification: WorkflowMigrationClassification;
  disposition: WorkflowMigrationDisposition;
  generatedAt: string;
  sourcePaths: string[];
  preimageHash: string;
  postimageHash?: string;
  postimage?: string;
  eligible: boolean;
  authorization: Gate1Authorization;
  nextAction: string;
  planHash: string;
};
export type WorkflowMigrationReceipt = SweMigrationReceipt;
export type WorkflowMigrationAuthorization = Gate1Authorization;
export type WorkflowMigrationFaultStage = "before-archive" | "archive-written" | "journal-prepared" | "canonical-removed" | "workflow-written" | "receipt-written" | "before-file-fsync" | "before-exclusive-publish" | "exclusive-published" | "before-directory-fsync" | "before-unlink";
type WorkflowMigrationFault = (stage: WorkflowMigrationFaultStage, path?: string) => void;

/** Build an executable, preimage-bound decision without writing repository state. */
export function planWorkflowMigration(cwd: string, topic: string, options: { disposition?: WorkflowMigrationDisposition; authorization: Gate1Authorization; now?: string }): WorkflowMigrationPlan {
  const inventory = inventoryWorkflowMigrations(cwd);
  const auditRow = inventory.audit.rows.find((candidate) => candidate.topic === topic);
  assertMigrationAuditAuthority(topic, auditRow);
  if (options.authorization.auditHash !== inventory.audit.hash) throw new Error(`migration authorization audit hash mismatch: expected ${inventory.audit.hash}`);
  const entry = inventory.entries.find((candidate) => candidate.topic === topic);
  if (!entry) throw new Error(`workflow ${topic} was not found in migration inventory`);
  const complete = entry.classification === "native-v1-complete" || entry.classification === "historical-contracts-complete";
  const disposition = options.disposition ?? (complete ? "operator-review" : "continue");
  const authorization = parseGate1Authorization(options.authorization);
  const decidedBy = authorization.authorizedBy;
  if (complete && !["reopen", "grandfather-read-only", "operator-review"].includes(disposition)) throw new Error("completed workflows require reopen, grandfather-read-only, or operator-review disposition");
  if (!complete && disposition !== "continue") throw new Error("incomplete workflows use the continue disposition");
  const migratable = ["native-v1", "native-v1-complete", "historical-contracts", "historical-contracts-complete"].includes(entry.classification);
  const eligible = migratable && disposition !== "operator-review";
  const preimageHash = entry.contentHash ?? `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`;
  let postimage: string | undefined;
  let postimageHash: string | undefined;
  const generatedAt = options.now ?? authorization.authorizedAt;
  if (generatedAt !== authorization.authorizedAt) throw new Error("migration plan time must equal the explicit authorization timestamp");
  if (authorization.topicDispositions[topic] !== disposition) throw new Error("migration authorization does not exactly cover the selected topic and disposition");
  if (eligible) {
    const located = loadWorkflow(cwd, topic, true);
    if (!located) throw new Error(`workflow ${topic} was not found`);
    const now = generatedAt;
    const historicalTaskIds = located.workflow.tasks.filter((task) => task.status === "complete" || task.status === "deferred").map((task) => task.id);
    const history = [...located.workflow.orchestration.history, {
      id: `migration-${createHash("sha256").update(`${topic}\0${preimageHash}`).digest("hex").slice(0, 16)}`,
      type: "workflow-migrated",
      at: now,
      summary: `${entry.classification} migrated with ${disposition} disposition by ${decidedBy}`,
      auditCritical: true,
    }].slice(-128);
    const tasks = located.workflow.tasks.map((task) => task.status === "complete" || task.status === "deferred"
      ? { ...task, phase: "historical" as const }
      : { ...task, status: task.status === "blocked" ? "blocked" as const : "pending" as const, phase: "pending" as const, evidence: [], reports: [], clarifications: [], findings: [], verificationCheckpoint: undefined, workspaceReceipt: undefined, integrationReceipt: undefined, verificationDriftPaths: [] });
    const candidate: Workflow = {
      ...located.workflow,
      version: 2,
      revision: located.workflow.revision + 1,
      status: disposition === "grandfather-read-only" ? "paused" : "paused",
      activeTask: undefined,
      planReview: undefined,
      closeout: undefined,
      initiativeAcceptance: undefined,
      orchestration: { ...located.workflow.orchestration, mode: "multi-agent", phase: disposition === "reopen" && historicalTaskIds.length === tasks.length ? "initiative-acceptance" : "plan-review", activeRun: undefined, parent: undefined, history },
      tasks,
      updatedAt: now,
      migration: { sourceVersion: 1, readAt: now, historicalTaskIds, disposition, decidedBy, preimageHash },
    };
    postimage = `${JSON.stringify(parseWorkflow(candidate, now), null, 2)}\n`;
    postimageHash = hashBytes(Buffer.from(postimage));
  }
  const logical = { schemaVersion: 2 as const, topic, classification: entry.classification as import("../../../src/swe-migration-record.ts").MigratableClassification, disposition: disposition as Exclude<WorkflowMigrationDisposition, "operator-review">, generatedAt, sourcePaths: entry.sourcePaths, preimageHash, postimageHash: postimageHash ?? null, eligible, authorization };
  const planHash = migrationPlanHash(logical);
  return {
    schemaVersion: 2, topic, classification: entry.classification, disposition, generatedAt, sourcePaths: entry.sourcePaths,
    preimageHash, ...(postimageHash ? { postimageHash } : {}), ...(postimage ? { postimage } : {}), eligible,
    authorization,
    nextAction: eligible ? `apply selected topic ${topic}` : entry.action === "block" ? entry.guidance ?? `resolve ${entry.blocker ?? "migration blocker"}` : "record an authorized historical-completion disposition",
    planHash,
  };
}

/** Apply exactly one validated dry-run plan under the shared workflow mutation lock. */
export async function applyWorkflowMigration(cwd: string, plan: WorkflowMigrationPlan, options: { fault?: WorkflowMigrationFault } = {}): Promise<{ status: "applied" | "already-applied"; receiptPath: string; receipt: WorkflowMigrationReceipt }> {
  validateMigrationPlan(plan);
  if (!plan.eligible || !plan.postimage || !plan.postimageHash || plan.disposition === "operator-review") throw new Error(`migration plan is not eligible: ${plan.nextAction}`);
  const postimage = plan.postimage;
  const postimageHash = plan.postimageHash;
  const disposition = plan.disposition as Exclude<WorkflowMigrationDisposition, "operator-review">;
  return withWorkflowMutationLock(cwd, plan.topic, async () => {
    assertNoArtifactMigrationActivity(cwd);
    assertMigrationAuditAuthority(plan.topic, inventoryWorkflowMigrations(cwd).audit.rows.find((candidate) => candidate.topic === plan.topic));
    const receiptPath = workflowMigrationReceiptPath(plan.topic);
    const receiptAbsolute = resolve(cwd, receiptPath);
    if (Date.parse(plan.authorization.rollbackRetentionUntil) < Date.now()) throw new Error("migration authorization rollback retention has expired");
    let rolledBackReceipt: WorkflowMigrationReceipt | undefined;
    if (existsSync(receiptAbsolute)) {
      const receipt = readMigrationReceipt(resolve(cwd), receiptAbsolute);
      const current = currentWorkflowHash(cwd, plan.topic);
      if (receipt.schemaVersion === 2 && receipt.planHash === plan.planHash && receipt.postimageHash === plan.postimageHash && receipt.state === "applied" && current === receipt.postimageHash) return { status: "already-applied", receiptPath, receipt };
      if (receipt.state !== "rolled-back") throw new Error("migration receipt requires rollback or operator recovery before reuse");
      if (receipt.schemaVersion === 1) validateLegacyPlanIdentity(receipt, plan.generatedAt, plan.postimageHash);
      rolledBackReceipt = receipt;
    }
    const expectedPlan = planWorkflowMigration(cwd, plan.topic, { disposition, authorization: plan.authorization, now: plan.generatedAt });
    if (expectedPlan.planHash !== plan.planHash || expectedPlan.postimageHash !== postimageHash || expectedPlan.postimage !== postimage) throw new Error("stale migration plan: workflow no longer matches the deterministic dry-run decision");
    const currentEntry = inventoryWorkflowMigrations(cwd).entries.find((entry) => entry.topic === plan.topic);
    if (!currentEntry || currentEntry.classification !== plan.classification || currentEntry.contentHash !== plan.preimageHash) throw new Error("stale migration plan: preimage or classification changed");
    const nativePath = resolve(cwd, workflowPath(plan.topic));
    const preimagePayload = existsSync(nativePath) ? readBounded(resolve(cwd), nativePath, DEFAULT_MAX_FILE_BYTES).toString("base64") : undefined;
    const journalPath = workflowMigrationJournalPath(plan.topic);
    const journalAbsolute = resolve(cwd, journalPath);
    if (existsSync(journalAbsolute)) throw new Error(`unfinished SWE migration requires recovery: ${journalPath}`);
    const receipt: SweMigrationReceiptV2 = {
      schemaVersion: 2, topic: plan.topic, state: "applied", classification: plan.classification as SweMigrationReceiptV2["classification"],
      disposition, generatedAt: plan.generatedAt, sourcePaths: plan.sourcePaths,
      preimageHash: plan.preimageHash, postimageHash, eligible: true, authorization: plan.authorization, planHash: plan.planHash,
      appliedAt: new Date().toISOString(), preimagePayload: preimagePayload ?? null,
    };
    parseSweMigrationReceipt(receipt, { path: receiptPath });
    if (rolledBackReceipt) {
      options.fault?.("before-archive");
      const archivePath = archivedReceiptPath(rolledBackReceipt);
      const archiveAbsolute = resolve(cwd, archivePath);
      if (existsSync(archiveAbsolute)) {
        const archived = readMigrationReceipt(resolve(cwd), archiveAbsolute);
        if (!receiptEquals(archived, rolledBackReceipt)) throw new Error("retained migration attempt does not exactly match the rolled-back receipt");
      } else writeJsonExclusive(archiveAbsolute, rolledBackReceipt, options.fault);
      options.fault?.("archive-written");
    }
    writeJsonExclusive(journalAbsolute, { schemaVersion: 2, operation: "apply", stage: "prepared", planHash: plan.planHash, topic: plan.topic, preimageHash: plan.preimageHash, postimageHash: plan.postimageHash, receipt, ...(rolledBackReceipt ? { priorReceipt: rolledBackReceipt } : {}) }, options.fault);
    options.fault?.("journal-prepared");
    if (rolledBackReceipt) {
      const observed = readMigrationReceipt(resolve(cwd), receiptAbsolute);
      if (!receiptEquals(observed, rolledBackReceipt)) throw new Error("canonical rolled-back receipt changed before reapply publication");
      removeFileDurable(receiptAbsolute, options.fault);
      options.fault?.("canonical-removed");
    }
    const parsed = parseWorkflow(JSON.parse(postimage));
    saveWorkflow(cwd, parsed, existsSync(nativePath) ? loadWorkflow(cwd, plan.topic, false)?.workflow.revision : undefined);
    if (currentWorkflowHash(cwd, plan.topic) !== postimageHash) throw new Error("workflow postimage hash mismatch after atomic write");
    options.fault?.("workflow-written");
    writeJsonExclusive(receiptAbsolute, receipt, options.fault);
    options.fault?.("receipt-written");
    removeFileDurable(journalAbsolute, options.fault);
    return { status: "applied", receiptPath, receipt };
  });
}

export async function applyWorkflowMigrationBatch(cwd: string, plans: WorkflowMigrationPlan[]): Promise<Array<{ topic: string; status: "applied" | "already-applied" | "failed"; receiptPath?: string; error?: string }>> {
  if (!plans.length) throw new Error("batch migration requires at least one explicitly selected topic");
  const topics = plans.map((plan) => plan.topic);
  if (new Set(topics).size !== topics.length) throw new Error("batch migration selections must name unique topics");
  const results = [];
  for (const plan of plans) {
    try {
      const applied = await applyWorkflowMigration(cwd, plan);
      results.push({ topic: plan.topic, status: applied.status, receiptPath: applied.receiptPath });
    } catch (error) {
      results.push({ topic: plan.topic, status: "failed" as const, error: error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024) });
    }
  }
  return results;
}

export async function recoverWorkflowMigration(cwd: string, topic: string): Promise<{ status: "recovered" | "already-recovered"; nextAction: string }> {
  return withWorkflowMutationLock(cwd, topic, async () => {
    const journalAbsolute = resolve(cwd, workflowMigrationJournalPath(topic));
    const receiptAbsolute = resolve(cwd, workflowMigrationReceiptPath(topic));
    cleanupRecoveryTemporaryFiles(dirname(journalAbsolute));
    if (!existsSync(journalAbsolute)) {
      if (!existsSync(receiptAbsolute)) throw new Error(`no SWE migration recovery record exists for ${topic}`);
      const receipt = readMigrationReceipt(resolve(cwd), receiptAbsolute);
      const current = currentWorkflowHash(cwd, topic);
      if (receipt.state === "applied") {
        if (current !== receipt.postimageHash) throw new Error("recovery refused: applied receipt does not match the exact workflow postimage");
        if (receipt.schemaVersion === 1) validateLegacyPlanIdentity(receipt, legacyGeneratedAt(cwd, topic), receipt.postimageHash);
        return { status: "already-recovered", nextAction: "migration is applied; re-audit or perform an authenticated rollback" };
      }
      const preimage = receipt.preimagePayload ? Buffer.from(receipt.preimagePayload, "base64") : undefined;
      if (preimage ? current !== receipt.preimageHash : current !== undefined) throw new Error("recovery refused: rolled-back receipt does not match the exact workflow preimage");
      return { status: "already-recovered", nextAction: "migration is rolled back; create a fresh authorized plan before reapply" };
    }
    const journal = parseSweMigrationJournal(JSON.parse(readBounded(resolve(cwd), journalAbsolute, 1024 * 1024).toString("utf8")), { path: workflowMigrationJournalPath(topic) });
    const current = currentWorkflowHash(cwd, topic);
    assertJournalPriorArchive(resolve(cwd), journal);
    if (current === journal.receipt.postimageHash) {
      if (journal.receipt.schemaVersion === 1) validateLegacyPlanIdentity(journal.receipt, legacyGeneratedAt(cwd, topic), journal.receipt.postimageHash);
      if (existsSync(receiptAbsolute)) {
        const published = readMigrationReceipt(resolve(cwd), receiptAbsolute);
        if (!receiptEquals(published, journal.receipt)) throw new Error("published migration receipt does not exactly match the recovery journal");
      } else writeJsonExclusive(receiptAbsolute, journal.receipt);
      removeFileDurable(journalAbsolute);
      return { status: "recovered", nextAction: "migration committed; re-audit the topic" };
    }
    const payload = journal.receipt.preimagePayload ? Buffer.from(journal.receipt.preimagePayload, "base64") : undefined;
    if (journal.receipt.schemaVersion === 1 && (payload ? current === journal.receipt.preimageHash : current === undefined)) throw new Error("legacy recovery journal cannot authenticate its missing plan timestamp; exact postimage or operator rollback is required");
    if (payload ? current === journal.receipt.preimageHash : current === undefined) {
      if (journal.schemaVersion === 2 && journal.priorReceipt) {
        if (existsSync(receiptAbsolute)) {
          const retained = readMigrationReceipt(resolve(cwd), receiptAbsolute);
          if (!receiptEquals(retained, journal.priorReceipt)) throw new Error("recovery refused: canonical prior receipt does not match the reapply journal");
        }
      } else if (existsSync(receiptAbsolute)) throw new Error("recovery refused: initial apply journal requires canonical receipt absence");
      removeFileDurable(journalAbsolute);
      return { status: "recovered", nextAction: "migration was not published; create a fresh dry-run plan" };
    }
    throw new Error("recovery refused: workflow differs from both exact preimage and postimage");
  });
}

export async function rollbackWorkflowMigration(cwd: string, topic: string): Promise<{ status: "rolled-back" | "already-rolled-back"; receiptPath: string }> {
  return withWorkflowMutationLock(cwd, topic, async () => {
    assertNoArtifactMigrationActivity(cwd);
    const receiptPath = workflowMigrationReceiptPath(topic);
    const receiptAbsolute = resolve(cwd, receiptPath);
    const receipt = readMigrationReceipt(resolve(cwd), receiptAbsolute);
    if (receipt.topic !== topic) throw new Error("workflow migration receipt topic mismatch");
    if (receipt.state === "rolled-back") return { status: "already-rolled-back", receiptPath };
    if (currentWorkflowHash(cwd, topic) !== receipt.postimageHash) throw new Error("rollback refused: workflow has intervening edits after migration");
    if (receipt.schemaVersion === 1) validateLegacyPlanIdentity(receipt, legacyGeneratedAt(cwd, topic), receipt.postimageHash);
    const target = resolve(cwd, workflowPath(topic));
    const preimage = receipt.preimagePayload ? Buffer.from(receipt.preimagePayload, "base64") : undefined;
    if (preimage && (preimage.length > DEFAULT_MAX_FILE_BYTES || hashBytes(preimage) !== receipt.preimageHash)) throw new Error("rollback recovery payload does not match the bounded preimage");
    if (preimage) atomicWriteBytes(target, preimage);
    else removeFileDurable(target);
    const observed = preimage ? hashFile(resolve(cwd), target, DEFAULT_MAX_FILE_BYTES) : undefined;
    if (receipt.preimagePayload && observed !== receipt.preimageHash) throw new Error("rollback preimage hash mismatch");
    const rolledBack = { ...receipt, state: "rolled-back" as const, rolledBackAt: new Date().toISOString() };
    parseSweMigrationReceipt(rolledBack, { path: receiptPath, allowLegacy: true });
    writeJsonAtomic(receiptAbsolute, rolledBack);
    return { status: "rolled-back", receiptPath };
  });
}

export function assertWorkflowMigrationEligible(cwd: string, topic: string): void {
  const located = loadWorkflow(cwd, topic, false);
  if (located?.workflow.migration?.disposition === "grandfather-read-only") throw new Error(`workflow ${topic} is grandfathered read-only history; next action: retain or make a new authorized v2 workflow`);
  if (located?.storedVersion === 2) return;
  const entry = inventoryWorkflowMigrations(cwd).entries.find((candidate) => candidate.topic === topic);
  if (!entry) throw new Error(`workflow ${topic} was not found`);
  throw new Error(`workflow ${topic} requires explicit migration (${entry.classification}); next action: audit, choose a disposition, and apply with preimage validation`);
}

export function workflowMigrationReceiptPath(topic: string): string {
  return canonicalReceiptPath(topic);
}
function workflowMigrationJournalPath(topic: string): string {
  const identity = Buffer.from(topic).toString("base64url");
  return `.model-artifacts/system/logs/pi-swe-migration/${identity}/journal.json`;
}
function validateMigrationPlan(plan: WorkflowMigrationPlan): void {
  if (plan.schemaVersion !== 2 || !isValidTopic(plan.topic) || !/^sha256:[a-f0-9]{64}$/.test(plan.preimageHash) || !/^sha256:[a-f0-9]{64}$/.test(plan.planHash)) throw new Error("invalid workflow migration plan");
  if (typeof plan.generatedAt !== "string" || !Number.isFinite(Date.parse(plan.generatedAt)) || new Date(plan.generatedAt).toISOString() !== plan.generatedAt || plan.sourcePaths.length > 256 || plan.sourcePaths.some((path) => !path.startsWith(".model-artifacts/") || path.includes("\\") || path.split("/").includes(".."))) throw new Error("invalid workflow migration plan metadata");
  const authorization = parseGate1Authorization(plan.authorization);
  if (authorization.authorizedAt !== plan.generatedAt || authorization.topicDispositions[plan.topic] !== plan.disposition) throw new Error("workflow migration plan authorization mismatch");
  const logical = { schemaVersion: 2 as const, topic: plan.topic, classification: plan.classification as import("../../../src/swe-migration-record.ts").MigratableClassification, disposition: plan.disposition as Exclude<WorkflowMigrationDisposition, "operator-review">, generatedAt: plan.generatedAt, sourcePaths: plan.sourcePaths, preimageHash: plan.preimageHash, postimageHash: plan.postimageHash ?? null, eligible: plan.eligible, authorization };
  if (migrationPlanHash(logical) !== plan.planHash) throw new Error("workflow migration plan hash mismatch");
  if (plan.postimage && hashBytes(Buffer.from(plan.postimage)) !== plan.postimageHash) throw new Error("workflow migration plan postimage mismatch");
}
function assertNoArtifactMigrationActivity(cwd: string): void {
  const root = resolve(cwd, ".model-artifacts/system/logs/model-artifact-migration");
  if (!existsSync(root)) return;
  const entries = readDirectory(root, HARD_MAX_ENTRIES_PER_DIRECTORY);
  if (entries.some((entry) => entry.name === "active.claim.json" || /journal\.json$/.test(entry.name) || entry.name.endsWith("-transaction"))) throw new Error("pi-artifacts migration claim, transaction journal, or recovery bundle blocks SWE semantic migration");
}
function currentWorkflowHash(cwd: string, topic: string): string | undefined {
  const path = resolve(cwd, workflowPath(topic));
  return existsSync(path) ? hashFile(resolve(cwd), path, DEFAULT_MAX_FILE_BYTES) : undefined;
}
function readMigrationReceipt(root: string, path: string): WorkflowMigrationReceipt {
  if (!existsSync(path)) throw new Error("workflow migration receipt was not found");
  const relativePath = toPosix(relative(root, path));
  return parseSweMigrationReceipt(JSON.parse(readBounded(root, path, 1024 * 1024).toString("utf8")), { path: relativePath, allowLegacy: true });
}
function writeJsonExclusive(path: string, value: unknown, fault?: WorkflowMigrationFault): void {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (content.length > 1024 * 1024) throw new Error("workflow migration recovery record exceeds 1048576 bytes");
  const directory = dirname(path);
  ensureDurableDirectory(directory);
  cleanupRecoveryTemporaryFiles(directory);
  const temporary = resolve(directory, `.pi-swe-recovery-tmp-${randomBytes(16).toString("hex")}`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    writeFileSync(descriptor, content);
    fault?.("before-file-fsync", path);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fault?.("before-exclusive-publish", path);
    linkSync(temporary, path);
    fault?.("exclusive-published", path);
    fault?.("before-directory-fsync", directory);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* noop */ }
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(directory);
    }
  }
}
function writeJsonAtomic(path: string, value: unknown): void {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (content.length > 1024 * 1024) throw new Error("workflow migration recovery record exceeds 1048576 bytes");
  atomicWriteBytes(path, content);
}
function atomicWriteBytes(path: string, value: Buffer): void {
  ensureDurableDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600); writeFileSync(descriptor, value); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); fsyncDirectory(dirname(path));
  } catch (error) { if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* noop */ } rmSync(temporary, { force: true }); throw error; }
}
function assertJournalPriorArchive(root: string, journal: SweMigrationJournal): void {
  if (journal.schemaVersion !== 2 || !journal.priorReceipt) return;
  const archiveAbsolute = resolve(root, archivedReceiptPath(journal.priorReceipt));
  if (!existsSync(archiveAbsolute)) throw new Error("recovery refused: authenticated prior migration attempt is missing");
  const archived = readMigrationReceipt(root, archiveAbsolute);
  if (!receiptEquals(archived, journal.priorReceipt)) throw new Error("recovery refused: archived prior receipt does not match the reapply journal");
}
function cleanupRecoveryTemporaryFiles(directory: string): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!/^\.pi-swe-recovery-tmp-[a-f0-9]{32}$/.test(name)) continue;
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe SWE migration recovery temporary: ${path}`);
    rmSync(path);
    fsyncDirectory(directory);
  }
}
function ensureDurableDirectory(directory: string): void {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`migration recovery directory is unsafe: ${directory}`);
    return;
  }
  const parent = dirname(directory);
  if (parent === directory) throw new Error(`migration recovery directory cannot be created: ${directory}`);
  ensureDurableDirectory(parent);
  mkdirSync(directory, { mode: 0o700 });
  fsyncDirectory(directory);
  fsyncDirectory(parent);
}
function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function removeFileDurable(path: string, fault?: WorkflowMigrationFault): void {
  if (!existsSync(path)) return;
  fault?.("before-unlink", path);
  rmSync(path);
  fault?.("before-directory-fsync", dirname(path));
  fsyncDirectory(dirname(path));
}
function validateLegacyPlanIdentity(receipt: Extract<WorkflowMigrationReceipt, { schemaVersion: 1 }>, generatedAt: string, expectedPostimageHash: string | undefined): void {
  const logical = { schemaVersion: 1, topic: receipt.topic, classification: receipt.classification, disposition: receipt.disposition, decidedBy: receipt.decidedBy, generatedAt, sourcePaths: receipt.sourcePaths, preimageHash: receipt.preimageHash, postimageHash: expectedPostimageHash ?? null, eligible: true };
  if (hashBytes(Buffer.from(stableLegacyJson(logical))) !== receipt.planHash) throw new Error("legacy workflow migration receipt plan hash mismatch");
}
function legacyGeneratedAt(cwd: string, topic: string): string {
  const located = loadWorkflow(cwd, topic, false);
  const generatedAt = located?.workflow.migration?.readAt;
  if (!generatedAt || new Date(generatedAt).toISOString() !== generatedAt) throw new Error("legacy workflow migration receipt cannot authenticate its plan timestamp");
  return generatedAt;
}
function stableLegacyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableLegacyJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableLegacyJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hashBytes(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function redact(value: string): string { return SENSITIVE_METADATA.test(value) || !isValidTopic(value) ? `sha256:${createHash("sha256").update(value).digest("hex")}` : value; }
function projectPath(root: string, absolute: string): string { return toPosix(relative(root, absolute)); }
function toPosix(path: string): string { return path.split(sep).join("/"); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
