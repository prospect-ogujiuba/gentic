import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { createWorkflow, isValidTopic, parseWorkflow, type TaskStatus, type Workflow, type WorkflowTask } from "./workflow.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOPICS = 100;

export type LocatedWorkflow =
  | { kind: "native"; path: string; workflow: Workflow }
  | { kind: "legacy"; path: string; workflow: Workflow };

export function workflowPath(topic: string): string {
  return `.model-artifacts/initiatives/${topic}/workflow.json`;
}

export function legacyManifestPath(topic: string): string {
  return `.model-artifacts/initiatives/${topic}/specs/manifest.json`;
}

export function listWorkflowTopics(cwd: string): string[] {
  const root = safeRoot(cwd);
  const initiatives = resolve(root, ".model-artifacts/initiatives");
  if (!existsSync(initiatives)) return [];
  const topics: string[] = [];
  function walk(directory: string, segments: string[]): void {
    if (topics.length >= MAX_TOPICS || segments.length > 16) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((entry) => entry.name));
    const topic = segments.join("/");
    const hasWorkflow = names.has("workflow.json") && existsSync(resolve(directory, "workflow.json"));
    const hasLegacyManifest = names.has("specs") && existsSync(resolve(directory, "specs/manifest.json"));
    if (topic && isValidTopic(topic) && (hasWorkflow || hasLegacyManifest)) topics.push(topic);
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== "specs" && entry.name !== "plans" && entry.name !== "reports" && entry.name !== "findings" && entry.name !== "logs" && entry.name !== "todo") {
      walk(resolve(directory, entry.name), [...segments, entry.name]);
    }
  }
  walk(initiatives, []);
  return [...new Set(topics)].sort().slice(0, MAX_TOPICS);
}

export function resolveTopic(cwd: string, explicit?: string): string {
  if (explicit) {
    if (!isValidTopic(explicit)) throw new Error("invalid topic");
    return explicit;
  }
  const topics = listWorkflowTopics(cwd);
  if (topics.length !== 1) throw new Error(topics.length ? `topic is ambiguous: ${topics.join(", ")}` : "no workflow found; provide a topic");
  return topics[0]!;
}

export function loadWorkflow(cwd: string, topic: string, includeLegacy = true): LocatedWorkflow | undefined {
  const root = safeRoot(cwd);
  const nativePath = workflowPath(topic);
  const absolute = safePath(root, nativePath);
  if (existsSync(absolute)) return { kind: "native", path: nativePath, workflow: parseWorkflow(readJson(absolute)) };
  if (!includeLegacy) return undefined;
  const manifest = safePath(root, legacyManifestPath(topic));
  if (!existsSync(manifest)) return undefined;
  return { kind: "legacy", path: legacyManifestPath(topic), workflow: importLegacyWorkflow(root, topic, manifest) };
}

export function saveWorkflow(cwd: string, workflow: Workflow, expectedRevision?: number): string {
  const root = safeRoot(cwd);
  const path = workflowPath(workflow.topic);
  const absolute = safePath(root, path);
  if (existsSync(absolute) && expectedRevision !== undefined) {
    const current = parseWorkflow(readJson(absolute));
    if (current.revision !== expectedRevision) throw new Error(`workflow changed: expected revision ${expectedRevision}, found ${current.revision}`);
  }
  atomicWrite(absolute, `${JSON.stringify(parseWorkflow(workflow), null, 2)}\n`);
  return path;
}

export function migrateLegacyWorkflow(cwd: string, topic: string): LocatedWorkflow {
  const located = loadWorkflow(cwd, topic, true);
  if (!located) throw new Error(`workflow ${topic} was not found`);
  if (located.kind === "native") return located;
  saveWorkflow(cwd, located.workflow);
  return { kind: "native", path: workflowPath(topic), workflow: located.workflow };
}

function importLegacyWorkflow(root: string, topic: string, manifestPath: string): Workflow {
  const manifest = readJson(manifestPath);
  if (!record(manifest) || (manifest.schemaVersion !== 2 && manifest.schemaVersion !== 1)) throw new Error("legacy manifest is unsupported or malformed");
  const activePlan = record(manifest.activePlan) ? manifest.activePlan : undefined;
  const contractRoot = activePlan && typeof activePlan.contractRoot === "string" ? activePlan.contractRoot : undefined;
  if (!contractRoot) throw new Error("legacy initiative has no active contract root");
  const indexPath = safePath(root, `${contractRoot}/contracts.json`);
  const index = readJson(indexPath);
  if (!record(index) || !Array.isArray(index.contracts)) throw new Error("legacy contract index is malformed");
  const rawContracts = index.contracts.filter(record);
  const parentIds = new Set(rawContracts.map((item) => typeof item.parentId === "string" ? item.parentId : undefined).filter(Boolean));
  const executable = rawContracts.filter((item) => item.kind === "subphase" || !parentIds.has(item.id as string));
  if (!executable.length) throw new Error("legacy initiative has no executable contracts");
  const active = record(manifest.activeContract) && typeof manifest.activeContract.id === "string" ? manifest.activeContract.id : undefined;
  const tasks: WorkflowTask[] = executable.map((item) => {
    const id = String(item.id ?? "");
    const status = legacyStatus(item.status, id === active);
    const facts = record(index.contractFacts) && record(index.contractFacts[id]) ? index.contractFacts[id] as Record<string, unknown> : undefined;
    return {
      id,
      title: typeof item.title === "string" ? item.title : id,
      status,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((value): value is string => typeof value === "string" && executable.some((candidate) => candidate.id === value)) : [],
      acceptance: facts?.acceptanceDefined === true ? ["Preserve the acceptance criteria in the linked legacy contract."] : [],
      verification: [],
      evidence: [],
      ...(status === "blocked" ? { blockedReason: "Imported legacy blocker; inspect the linked contract." } : {}),
    };
  });
  const now = typeof manifest.updatedAt === "string" ? manifest.updatedAt : new Date().toISOString();
  const workflow = createWorkflow({
    topic,
    goal: `Continue legacy initiative ${topic}`,
    plan: typeof activePlan?.path === "string" ? activePlan.path : undefined,
    tasks,
    now,
  });
  const allDone = tasks.every((task) => task.status === "complete" || task.status === "deferred");
  const hasBlocked = tasks.some((task) => task.status === "blocked");
  const activeTask = tasks.find((task) => task.status === "active")?.id;
  return {
    ...workflow,
    status: allDone ? "complete" : activeTask ? "active" : hasBlocked ? "blocked" : "draft",
    ...(activeTask ? { activeTask } : {}),
    importedFrom: {
      kind: "pi-swe-v2",
      manifestPath: legacyManifestPath(topic),
      ...(Number.isSafeInteger(activePlan?.revision) ? { planRevision: activePlan!.revision as number } : {}),
    },
  };
}

function legacyStatus(value: unknown, active: boolean): TaskStatus {
  if (value === "complete") return "complete";
  if (value === "deferred") return "deferred";
  if (value === "blocked") return "blocked";
  return active ? "active" : "pending";
}

function readJson(path: string): unknown {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`workflow file must not be a symlink: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`workflow file is not a bounded regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* noop */ }
    try { rmSync(temporary, { force: true }); } catch { /* noop */ }
    throw error;
  }
}

function safeRoot(cwd: string): string {
  if (!cwd || !isAbsolute(resolve(cwd))) throw new Error("invalid repository cwd");
  return resolve(cwd);
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\")) throw new Error(`unsafe workflow path: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`workflow path escapes repository: ${path}`);
  let cursor = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`workflow path traverses a symlink: ${path}`);
  }
  return absolute;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
