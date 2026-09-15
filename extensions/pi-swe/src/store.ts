import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, opendirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { createWorkflow, isValidTopic, parseWorkflow, type TaskStatus, type Workflow, type WorkflowTask } from "./workflow.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOPICS = 100;
const MAX_DIRECTORIES = 1_000;
const MAX_DIRECTORY_ENTRIES = 1_000;

export type LocatedWorkflow =
  | { kind: "native"; path: string; workflow: Workflow }
  | { kind: "legacy"; path: string; workflow: Workflow };

export function workflowPath(topic: string): string {
  return `.model-artifacts/initiatives/${topic}/workflow.json`;
}

export function legacyManifestPath(topic: string): string {
  return `.model-artifacts/initiatives/${topic}/specs/manifest.json`;
}

export function hasLegacyInitiative(cwd: string, topic: string): boolean {
  const root = safeRoot(cwd);
  return existsSync(safePath(root, legacyManifestPath(topic)));
}

export function listWorkflowTopics(cwd: string): string[] {
  const root = safeRoot(cwd);
  const initiatives = resolve(root, ".model-artifacts/initiatives");
  if (!existsSync(initiatives)) return [];
  if (lstatSync(initiatives).isSymbolicLink()) throw new Error("workflow scan incomplete: initiative root is a symlink");
  const topics: string[] = [];
  let directories = 0;
  function walk(directory: string, segments: string[]): void {
    directories += 1;
    if (segments.length > 16 || directories > MAX_DIRECTORIES) throw new Error("workflow scan incomplete: directory or depth limit exceeded");
    let entries;
    try { entries = readWorkflowDirectory(directory); }
    catch (error) {
      if (error instanceof Error && /workflow scan incomplete/.test(error.message)) throw error;
      throw new Error("workflow scan incomplete: directory could not be read");
    }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("workflow scan incomplete: symlinked entry rejected");
    const names = new Set(entries.map((entry) => entry.name));
    const topic = segments.join("/");
    const hasWorkflow = names.has("workflow.json") && existsSync(resolve(directory, "workflow.json"));
    const hasLegacyManifest = names.has("specs") && existsSync(resolve(directory, "specs/manifest.json"));
    if (topic && isValidTopic(topic) && (hasWorkflow || hasLegacyManifest)) {
      if (topics.length >= MAX_TOPICS) throw new Error("workflow scan incomplete: topic limit exceeded");
      topics.push(topic);
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== "specs" && entry.name !== "plans" && entry.name !== "reports" && entry.name !== "findings" && entry.name !== "logs" && entry.name !== "todo") {
      walk(resolve(directory, entry.name), [...segments, entry.name]);
    }
  }
  walk(initiatives, []);
  return [...new Set(topics)].sort().slice(0, MAX_TOPICS);
}

function readWorkflowDirectory(directory: string): Dirent[] {
  const handle = opendirSync(directory);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new Error("workflow scan incomplete: directory entry limit exceeded");
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function activeWorkflowTopics(cwd: string, exceptTopic?: string): string[] {
  return listWorkflowTopics(cwd).filter((topic) => {
    if (topic === exceptTopic) return false;
    // Legacy initiatives are imported as paused so they never own the active
    // workflow slot until explicitly migrated. Do not fully import unrelated
    // legacy contracts here: malformed historical content must not prevent a
    // valid native workflow from starting.
    const workflow = loadWorkflow(cwd, topic, false)?.workflow;
    return workflow?.status === "active" && !!workflow.activeTask;
  });
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
  const expectedRoot = `.model-artifacts/initiatives/${topic}/plans/revisions`;
  if (!new RegExp(`^${escapeRegExp(expectedRoot)}/r[1-9][0-9]*$`).test(contractRoot)) {
    throw new Error(`legacy contract root must be a revision beneath ${expectedRoot}`);
  }
  const contractRootPath = safePath(root, contractRoot);
  const indexPath = safePath(root, `${contractRoot}/contracts.json`);
  const index = readJson(indexPath);
  if (!record(index) || !Array.isArray(index.contracts)) throw new Error("legacy contract index is malformed");
  const rawContracts = index.contracts.filter(record);
  const parentIds = new Set(rawContracts.map((item) => typeof item.parentId === "string" ? item.parentId : undefined).filter(Boolean));
  const executable = rawContracts.filter((item) => item.kind === "subphase" || !parentIds.has(item.id as string));
  if (!executable.length) throw new Error("legacy initiative has no executable contracts");
  const activeContract = record(manifest.activeContract) ? manifest.activeContract : undefined;
  const active = typeof activeContract?.id === "string" ? activeContract.id : undefined;
  const completionRecords = record(index.completionRecords) ? index.completionRecords : {};
  const tasks: WorkflowTask[] = executable.map((item) => {
    const id = String(item.id ?? "");
    const facts = record(index.contractFacts) && record(index.contractFacts[id]) ? index.contractFacts[id] as Record<string, unknown> : undefined;
    const status = legacyStatus(item.status, id === active, facts);
    const contractPath = typeof item.path === "string" ? item.path : typeof item.canonicalPath === "string" ? item.canonicalPath : undefined;
    const document = contractPath ? readLegacyContract(root, contractRootPath, contractPath) : undefined;
    const acceptance = document ? markdownSectionItems(document, "acceptance criteria") : [];
    const verification = document ? verificationCommands(document) : [];
    if (facts?.acceptanceDefined === true && !acceptance.length) throw new Error(`legacy contract ${id} acceptance criteria could not be imported`);
    if (facts?.verificationDefined === true && !verification.length) throw new Error(`legacy contract ${id} verification commands could not be imported`);
    const completion = record(completionRecords[id]) ? completionRecords[id] as Record<string, unknown> : undefined;
    const completionVerification = completion && record(completion.verification) ? completion.verification : undefined;
    const completionReview = completion && record(completion.review) ? completion.review : undefined;
    const completionNextState = completion && record(completion.nextState) ? completion.nextState : undefined;
    const evidenceLinks = uniqueStrings([
      ...pathValues(item.evidence),
      ...pathValues(completion?.evidence),
      completionVerification?.path,
      completionReview?.path,
    ]);
    const blockedReason = legacyBlocker(item, id === active ? activeContract : undefined);
    const provenance = contractPath ? {
      kind: "pi-swe-v2-contract" as const,
      contractPath,
      ...(typeof item.contentHash === "string" ? { contentHash: item.contentHash } : {}),
      ...(completion ? { completion: {
        ...(Number.isSafeInteger(completion.schemaVersion) ? { schemaVersion: completion.schemaVersion as number } : {}),
        ...(typeof completion.requestId === "string" ? { requestId: completion.requestId } : {}),
        ...(typeof completion.completedAt === "string" ? { completedAt: completion.completedAt } : {}),
        ...(Number.isSafeInteger(completion.planRevision) ? { planRevision: completion.planRevision as number } : {}),
        ...(typeof completion.contractPath === "string" ? { contractPath: completion.contractPath } : {}),
        ...(typeof completion.preCompletionContentHash === "string" ? { preCompletionContentHash: completion.preCompletionContentHash } : {}),
        ...(typeof completionVerification?.path === "string" ? { verificationPath: completionVerification.path } : {}),
        ...(typeof completionVerification?.contentHash === "string" ? { verificationContentHash: completionVerification.contentHash } : {}),
        ...(typeof completionReview?.path === "string" ? { reviewPath: completionReview.path } : {}),
        ...(typeof completionReview?.contentHash === "string" ? { reviewContentHash: completionReview.contentHash } : {}),
        ...(typeof completionReview?.decision === "string" ? { reviewDecision: completionReview.decision } : {}),
        ...(typeof completionNextState?.initiativeState === "string" ? { nextInitiativeState: completionNextState.initiativeState } : {}),
        ...(completionNextState?.activeContractId === null || typeof completionNextState?.activeContractId === "string" ? { nextActiveContractId: completionNextState.activeContractId as string | null } : {}),
        ...(Array.isArray(completionNextState?.readyContractIds) ? { nextReadyContractIds: uniqueStrings(completionNextState.readyContractIds) } : {}),
      } } : {}),
    } : undefined;
    return {
      id,
      title: document ? markdownTitle(document, id) : typeof item.title === "string" ? item.title : id,
      status,
      dependsOn: (Array.isArray(item.dependsOn) ? item.dependsOn : Array.isArray(item.dependencies) ? item.dependencies : []).filter((value): value is string => typeof value === "string" && executable.some((candidate) => candidate.id === value)),
      acceptance,
      approaches: [],
      approachReasons: {},
      assessmentStatus: "unassessed",
      verification,
      evidence: [],
      evidenceLinks,
      ...(blockedReason ? { blockedReason } : {}),
      ...(typeof completion?.completedAt === "string" ? { completedAt: completion.completedAt } : {}),
      ...(provenance ? { importedFrom: provenance } : {}),
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
    status: allDone ? "complete" : activeTask ? "paused" : hasBlocked ? "blocked" : "draft",
    ...(activeTask ? { activeTask } : {}),
    importedFrom: {
      kind: "pi-swe-v2",
      manifestPath: legacyManifestPath(topic),
      ...(Number.isSafeInteger(activePlan?.revision) ? { planRevision: activePlan!.revision as number } : {}),
    },
  };
}

function readLegacyContract(root: string, contractRoot: string, path: string): string {
  const absolute = safePath(root, path);
  const rel = relative(contractRoot, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`legacy contract path is outside its contract revision: ${path}`);
  if (!existsSync(absolute)) throw new Error(`legacy contract file is missing: ${path}`);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`legacy contract file must not be a symlink: ${path}`);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`legacy contract file is not a bounded regular file: ${path}`);
  return readFileSync(absolute, "utf8");
}

function markdownTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return fallback;
  return heading.replace(new RegExp(`^${escapeRegExp(fallback)}\\s*:\\s*`, "i"), "").trim() || fallback;
}

function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return "";
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function markdownSectionItems(markdown: string, heading: string): string[] {
  return uniqueStrings(markdownSection(markdown, heading).split("\n").map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)?.[1]));
}

function verificationCommands(markdown: string): Array<{ command: string; args: string[] }> {
  const section = markdownSection(markdown, "TDD/verification") || markdownSection(markdown, "verification");
  const inline = [...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
  const fenced = [...section.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/gi)].flatMap((match) => match[1]!.split("\n").map((line) => line.trim()));
  const commands = [...inline, ...fenced].filter((value) => /^(?:npm|pnpm|yarn|bun|node|deno|python|pytest|cargo|go|make|\.\/)/.test(value));
  return uniqueStrings(commands).map((command) => ({ command, args: [] }));
}

function legacyBlocker(item: Record<string, unknown>, active?: Record<string, unknown>): string | undefined {
  for (const value of [item.blockedReason, item.blocker, active?.blockedReason, active?.blocker]) if (typeof value === "string" && value.trim()) return value.trim();
  const blockers = uniqueStrings([...(Array.isArray(item.blockers) ? item.blockers : []), ...(Array.isArray(active?.blockers) ? active.blockers : [])]);
  return blockers.length ? blockers.join("; ") : item.status === "blocked" ? "Imported legacy blocker; inspect the linked contract." : undefined;
}

function pathValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : record(item) ? [item.path] : []);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function legacyStatus(value: unknown, active: boolean, facts?: Record<string, unknown>): TaskStatus {
  const deferral = record(facts?.deferral) ? facts.deferral : undefined;
  if (value === "deferred" || deferral?.approved === true) return "deferred";
  if (value === "complete" || value === "completed") return "complete";
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
