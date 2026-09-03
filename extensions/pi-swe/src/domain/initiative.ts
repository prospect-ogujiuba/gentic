import { posix } from "node:path";

export const PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION = 2 as const;

export const PI_SWE_INITIATIVE_STATES = [
  "intake",
  "specifying",
  "planning",
  "reviewing",
  "approved",
  "executing",
  "finalizing",
  "complete",
  "blocked",
] as const;

export type PiSweInitiativeState = (typeof PI_SWE_INITIATIVE_STATES)[number];
export type PiSweDraftInitiativeState = Extract<PiSweInitiativeState, "intake" | "specifying" | "planning" | "reviewing" | "blocked">;
export type PiSweApprovedInitiativeState = Extract<PiSweInitiativeState, "approved" | "executing" | "finalizing" | "complete">;

export type InitiativeRevisionPointer = {
  revision: number;
  path: string;
  contentHash: string;
};

export type InitiativePlanPointer = InitiativeRevisionPointer & {
  contractRoot: string;
};

export type PlanReviewDecision = "approve";
export type InitiativeApprovalState = "approved";

export type InitiativeApproval = {
  decision: InitiativeApprovalState;
  planRevision: number;
  planPath: string;
  planContentHash: string;
  reviewPath: string;
  approvedAt: string;
  blockingFindings: 0;
};

export type InitiativeActiveContract = {
  id: string;
  path: string;
};

export type InitiativeSpecialistStatus = "required" | "not-required" | "complete" | "blocked";

export type InitiativeSpecialistEntry = {
  status: InitiativeSpecialistStatus;
  rationale?: string;
  findingPath?: string;
};

export type InitiativeSpecialists = Readonly<Record<string, InitiativeSpecialistEntry>>;

type InitiativeManifestBase = {
  schemaVersion: typeof PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION;
  initiativeId: string;
  topic: string;
  activeSpec: InitiativeRevisionPointer;
  specialists: InitiativeSpecialists;
  updatedAt: string;
};

export type DraftInitiativeManifest = InitiativeManifestBase & {
  initiativeState: PiSweDraftInitiativeState;
  activePlan?: InitiativePlanPointer;
  activeContract?: never;
  approval?: never;
};

export type ApprovedInitiativeManifest = InitiativeManifestBase & {
  initiativeState: PiSweApprovedInitiativeState;
  activePlan: InitiativePlanPointer;
  approval: InitiativeApproval;
  activeContract?: InitiativeActiveContract;
};

export type InitiativeManifest = DraftInitiativeManifest | ApprovedInitiativeManifest;

export type InitiativeManifestDiagnosticCode =
  | "unsupported_schema_version"
  | "missing_field"
  | "invalid_field"
  | "invalid_topic"
  | "identity_mismatch"
  | "invalid_path"
  | "stale_approval"
  | "blocking_findings";

export type InitiativeManifestDiagnostic = {
  code: InitiativeManifestDiagnosticCode;
  field: string;
  message: string;
};

export type ParseInitiativeManifestResult =
  | { ok: true; manifest: InitiativeManifest }
  | { ok: false; diagnostics: InitiativeManifestDiagnostic[] };

type MutableDiagnostics = InitiativeManifestDiagnostic[];
type UnknownRecord = Record<string, unknown>;

const APPROVED_STATES = new Set<PiSweInitiativeState>(["approved", "executing", "finalizing", "complete"]);
const SPECIALIST_STATUSES = new Set<InitiativeSpecialistStatus>(["required", "not-required", "complete", "blocked"]);

export function parseInitiativeManifest(value: unknown): ParseInitiativeManifestResult {
  if (!isRecord(value)) return failure("invalid_field", "$", "manifest must be an object");
  if (value.schemaVersion !== PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION) {
    return failure("unsupported_schema_version", "schemaVersion", `supported schema version is ${PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION}`);
  }

  const diagnostics: MutableDiagnostics = [];
  const initiativeState = readInitiativeState(value.initiativeState, diagnostics);
  const expectedKeys = new Set([
    "schemaVersion", "initiativeId", "topic", "initiativeState", "activeSpec", "activePlan",
    "activeContract", "approval", "specialists", "updatedAt", "piSweMigration",
  ]);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) add(diagnostics, "invalid_field", key, `manifest contains unsupported field ${key}`);
  }
  const initiativeId = readString(value, "initiativeId", diagnostics);
  const topic = readString(value, "topic", diagnostics);
  const updatedAt = readTimestamp(value.updatedAt, "updatedAt", diagnostics);

  if (initiativeId && !isValidTopic(initiativeId)) add(diagnostics, "invalid_topic", "initiativeId", "initiativeId must contain safe non-empty path segments");
  if (topic && !isValidTopic(topic)) add(diagnostics, "invalid_topic", "topic", "topic must contain safe non-empty path segments");
  if (initiativeId && topic && initiativeId !== topic) add(diagnostics, "identity_mismatch", "topic", "topic must exactly match initiativeId");

  const canonicalTopic = initiativeId && isValidTopic(initiativeId) ? initiativeId : topic;
  const activeSpec = canonicalTopic ? readRevisionPointer(value.activeSpec, "activeSpec", "specs", canonicalTopic, diagnostics) : undefined;
  const activePlan = canonicalTopic && value.activePlan !== undefined
    ? readPlanPointer(value.activePlan, canonicalTopic, diagnostics)
    : undefined;
  const specialists = canonicalTopic ? readSpecialists(value.specialists, canonicalTopic, diagnostics) : undefined;
  if (value.piSweMigration !== undefined) readManifestMigration(value.piSweMigration, diagnostics);

  if (!initiativeState || !canonicalTopic || !initiativeId || !topic || !updatedAt || !activeSpec || !specialists) return { ok: false, diagnostics };

  if (APPROVED_STATES.has(initiativeState)) {
    if (!activePlan) add(diagnostics, "missing_field", "activePlan", "approved initiative state requires an active plan");
    const approval = activePlan ? readApproval(value.approval, activePlan, canonicalTopic, diagnostics) : undefined;
    const activeContract = activePlan && value.activeContract !== undefined
      ? readActiveContract(value.activeContract, activePlan, diagnostics)
      : undefined;

    if (diagnostics.length || !activePlan || !approval) return { ok: false, diagnostics };
    return {
      ok: true,
      manifest: {
        schemaVersion: PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION,
        initiativeId,
        topic,
        initiativeState: asApprovedState(initiativeState),
        activeSpec,
        activePlan,
        approval,
        ...(activeContract ? { activeContract } : {}),
        specialists,
        updatedAt,
      },
    };
  }

  if (value.approval !== undefined) add(diagnostics, "invalid_field", "approval", "draft initiative state cannot contain approval");
  if (value.activeContract !== undefined) add(diagnostics, "invalid_field", "activeContract", "draft initiative state cannot contain an active contract");
  if (diagnostics.length) return { ok: false, diagnostics };

  return {
    ok: true,
    manifest: {
      schemaVersion: PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION,
      initiativeId,
      topic,
      initiativeState: asDraftState(initiativeState),
      activeSpec,
      ...(activePlan ? { activePlan } : {}),
      specialists,
      updatedAt,
    },
  };
}

export function isValidTopic(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment));
}

function readRevisionPointer(value: unknown, field: string, kind: "specs", topic: string, diagnostics: MutableDiagnostics): InitiativeRevisionPointer | undefined {
  if (!isRecord(value)) {
    add(diagnostics, "missing_field", field, `${field} must be an object`);
    return undefined;
  }
  rejectUnknownFields(value, new Set(["revision", "path", "contentHash"]), field, diagnostics);
  const revision = readPositiveInteger(value.revision, `${field}.revision`, diagnostics);
  const path = readArtifactPath(value.path, `${field}.path`, [kind], topic, diagnostics);
  const contentHash = readContentHash(value.contentHash, `${field}.contentHash`, diagnostics);
  return revision && path && contentHash ? { revision, path, contentHash } : undefined;
}

function readPlanPointer(value: unknown, topic: string, diagnostics: MutableDiagnostics): InitiativePlanPointer | undefined {
  if (!isRecord(value)) {
    add(diagnostics, "invalid_field", "activePlan", "activePlan must be an object");
    return undefined;
  }
  rejectUnknownFields(value, new Set(["revision", "path", "contractRoot", "contentHash"]), "activePlan", diagnostics);
  const revision = readPositiveInteger(value.revision, "activePlan.revision", diagnostics);
  const path = readArtifactPath(value.path, "activePlan.path", ["plans"], topic, diagnostics);
  const contractRoot = readArtifactPath(value.contractRoot, "activePlan.contractRoot", ["plans"], topic, diagnostics, true);
  const contentHash = readContentHash(value.contentHash, "activePlan.contentHash", diagnostics);
  return revision && path && contractRoot && contentHash ? { revision, path, contractRoot, contentHash } : undefined;
}

function readApproval(value: unknown, plan: InitiativePlanPointer, topic: string, diagnostics: MutableDiagnostics): InitiativeApproval | undefined {
  if (!isRecord(value)) {
    add(diagnostics, "missing_field", "approval", "approved initiative state requires approval");
    return undefined;
  }
  rejectUnknownFields(value, new Set(["decision", "planRevision", "planPath", "planContentHash", "reviewPath", "approvedAt", "blockingFindings"]), "approval", diagnostics);
  const decision = value.decision === "approve" ? "approved" : value.decision;
  if (decision !== "approved") add(diagnostics, "invalid_field", "approval.decision", "approval decision must be approved (legacy approve is accepted)");
  const planRevision = readPositiveInteger(value.planRevision, "approval.planRevision", diagnostics);
  const planPath = readArtifactPath(value.planPath, "approval.planPath", ["plans"], topic, diagnostics);
  const planContentHash = readContentHash(value.planContentHash, "approval.planContentHash", diagnostics);
  const reviewPath = readArtifactPath(value.reviewPath, "approval.reviewPath", ["findings", "reports"], topic, diagnostics);
  const approvedAt = readTimestamp(value.approvedAt, "approval.approvedAt", diagnostics);
  const blockingFindings = value.blockingFindings;
  if (blockingFindings !== 0) add(diagnostics, "blocking_findings", "approval.blockingFindings", "approved plan must have zero blocking findings");

  if (planRevision !== undefined && planRevision !== plan.revision) add(diagnostics, "stale_approval", "approval.planRevision", "approval revision must match active plan revision");
  if (planPath && planPath !== plan.path) add(diagnostics, "stale_approval", "approval.planPath", "approval path must match active plan path");
  if (planContentHash && planContentHash !== plan.contentHash) add(diagnostics, "stale_approval", "approval.planContentHash", "approval content hash must match active plan content hash");

  if (decision !== "approved" || !planRevision || !planPath || !planContentHash || !reviewPath || !approvedAt || blockingFindings !== 0) return undefined;
  return { decision: "approved", planRevision, planPath, planContentHash, reviewPath, approvedAt, blockingFindings: 0 };
}

function readActiveContract(value: unknown, plan: InitiativePlanPointer, diagnostics: MutableDiagnostics): InitiativeActiveContract | undefined {
  if (!isRecord(value)) {
    add(diagnostics, "invalid_field", "activeContract", "activeContract must be an object");
    return undefined;
  }
  rejectUnknownFields(value, new Set(["id", "path"]), "activeContract", diagnostics);
  const id = readNonEmptyString(value.id, "activeContract.id", diagnostics);
  const path = readNonEmptyString(value.path, "activeContract.path", diagnostics);
  if (path && (!isSafeRelativePath(path) || !path.startsWith(`${plan.contractRoot}/`))) {
    add(diagnostics, "invalid_path", "activeContract.path", "active contract path must be within the active plan contract root");
    return undefined;
  }
  return id && path ? { id, path } : undefined;
}

function readSpecialists(value: unknown, topic: string, diagnostics: MutableDiagnostics): InitiativeSpecialists | undefined {
  if (!isRecord(value)) {
    add(diagnostics, "missing_field", "specialists", "specialists must be an object");
    return undefined;
  }
  const specialists: Record<string, InitiativeSpecialistEntry> = {};
  for (const [persistedKey, candidate] of Object.entries(value)) {
    const key = persistedKey === "accessibilityUx" || persistedKey === "ACCESSIBILITY_UX" ? "accessibility-ux" : persistedKey;
    if (specialists[key] !== undefined) {
      add(diagnostics, "invalid_field", `specialists.${persistedKey}`, `specialist alias ${persistedKey} conflicts with ${key}`);
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || !isRecord(candidate) || !SPECIALIST_STATUSES.has(candidate.status as InitiativeSpecialistStatus)) {
      add(diagnostics, "invalid_field", `specialists.${key}`, "specialist entry must have a valid key and status");
      continue;
    }
    rejectUnknownFields(candidate, new Set(["status", "rationale", "findingPath"]), `specialists.${key}`, diagnostics);
    const status = candidate.status as InitiativeSpecialistStatus;
    const rationale = candidate.rationale === undefined ? undefined : readNonEmptyString(candidate.rationale, `specialists.${key}.rationale`, diagnostics);
    const findingPath = candidate.findingPath === undefined
      ? undefined
      : readArtifactPath(candidate.findingPath, `specialists.${key}.findingPath`, ["findings", "reports"], topic, diagnostics);
    specialists[key] = { status, ...(rationale ? { rationale } : {}), ...(findingPath ? { findingPath } : {}) };
  }
  return specialists;
}

function readManifestMigration(value: unknown, diagnostics: MutableDiagnostics): void {
  const field = "piSweMigration";
  if (!isRecord(value)) {
    add(diagnostics, "invalid_field", field, `${field} must be an object`);
    return;
  }
  rejectUnknownFields(value, new Set(["schemaVersion", "operation", "requestId", "migratedAt", "fields"]), field, diagnostics);
  if (value.schemaVersion !== 1) add(diagnostics, "invalid_field", `${field}.schemaVersion`, `${field}.schemaVersion must be 1`);
  if (value.operation !== "normalize-manifest-metadata") add(diagnostics, "invalid_field", `${field}.operation`, `${field}.operation is unsupported`);
  if (typeof value.requestId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.requestId)) add(diagnostics, "invalid_field", `${field}.requestId`, `${field}.requestId must use sha256:<64 lowercase hex>`);
  readTimestamp(value.migratedAt, `${field}.migratedAt`, diagnostics);
  if (!Array.isArray(value.fields) || value.fields.some((entry) => entry !== "approval.decision" && entry !== "specialists.accessibility-ux")) {
    add(diagnostics, "invalid_field", `${field}.fields`, `${field}.fields contains unsupported metadata normalization`);
  }
}

function rejectUnknownFields(value: UnknownRecord, expected: ReadonlySet<string>, field: string, diagnostics: MutableDiagnostics): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) add(diagnostics, "invalid_field", `${field}.${key}`, `${field} contains unsupported field ${key}`);
  }
}

function readArtifactPath(value: unknown, field: string, kinds: string[], topic: string, diagnostics: MutableDiagnostics, allowDirectory = false): string | undefined {
  const path = readNonEmptyString(value, field, diagnostics);
  if (!path) return undefined;
  const prefixes = kinds.map((kind) => `.model-artifacts/initiatives/${topic}/${kind}/`);
  const directoryMatches = allowDirectory && kinds.some((kind) => path === `.model-artifacts/initiatives/${topic}/${kind}`);
  if (!isSafeRelativePath(path) || (!directoryMatches && !prefixes.some((prefix) => path.startsWith(prefix)))) {
    add(diagnostics, "invalid_path", field, `${field} must stay within ${kinds.join(" or ")} for topic ${topic}`);
    return undefined;
  }
  return path;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || posix.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return posix.normalize(value) === value;
}

function readInitiativeState(value: unknown, diagnostics: MutableDiagnostics): PiSweInitiativeState | undefined {
  if (typeof value === "string" && (PI_SWE_INITIATIVE_STATES as readonly string[]).includes(value)) return value as PiSweInitiativeState;
  add(diagnostics, "invalid_field", "initiativeState", "initiativeState is not supported");
  return undefined;
}

function readString(record: UnknownRecord, field: string, diagnostics: MutableDiagnostics): string | undefined {
  return readNonEmptyString(record[field], field, diagnostics);
}

function readContentHash(value: unknown, field: string, diagnostics: MutableDiagnostics): string | undefined {
  const hash = readNonEmptyString(value, field, diagnostics);
  if (hash && !/^sha256:[a-f0-9]{64}$/.test(hash)) {
    add(diagnostics, "invalid_field", field, `${field} must use sha256:<64 lowercase hex>`);
    return undefined;
  }
  return hash;
}

function readNonEmptyString(value: unknown, field: string, diagnostics: MutableDiagnostics): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    add(diagnostics, value === undefined ? "missing_field" : "invalid_field", field, `${field} must be a non-empty bounded string`);
    return undefined;
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string, diagnostics: MutableDiagnostics): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    add(diagnostics, value === undefined ? "missing_field" : "invalid_field", field, `${field} must be a positive integer`);
    return undefined;
  }
  return value as number;
}

function readTimestamp(value: unknown, field: string, diagnostics: MutableDiagnostics): string | undefined {
  const timestamp = readNonEmptyString(value, field, diagnostics);
  if (!timestamp) return undefined;
  if (!Number.isFinite(Date.parse(timestamp))) {
    add(diagnostics, "invalid_field", field, `${field} must be an ISO-compatible timestamp`);
    return undefined;
  }
  return timestamp;
}

function asDraftState(value: PiSweInitiativeState): PiSweDraftInitiativeState {
  switch (value) {
    case "intake":
    case "specifying":
    case "planning":
    case "reviewing":
    case "blocked":
      return value;
    default:
      throw new Error(`approved state cannot be used as draft: ${value}`);
  }
}

function asApprovedState(value: PiSweInitiativeState): PiSweApprovedInitiativeState {
  switch (value) {
    case "approved":
    case "executing":
    case "finalizing":
    case "complete":
      return value;
    default:
      throw new Error(`draft state cannot be used as approved: ${value}`);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(diagnostics: MutableDiagnostics, code: InitiativeManifestDiagnosticCode, field: string, message: string): void {
  diagnostics.push({ code, field, message });
}

function failure(code: InitiativeManifestDiagnosticCode, field: string, message: string): ParseInitiativeManifestResult {
  return { ok: false, diagnostics: [{ code, field, message }] };
}
