import { createHash } from "node:crypto";

const HASH = /^sha256:[a-f0-9]{64}$/;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const CLASSIFICATIONS = ["native-v1", "native-v1-complete", "historical-contracts", "historical-contracts-complete"] as const;
export type MigratableClassification = typeof CLASSIFICATIONS[number];
export type MigrationDisposition = "continue" | "reopen" | "grandfather-read-only";
export type Gate1Disposition = MigrationDisposition | "block";

export type Gate1Authorization = {
  authorizedBy: string;
  authorizedAt: string;
  auditHash: string;
  topicDispositions: Record<string, Gate1Disposition>;
  rollbackRetentionUntil: string;
  rationale: string;
};

export type SweMigrationReceiptV2 = {
  schemaVersion: 2;
  topic: string;
  state: "applied" | "rolled-back";
  classification: MigratableClassification;
  disposition: MigrationDisposition;
  generatedAt: string;
  sourcePaths: string[];
  preimageHash: string;
  postimageHash: string;
  eligible: true;
  authorization: Gate1Authorization;
  planHash: string;
  appliedAt: string;
  preimagePayload: string | null;
  rolledBackAt?: string;
};

export type SweMigrationReceiptV1 = {
  schemaVersion: 1;
  topic: string;
  state: "applied" | "rolled-back";
  classification: MigratableClassification;
  disposition: MigrationDisposition;
  decidedBy: string;
  sourcePaths: string[];
  preimageHash: string;
  postimageHash: string;
  planHash: string;
  appliedAt: string;
  preimagePayload?: string;
  rolledBackAt?: string;
};

export type SweMigrationReceipt = SweMigrationReceiptV1 | SweMigrationReceiptV2;
export type SweMigrationJournalV2 = {
  schemaVersion: 2;
  operation: "apply";
  stage: "prepared";
  topic: string;
  preimageHash: string;
  postimageHash: string;
  planHash: string;
  receipt: SweMigrationReceiptV2;
};
export type SweMigrationJournalV1 = {
  schemaVersion: 1;
  stage: "prepared";
  topic: string;
  preimageHash: string;
  postimageHash: string;
  planHash: string;
  receipt: SweMigrationReceiptV1;
};
export type SweMigrationJournal = SweMigrationJournalV1 | SweMigrationJournalV2;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalReceiptPath(topic: string): string {
  assertTopic(topic);
  return `.model-artifacts/system/logs/pi-swe-migration/${Buffer.from(topic).toString("base64url")}/receipt.json`;
}

export function archivedReceiptPath(receipt: SweMigrationReceipt): string {
  return `.model-artifacts/system/logs/pi-swe-migration/${Buffer.from(receipt.topic).toString("base64url")}/attempts/${receipt.planHash.slice(7)}-receipt.json`;
}

export function parseGate1Authorization(value: unknown): Gate1Authorization {
  const authorization = requireRecord(value, "migration authorization");
  exactKeys(authorization, ["authorizedBy", "authorizedAt", "auditHash", "topicDispositions", "rollbackRetentionUntil", "rationale"], "migration authorization");
  const authorizedBy = boundedTrimmed(authorization.authorizedBy, 128, "migration authorization actor");
  const authorizedAt = canonicalTimestamp(authorization.authorizedAt, "migration authorization timestamp");
  const auditHash = hash(authorization.auditHash, "migration audit hash");
  const rollbackRetentionUntil = canonicalTimestamp(authorization.rollbackRetentionUntil, "migration rollback retention timestamp");
  if (Date.parse(rollbackRetentionUntil) < Date.parse(authorizedAt)) throw new Error("migration rollback retention predates authorization");
  const rationale = boundedTrimmed(authorization.rationale, 2048, "migration authorization rationale");
  const dispositions = requireRecord(authorization.topicDispositions, "migration topic dispositions");
  const topics = Object.keys(dispositions);
  if (topics.length < 1 || topics.length > 100 || JSON.stringify(topics) !== JSON.stringify([...topics].sort())) throw new Error("migration topic dispositions must be bounded and canonically sorted");
  const topicDispositions: Record<string, Gate1Disposition> = {};
  for (const topic of topics) {
    assertTopic(topic);
    const disposition = dispositions[topic];
    if (!isGateDisposition(disposition)) throw new Error(`invalid migration disposition for ${topic}`);
    topicDispositions[topic] = disposition;
  }
  return { authorizedBy, authorizedAt, auditHash, topicDispositions, rollbackRetentionUntil, rationale };
}

export function migrationPlanHash(value: {
  schemaVersion: 2;
  topic: string;
  classification: MigratableClassification;
  disposition: MigrationDisposition;
  generatedAt: string;
  sourcePaths: string[];
  preimageHash: string;
  postimageHash: string | null;
  eligible: boolean;
  authorization: Gate1Authorization;
}): string {
  return sha256(stableJson(value));
}

export function parseSweMigrationReceipt(value: unknown, options: { path: string; allowLegacy?: boolean }): SweMigrationReceipt {
  const receipt = requireRecord(value, "workflow migration receipt");
  if (receipt.schemaVersion === 1) {
    if (!options.allowLegacy) throw new Error("legacy workflow migration receipt cannot authorize a new migration");
    return parseLegacyReceipt(receipt, options.path);
  }
  if (receipt.schemaVersion !== 2) throw new Error("unsupported workflow migration receipt schemaVersion");
  const state = stateValue(receipt.state);
  exactKeys(receipt, ["schemaVersion", "topic", "state", "classification", "disposition", "generatedAt", "sourcePaths", "preimageHash", "postimageHash", "eligible", "authorization", "planHash", "appliedAt", "preimagePayload", ...(state === "rolled-back" ? ["rolledBackAt"] : [])], "workflow migration receipt");
  const topic = topicValue(receipt.topic);
  assertReceiptPath(options.path, topic, receipt.planHash, false);
  if (options.path.includes("/attempts/") && state !== "rolled-back") throw new Error("only rolled-back migration receipts may be retained as attempts");
  const classification = classificationValue(receipt.classification);
  const disposition = dispositionValue(receipt.disposition);
  validateClassificationDisposition(classification, disposition);
  const generatedAt = canonicalTimestamp(receipt.generatedAt, "migration generatedAt");
  const sourcePaths = sourcePathValues(receipt.sourcePaths);
  validateSourceRelationship(topic, classification, sourcePaths);
  const preimageHash = hash(receipt.preimageHash, "migration preimage hash");
  const postimageHash = hash(receipt.postimageHash, "migration postimage hash");
  if (receipt.eligible !== true) throw new Error("migration receipt eligibility must be true");
  const authorization = parseGate1Authorization(receipt.authorization);
  if (authorization.authorizedAt !== generatedAt || authorization.topicDispositions[topic] !== disposition || authorization.authorizedBy.length === 0) throw new Error("migration receipt authorization does not match the selected plan");
  const planHash = hash(receipt.planHash, "migration plan hash");
  const expectedPlanHash = migrationPlanHash({ schemaVersion: 2, topic, classification, disposition, generatedAt, sourcePaths, preimageHash, postimageHash, eligible: true, authorization });
  if (planHash !== expectedPlanHash) throw new Error("workflow migration receipt plan hash mismatch");
  const appliedAt = canonicalTimestamp(receipt.appliedAt, "migration appliedAt");
  if (Date.parse(appliedAt) < Date.parse(authorization.authorizedAt)) throw new Error("migration apply predates authorization");
  if (Date.parse(appliedAt) > Date.parse(authorization.rollbackRetentionUntil)) throw new Error("migration apply exceeds authorized rollback retention");
  const preimagePayload = payloadValue(receipt.preimagePayload, classification, preimageHash);
  const rolledBackAt = state === "rolled-back" ? canonicalTimestamp(receipt.rolledBackAt, "migration rolledBackAt") : undefined;
  if (rolledBackAt && Date.parse(rolledBackAt) < Date.parse(appliedAt)) throw new Error("migration rollback predates apply");
  return { schemaVersion: 2, topic, state, classification, disposition, generatedAt, sourcePaths, preimageHash, postimageHash, eligible: true, authorization, planHash, appliedAt, preimagePayload, ...(rolledBackAt ? { rolledBackAt } : {}) };
}

export function parseSweMigrationJournal(value: unknown, options: { path: string }): SweMigrationJournal {
  const journal = requireRecord(value, "workflow migration journal");
  if (journal.schemaVersion === 1) {
    exactKeys(journal, ["schemaVersion", "stage", "planHash", "topic", "preimageHash", "postimageHash", "receipt"], "legacy workflow migration journal");
    if (journal.stage !== "prepared") throw new Error("legacy workflow migration journal stage is invalid");
    const receiptPath = canonicalReceiptPath(topicValue(journal.topic));
    const receipt = parseSweMigrationReceipt(journal.receipt, { path: receiptPath, allowLegacy: true });
    if (receipt.schemaVersion !== 1 || receipt.state !== "applied") throw new Error("legacy workflow migration journal receipt is invalid");
    const parsed = journalIdentity(journal, receipt);
    assertJournalPath(options.path, parsed.topic);
    return { schemaVersion: 1, stage: "prepared", ...parsed, receipt };
  }
  if (journal.schemaVersion !== 2) throw new Error("unsupported workflow migration journal schemaVersion");
  exactKeys(journal, ["schemaVersion", "operation", "stage", "topic", "preimageHash", "postimageHash", "planHash", "receipt"], "workflow migration journal");
  if (journal.operation !== "apply" || journal.stage !== "prepared") throw new Error("workflow migration journal operation or stage is invalid");
  const topic = topicValue(journal.topic);
  const receipt = parseSweMigrationReceipt(journal.receipt, { path: canonicalReceiptPath(topic) });
  if (receipt.schemaVersion !== 2 || receipt.state !== "applied") throw new Error("workflow migration journal receipt is invalid");
  const parsed = journalIdentity(journal, receipt);
  assertJournalPath(options.path, parsed.topic);
  return { schemaVersion: 2, operation: "apply", stage: "prepared", ...parsed, receipt };
}

export function receiptEquals(left: SweMigrationReceipt, right: SweMigrationReceipt): boolean {
  return stableJson(left) === stableJson(right);
}

function parseLegacyReceipt(receipt: Record<string, unknown>, path: string): SweMigrationReceiptV1 {
  const state = stateValue(receipt.state);
  const required = ["schemaVersion", "topic", "state", "classification", "disposition", "decidedBy", "sourcePaths", "preimageHash", "postimageHash", "planHash", "appliedAt"];
  const optional = ["preimagePayload", ...(state === "rolled-back" ? ["rolledBackAt"] : [])];
  exactKeys(receipt, [...required, ...optional.filter((key) => Object.hasOwn(receipt, key))], "legacy workflow migration receipt");
  if (required.some((key) => !Object.hasOwn(receipt, key))) throw new Error("legacy workflow migration receipt is missing required fields");
  const topic = topicValue(receipt.topic);
  assertReceiptPath(path, topic, receipt.planHash, false);
  if (path.includes("/attempts/") && state !== "rolled-back") throw new Error("only rolled-back legacy migration receipts may be retained as attempts");
  const classification = classificationValue(receipt.classification);
  const disposition = dispositionValue(receipt.disposition);
  validateClassificationDisposition(classification, disposition);
  const decidedBy = boundedTrimmed(receipt.decidedBy, 128, "legacy migration actor");
  const sourcePaths = sourcePathValues(receipt.sourcePaths);
  validateSourceRelationship(topic, classification, sourcePaths);
  const preimageHash = hash(receipt.preimageHash, "legacy migration preimage hash");
  const postimageHash = hash(receipt.postimageHash, "legacy migration postimage hash");
  const planHash = hash(receipt.planHash, "legacy migration plan hash");
  const appliedAt = canonicalTimestamp(receipt.appliedAt, "legacy migration appliedAt");
  const preimagePayload = Object.hasOwn(receipt, "preimagePayload") ? payloadString(receipt.preimagePayload, preimageHash) : undefined;
  if (classification.startsWith("native-v1") && !preimagePayload) throw new Error("legacy native migration receipt requires authenticated preimage payload");
  const rolledBackAt = state === "rolled-back" ? canonicalTimestamp(receipt.rolledBackAt, "legacy migration rolledBackAt") : undefined;
  if (rolledBackAt && Date.parse(rolledBackAt) < Date.parse(appliedAt)) throw new Error("legacy migration rollback predates apply");
  return { schemaVersion: 1, topic, state, classification, disposition, decidedBy, sourcePaths, preimageHash, postimageHash, planHash, appliedAt, ...(preimagePayload ? { preimagePayload } : {}), ...(rolledBackAt ? { rolledBackAt } : {}) };
}

function journalIdentity(journal: Record<string, unknown>, receipt: SweMigrationReceipt): Pick<SweMigrationJournalV2, "topic" | "preimageHash" | "postimageHash" | "planHash"> {
  const topic = topicValue(journal.topic);
  const preimageHash = hash(journal.preimageHash, "journal preimage hash");
  const postimageHash = hash(journal.postimageHash, "journal postimage hash");
  const planHash = hash(journal.planHash, "journal plan hash");
  if (topic !== receipt.topic || preimageHash !== receipt.preimageHash || postimageHash !== receipt.postimageHash || planHash !== receipt.planHash) throw new Error("workflow migration journal identity mismatch");
  return { topic, preimageHash, postimageHash, planHash };
}

function validateClassificationDisposition(classification: MigratableClassification, disposition: MigrationDisposition): void {
  const complete = classification.endsWith("-complete");
  if (complete ? !["reopen", "grandfather-read-only"].includes(disposition) : disposition !== "continue") throw new Error("migration classification and disposition are inconsistent");
}
function validateSourceRelationship(topic: string, classification: MigratableClassification, paths: string[]): void {
  if (classification.startsWith("native-v1") && (paths.length !== 1 || paths[0] !== `.model-artifacts/initiatives/${topic}/workflow.json`)) throw new Error("native migration source path does not match topic identity");
  if (classification.startsWith("historical-contracts") && !paths.includes(`.model-artifacts/initiatives/${topic}/specs/manifest.json`)) throw new Error("historical migration source paths do not match topic identity");
}
function sourcePathValues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) throw new Error("migration source paths must be a bounded array");
  const paths = value.map((path) => {
    if (typeof path !== "string" || !path.startsWith(".model-artifacts/") || path.includes("\\") || path.length > 1024 || path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("unsafe migration source path");
    return path;
  });
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw new Error("migration source paths must be sorted and unique");
  return paths;
}
function payloadValue(value: unknown, classification: MigratableClassification, expectedHash: string): string | null {
  if (classification.startsWith("native-v1")) return payloadString(value, expectedHash);
  if (value !== null) throw new Error("historical migration receipt must use an explicit null preimage payload");
  return null;
}
function payloadString(value: unknown, expectedHash: string): string {
  if (typeof value !== "string" || !BASE64.test(value)) throw new Error("migration preimage payload is not canonical base64");
  const payload = Buffer.from(value, "base64");
  if (payload.length > MAX_PAYLOAD_BYTES || payload.toString("base64") !== value || sha256(payload) !== expectedHash) throw new Error("migration preimage payload does not match its hash or bound");
  return value;
}
function assertReceiptPath(path: string, topic: string, planHash: unknown, archiveOnly: boolean): void {
  const canonical = canonicalReceiptPath(topic);
  const archive = typeof planHash === "string" && HASH.test(planHash) ? canonical.replace("/receipt.json", `/attempts/${planHash.slice(7)}-receipt.json`) : "";
  if (archiveOnly ? path !== archive : path !== canonical && path !== archive) throw new Error("workflow migration receipt path identity mismatch");
}
function assertJournalPath(path: string, topic: string): void {
  if (path !== canonicalReceiptPath(topic).replace("receipt.json", "journal.json")) throw new Error("workflow migration journal path identity mismatch");
}
function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be canonical ISO-8601`);
  return value;
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function boundedTrimmed(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value) throw new Error(`${label} is required, trimmed, and bounded`);
  return value;
}
function classificationValue(value: unknown): MigratableClassification {
  if (!CLASSIFICATIONS.includes(value as MigratableClassification)) throw new Error("migration classification is invalid");
  return value as MigratableClassification;
}
function dispositionValue(value: unknown): MigrationDisposition {
  if (!isMigrationDisposition(value)) throw new Error("migration disposition is invalid");
  return value;
}
function stateValue(value: unknown): "applied" | "rolled-back" {
  if (value !== "applied" && value !== "rolled-back") throw new Error("migration receipt state is invalid");
  return value;
}
function topicValue(value: unknown): string { if (typeof value !== "string") throw new Error("migration topic is invalid"); assertTopic(value); return value; }
function assertTopic(value: string): void { if (!TOPIC.test(value) || value.length > 256) throw new Error("migration topic is invalid"); }
function isMigrationDisposition(value: unknown): value is MigrationDisposition { return value === "continue" || value === "reopen" || value === "grandfather-read-only"; }
function isGateDisposition(value: unknown): value is Gate1Disposition { return isMigrationDisposition(value) || value === "block"; }
function requireRecord(value: unknown, label: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`${label} must be an object`); return value; }
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${label} has unknown or missing fields`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
