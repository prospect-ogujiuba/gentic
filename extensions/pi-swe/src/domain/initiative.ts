import { createHash } from "node:crypto";
import { posix } from "node:path";

export const INITIATIVE_KIND = "gentic.swe.initiative" as const;
export const INITIATIVE_SCHEMA_VERSION = 1 as const;

export type InitiativeStatus = "draft" | "active" | "paused" | "complete" | "abandoned";
export type WorkStatus = "pending" | "active" | "implemented" | "blocked" | "complete";
export type WorkKind = "phase" | "task" | "subtask";

export type WorkItem = {
  id: string;
  parentId?: string;
  kind: WorkKind;
  title: string;
  status?: WorkStatus;
  dependsOn?: string[];
  criterionIds?: string[];
  obligationIds?: string[];
  testing?: { approach: string; reason: string };
  disposition?: { kind: "cancelled" | "superseded"; reason: string; supersededBy?: string };
};

export type Initiative = {
  kind: typeof INITIATIVE_KIND;
  schemaVersion: typeof INITIATIVE_SCHEMA_VERSION;
  id: string;
  revision: number;
  status: InitiativeStatus;
  objective: string;
  bootstrap?: { mode: string; runtimeValidated: boolean; approval: string; adoptionRequirement: string };
  policies?: { commitOnWorkCompletion: boolean };
  scope: { in: string[]; out: string[] };
  constraints: string[];
  acceptanceCriteria: Array<{ id: string; text: string }>;
  assessment: { depth: "light" | "standard" | "deep"; reason: string; surfaces: string[]; unknowns: string[] };
  practices: Array<{ id: string; practice: string; appliesTo: string[]; reason: string }>;
  obligations: Array<{
    id: string;
    practiceId: string;
    criterionIds: string[];
    text: string;
    verification: {
      kind: string;
      requiredEvidence?: EvidenceKind[];
      sequence?: "red-green";
    };
  }>;
  work: WorkItem[];
  artifacts: Array<{ path: string; type: string; relatedWork: string[]; summary: string; contentHash?: string }>;
  evidence: VerificationEvidence[];
  decisions: Array<{ id: string; text: string; basis: string }>;
  risks: Array<{ id: string; text: string; mitigation: string }>;
};

export type RelevantSourceSnapshot = { kind: "bounded-paths"; paths: string[]; hash: string };
export type EvidenceKind = "machine-command" | "model-review";
export type MachineCommandEvidence = {
  id: string;
  kind: "machine-command";
  workId: string;
  obligationIds: string[];
  outcome: "passed" | "failed";
  execution: { executable: "bash"; args: ["-lc", string]; cwd: "." };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  contractFingerprint: string;
  source: { before: RelevantSourceSnapshot; after: RelevantSourceSnapshot };
  provenance: { kind: "pi-tool-observation"; toolCallId: string; permissionBoundary: "ordinary-bash-tool-call" };
  outputHash: string;
};
export type ModelReviewEvidence = {
  id: string;
  kind: "model-review";
  workId: string;
  obligationIds: string[];
  outcome: "passed" | "failed";
  reviewedAt: string;
  contractFingerprint: string;
  source: RelevantSourceSnapshot;
  dimensions: string[];
  summary: string;
  provenance: { kind: "pi-model-self-review"; sessionId: string };
};
export type VerificationEvidence = MachineCommandEvidence | ModelReviewEvidence;

const LIMITS = { collection: 1_000, text: 8_192, id: 128, path: 1_024 } as const;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const WORK_TRANSITIONS: Record<WorkStatus, readonly WorkStatus[]> = {
  pending: ["active", "blocked"],
  active: ["implemented", "blocked"],
  implemented: ["active", "blocked", "complete"],
  blocked: ["pending", "active"],
  complete: [],
};

export function parseInitialInitiative(input: unknown): Initiative {
  const initiative = parseInitiative(input);
  if (initiative.revision !== 1) throw new Error("initial initiative revision must be 1");
  if (initiative.status !== "draft") throw new Error("initial initiative status must be draft");
  if (initiative.evidence.length) throw new Error("initial initiative evidence must be empty");
  const executable = initiative.work.filter((item) => item.kind !== "phase");
  if (!executable.length) throw new Error("initial initiative must contain executable work");
  for (const item of executable) {
    if (item.status !== "pending" || item.disposition !== undefined) {
      throw new Error(`initial executable work ${item.id} must be pending without a disposition`);
    }
    if (!item.criterionIds?.length) throw new Error(`initial executable work ${item.id} must cover acceptance criteria`);
    if (!item.obligationIds?.length) throw new Error(`initial executable work ${item.id} must carry verification obligations`);
  }
  return initiative;
}

export function parseInitiative(input: unknown): Initiative {
  if (!record(input)) throw new Error("initiative must be an object");
  if (input.kind !== INITIATIVE_KIND || input.schemaVersion !== INITIATIVE_SCHEMA_VERSION) {
    throw new Error("unsupported initiative schema");
  }
  exact(input, ["kind", "schemaVersion", "id", "revision", "status", "objective", "bootstrap", "policies", "scope", "constraints", "acceptanceCriteria", "assessment", "practices", "obligations", "work", "artifacts", "evidence", "decisions", "risks"], "initiative", ["bootstrap", "policies"]);
  topic(input.id, "initiative id");
  integer(input.revision, "revision", 1);
  enumValue(input.status, ["draft", "active", "paused", "complete", "abandoned"], "initiative status");
  text(input.objective, "objective");

  if (input.bootstrap !== undefined) {
    object(input.bootstrap, "bootstrap");
    exact(input.bootstrap, ["mode", "runtimeValidated", "approval", "adoptionRequirement"], "bootstrap");
    text(input.bootstrap.mode, "bootstrap mode");
    bool(input.bootstrap.runtimeValidated, "bootstrap runtimeValidated");
    text(input.bootstrap.approval, "bootstrap approval");
    text(input.bootstrap.adoptionRequirement, "bootstrap adoptionRequirement");
  }
  if (input.policies !== undefined) {
    object(input.policies, "policies");
    exact(input.policies, ["commitOnWorkCompletion"], "policies");
    bool(input.policies.commitOnWorkCompletion, "commitOnWorkCompletion");
  }

  object(input.scope, "scope");
  exact(input.scope, ["in", "out"], "scope");
  strings(input.scope.in, "scope.in");
  strings(input.scope.out, "scope.out");
  strings(input.constraints, "constraints");

  array(input.acceptanceCriteria, "acceptanceCriteria");
  for (const item of input.acceptanceCriteria) {
    object(item, "acceptance criterion"); exact(item, ["id", "text"], "acceptance criterion"); id(item.id, "criterion id"); text(item.text, "criterion text");
  }
  object(input.assessment, "assessment");
  exact(input.assessment, ["depth", "reason", "surfaces", "unknowns"], "assessment");
  enumValue(input.assessment.depth, ["light", "standard", "deep"], "assessment depth"); text(input.assessment.reason, "assessment reason"); strings(input.assessment.surfaces, "assessment surfaces"); strings(input.assessment.unknowns, "assessment unknowns");

  array(input.practices, "practices");
  for (const item of input.practices) {
    object(item, "practice"); exact(item, ["id", "practice", "appliesTo", "reason"], "practice"); id(item.id, "practice id"); text(item.practice, "practice name"); ids(item.appliesTo, "practice appliesTo"); text(item.reason, "practice reason");
  }
  array(input.obligations, "obligations");
  for (const item of input.obligations) {
    object(item, "obligation"); exact(item, ["id", "practiceId", "criterionIds", "text", "verification"], "obligation"); id(item.id, "obligation id"); id(item.practiceId, "obligation practiceId"); ids(item.criterionIds, "obligation criterionIds"); text(item.text, "obligation text"); object(item.verification, "obligation verification"); exact(item.verification, ["kind", "requiredEvidence", "sequence"], "obligation verification", ["requiredEvidence", "sequence"]); text(item.verification.kind, "verification kind");
    if (item.verification.requiredEvidence !== undefined) { array(item.verification.requiredEvidence, "verification requiredEvidence"); if (!item.verification.requiredEvidence.length) throw new Error("verification requiredEvidence cannot be empty"); for (const kind of item.verification.requiredEvidence) enumValue(kind, ["machine-command", "model-review"], "required evidence kind"); if (new Set(item.verification.requiredEvidence).size !== item.verification.requiredEvidence.length) throw new Error("verification requiredEvidence contains duplicates"); }
    if (item.verification.sequence !== undefined) { enumValue(item.verification.sequence, ["red-green"], "verification sequence"); if (!(item.verification.requiredEvidence ?? ["machine-command"]).includes("machine-command")) throw new Error("red-green verification requires machine-command evidence"); }
  }

  array(input.work, "work");
  for (const item of input.work) parseWork(item);
  array(input.artifacts, "artifacts");
  for (const item of input.artifacts) {
    object(item, "artifact"); exact(item, ["path", "type", "relatedWork", "summary", "contentHash"], "artifact", ["contentHash"]); artifactPath(item.path, input.id); text(item.type, "artifact type"); ids(item.relatedWork, "artifact relatedWork"); text(item.summary, "artifact summary"); if (item.contentHash !== undefined && (typeof item.contentHash !== "string" || !HASH.test(item.contentHash))) throw new Error("artifact contentHash must be canonical sha256");
  }
  array(input.evidence, "evidence");
  for (const item of input.evidence) parseEvidence(item);
  for (const [name, entries, keys] of [["decision", input.decisions, ["id", "text", "basis"]], ["risk", input.risks, ["id", "text", "mitigation"]]] as const) {
    array(entries, `${name}s`);
    for (const item of entries) { object(item, name); exact(item, keys, name); id(item.id, `${name} id`); text(item.text, `${name} text`); text(item[name === "decision" ? "basis" : "mitigation"], `${name} detail`); }
  }

  const initiative = input as unknown as Initiative;
  validateGraph(initiative);
  return structuredClone(initiative);
}

function parseWork(value: unknown): void {
  object(value, "work item");
  enumValue(value.kind, ["phase", "task", "subtask"], "work kind");
  if (value.kind === "phase") {
    exact(value, ["id", "kind", "title", "parentId"], "phase", ["parentId"]);
  } else {
    exact(value, ["id", "parentId", "kind", "title", "status", "dependsOn", "criterionIds", "obligationIds", "testing", "disposition"], "work item", ["parentId", "disposition"]);
  }
  id(value.id, "work id"); text(value.title, "work title");
  if (value.parentId !== undefined) id(value.parentId, "work parentId");
  if (value.kind !== "phase") {
    enumValue(value.status, ["pending", "active", "implemented", "blocked", "complete"], "work status");
    ids(value.dependsOn, "work dependsOn"); ids(value.criterionIds, "work criterionIds"); ids(value.obligationIds, "work obligationIds");
    object(value.testing, "work testing"); exact(value.testing, ["approach", "reason"], "work testing"); text(value.testing.approach, "testing approach"); text(value.testing.reason, "testing reason");
    if (value.disposition !== undefined) { object(value.disposition, "work disposition"); exact(value.disposition, ["kind", "reason", "supersededBy"], "work disposition", ["supersededBy"]); enumValue(value.disposition.kind, ["cancelled", "superseded"], "work disposition kind"); text(value.disposition.reason, "work disposition reason"); if (value.disposition.supersededBy !== undefined) id(value.disposition.supersededBy, "supersededBy"); if (value.status === "complete") throw new Error("cancelled or superseded work cannot be complete"); }
  }
}

function validateGraph(initiative: Initiative): void {
  unique(initiative.acceptanceCriteria, "criterion"); unique(initiative.practices, "practice"); unique(initiative.obligations, "obligation"); unique(initiative.work, "work"); unique(initiative.decisions, "decision"); unique(initiative.risks, "risk");
  const criteria = new Set(initiative.acceptanceCriteria.map((item) => item.id));
  const practices = new Map(initiative.practices.map((item) => [item.id, item]));
  const obligations = new Map(initiative.obligations.map((item) => [item.id, item]));
  const work = new Map(initiative.work.map((item) => [item.id, item]));
  const children = new Map<string, string[]>();
  for (const item of initiative.work) {
    if (item.parentId) { if (!work.has(item.parentId)) throw new Error(`work ${item.id} has unknown parent ${item.parentId}`); children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id]); }
    let depth = 0; let cursor: WorkItem | undefined = item; const lineage = new Set<string>();
    while (cursor?.parentId) { if (lineage.has(cursor.id)) throw new Error("work parent cycle"); lineage.add(cursor.id); depth += 1; cursor = work.get(cursor.parentId); }
    if (depth > 2) throw new Error(`work ${item.id} exceeds hierarchy depth`);
    if (item.kind === "phase" && item.parentId) throw new Error(`phase ${item.id} cannot have a parent`);
  }
  const leaves = new Set(initiative.work.filter((item) => item.kind !== "phase" && !(children.get(item.id)?.length)).map((item) => item.id));
  for (const item of initiative.work) {
    if (item.kind !== "phase" && children.has(item.id) && item.kind !== "task") throw new Error(`subtask ${item.id} cannot have children`);
    for (const dependency of item.dependsOn ?? []) if (!leaves.has(dependency)) throw new Error(`dependency ${dependency} must reference an executable leaf`);
    for (const criterion of item.criterionIds ?? []) if (!criteria.has(criterion)) throw new Error(`work ${item.id} references unknown criterion ${criterion}`);
    for (const obligation of item.obligationIds ?? []) if (!obligations.has(obligation)) throw new Error(`work ${item.id} references unknown obligation ${obligation}`);
  }
  detectDependencyCycles(initiative.work.filter((item) => leaves.has(item.id)));
  for (const practice of initiative.practices) {
    if (!initiative.obligations.some((item) => item.practiceId === practice.id)) throw new Error(`practice ${practice.id} has no derived obligation`);
    for (const workId of practice.appliesTo) if (!work.has(workId)) throw new Error(`practice ${practice.id} references unknown work ${workId}`);
  }
  for (const obligation of initiative.obligations) {
    if (!practices.has(obligation.practiceId)) throw new Error(`obligation ${obligation.id} references unknown practice ${obligation.practiceId}`);
    for (const criterion of obligation.criterionIds) if (!criteria.has(criterion)) throw new Error(`obligation ${obligation.id} references unknown criterion ${criterion}`);
  }
  for (const item of initiative.work.filter((candidate) => candidate.kind !== "phase")) {
    for (const obligationId of item.obligationIds ?? []) {
      const obligation = obligations.get(obligationId)!; const practice = practices.get(obligation.practiceId)!;
      if (!practice.appliesTo.includes(item.id)) throw new Error(`obligation ${obligationId} does not apply to work ${item.id}`);
    }
  }
  for (const criterion of criteria) if (!initiative.work.some((item) => item.criterionIds?.includes(criterion))) throw new Error(`criterion ${criterion} has no work coverage`);
  for (const artifact of initiative.artifacts) for (const related of artifact.relatedWork) if (!work.has(related)) throw new Error(`artifact references unknown work ${related}`);
  unique(initiative.evidence, "evidence");
  for (const evidence of initiative.evidence) {
    const item = work.get(evidence.workId);
    if (!item || item.kind === "phase") throw new Error(`evidence references unknown work ${evidence.workId}`);
    for (const obligationId of evidence.obligationIds) if (!item.obligationIds?.includes(obligationId)) throw new Error(`evidence references obligation ${obligationId} outside work ${item.id}`);
  }
}

function parseEvidence(value: unknown): void {
  object(value, "evidence");
  id(value.id, "evidence id"); enumValue(value.kind, ["machine-command", "model-review"], "evidence kind"); id(value.workId, "evidence workId"); ids(value.obligationIds, "evidence obligationIds"); if (!value.obligationIds.length) throw new Error("evidence requires obligationIds"); enumValue(value.outcome, ["passed", "failed"], "evidence outcome");
  if (value.kind === "machine-command") {
    exact(value, ["id", "kind", "workId", "obligationIds", "outcome", "execution", "startedAt", "completedAt", "durationMs", "contractFingerprint", "source", "provenance", "outputHash"], "machine evidence");
    object(value.execution, "evidence execution"); exact(value.execution, ["executable", "args", "cwd"], "evidence execution"); enumValue(value.execution.executable, ["bash"], "evidence executable"); if (!Array.isArray(value.execution.args) || value.execution.args.length !== 2 || value.execution.args[0] !== "-lc") throw new Error("evidence args must be exact bash argv"); text(value.execution.args[1], "evidence command"); enumValue(value.execution.cwd, ["."], "evidence cwd");
    timestamp(value.startedAt, "evidence startedAt"); timestamp(value.completedAt, "evidence completedAt"); integer(value.durationMs, "evidence durationMs", 0); hash(value.outputHash, "evidence outputHash");
    object(value.source, "evidence source"); exact(value.source, ["before", "after"], "evidence source"); parseSnapshot(value.source.before); parseSnapshot(value.source.after);
    object(value.provenance, "evidence provenance"); exact(value.provenance, ["kind", "toolCallId", "permissionBoundary"], "evidence provenance"); enumValue(value.provenance.kind, ["pi-tool-observation"], "evidence provenance kind"); text(value.provenance.toolCallId, "evidence toolCallId"); enumValue(value.provenance.permissionBoundary, ["ordinary-bash-tool-call"], "evidence permission boundary");
  } else {
    exact(value, ["id", "kind", "workId", "obligationIds", "outcome", "reviewedAt", "contractFingerprint", "source", "dimensions", "summary", "provenance"], "review evidence");
    timestamp(value.reviewedAt, "evidence reviewedAt"); parseSnapshot(value.source); strings(value.dimensions, "review dimensions"); if (!value.dimensions.length) throw new Error("review dimensions cannot be empty"); text(value.summary, "review summary");
    object(value.provenance, "evidence provenance"); exact(value.provenance, ["kind", "sessionId"], "evidence provenance"); enumValue(value.provenance.kind, ["pi-model-self-review"], "evidence provenance kind"); text(value.provenance.sessionId, "review sessionId");
  }
  hash(value.contractFingerprint, "evidence contractFingerprint");
}

function parseSnapshot(value: unknown): void { object(value, "source snapshot"); exact(value, ["kind", "paths", "hash"], "source snapshot"); enumValue(value.kind, ["bounded-paths"], "snapshot kind"); strings(value.paths, "snapshot paths"); if (!value.paths.length || value.paths.length > 256) throw new Error("snapshot paths must contain 1 to 256 entries"); for (const path of value.paths) safeRelativePath(path); hash(value.hash, "snapshot hash"); }

function detectDependencyCycles(items: WorkItem[]): void {
  const map = new Map(items.map((item) => [item.id, item])); const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (idValue: string): void => { if (visiting.has(idValue)) throw new Error(`dependency cycle at ${idValue}`); if (visited.has(idValue)) return; visiting.add(idValue); for (const dependency of map.get(idValue)?.dependsOn ?? []) visit(dependency); visiting.delete(idValue); visited.add(idValue); };
  for (const item of items) visit(item.id);
}

export function readyWork(initiative: Initiative): WorkItem[] {
  const children = new Set(initiative.work.flatMap((item) => item.parentId ? [item.parentId] : []));
  const byId = new Map(initiative.work.map((item) => [item.id, item]));
  return initiative.work.filter((item) => item.kind !== "phase" && !children.has(item.id) && item.status === "pending" && !item.disposition && (item.dependsOn ?? []).every((dependency) => byId.get(dependency)?.status === "complete"));
}

export function transitionWork(initiative: Initiative, workId: string, status: WorkStatus): Initiative {
  const current = initiative.work.find((item) => item.id === workId);
  if (!current || current.kind === "phase" || current.status === undefined) throw new Error(`unknown executable work ${workId}`);
  if (status === "active" && current.status === "pending" && !readyWork(initiative).some((item) => item.id === workId)) throw new Error(`work ${workId} is not ready`);
  if (!WORK_TRANSITIONS[current.status].includes(status)) throw new Error(`illegal work transition ${current.status} -> ${status}`);
  return parseInitiative({ ...initiative, work: initiative.work.map((item) => item.id === workId ? { ...item, status } : item) });
}

export function contractFingerprint(initiative: Initiative): string {
  const contract = {
    objective: initiative.objective, scope: initiative.scope, constraints: initiative.constraints,
    acceptanceCriteria: initiative.acceptanceCriteria, assessment: initiative.assessment,
    practices: initiative.practices, obligations: initiative.obligations, policies: initiative.policies,
    work: initiative.work.map(({ status: _status, disposition: _disposition, ...item }) => item),
  };
  return `sha256:${createHash("sha256").update(stable(contract)).digest("hex")}`;
}

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: unknown, label: string): asserts value is Record<string, any> { if (!record(value)) throw new Error(`${label} must be an object`); }
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void { const allowedSet = new Set(allowed); const unknown = Object.keys(value).find((key) => !allowedSet.has(key)); if (unknown) throw new Error(`${label} has unknown field ${unknown}`); const optionalSet = new Set(optional); const missing = allowed.find((key) => !optionalSet.has(key) && !Object.hasOwn(value, key)); if (missing) throw new Error(`${label} is missing ${missing}`); }
function array(value: unknown, label: string): asserts value is any[] { if (!Array.isArray(value) || value.length > LIMITS.collection) throw new Error(`${label} must be a bounded array`); }
function text(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > LIMITS.text || /[\u0000]/.test(value)) throw new Error(`${label} must be non-empty bounded text`); }
function bool(value: unknown, label: string): asserts value is boolean { if (typeof value !== "boolean") throw new Error(`${label} must be boolean`); }
function integer(value: unknown, label: string, minimum: number): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`); }
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} is invalid`); }
function id(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length > LIMITS.id || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`); }
function topic(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length > LIMITS.id || !TOPIC.test(value)) throw new Error(`${label} is invalid`); }
function strings(value: unknown, label: string): asserts value is string[] { array(value, label); for (const item of value) text(item, label); }
function ids(value: unknown, label: string): asserts value is string[] { array(value, label); for (const item of value) id(item, label); if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate IDs`); }
function unique(items: Array<{ id: string }>, label: string): void { const seen = new Set<string>(); for (const item of items) { if (seen.has(item.id)) throw new Error(`duplicate id ${item.id} in ${label}`); seen.add(item.id); } }
function artifactPath(value: unknown, initiativeId: unknown): asserts value is string {
  const prefix = `.model-artifacts/initiatives/${String(initiativeId)}/`;
  const relative = typeof value === "string" ? value.slice(prefix.length) : "";
  const [kind, file, ...extra] = relative.split("/");
  const kinds = new Set(["specs", "plans", "todo", "findings", "reports", "logs"]);
  const generatedName = /^\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
  if (typeof value !== "string" || value.length > LIMITS.path || value.startsWith("/") || value.includes("\\")
    || value !== posix.normalize(value) || !value.startsWith(prefix) || !kinds.has(kind) || !generatedName.test(file) || extra.length) {
    throw new Error("artifact path must be a safe canonical path for the initiative topic and kind");
  }
}
function safeRelativePath(value: string): void { if (value.length > LIMITS.path || value.startsWith("/") || value.includes("\\") || value !== posix.normalize(value) || value === ".." || value.startsWith("../")) throw new Error("snapshot path must be safe project-relative"); }
function timestamp(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be canonical ISO time`); }
function hash(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be canonical sha256`); }
