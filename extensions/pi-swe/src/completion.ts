import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeContractGraph, type ContractNode } from "./domain/contract-graph.ts";
import { isValidTopic, type InitiativeManifest } from "./domain/initiative.ts";
import { deriveCanonicalCompletionRequestId, inspectCanonicalInitiative, type CanonicalCompletionRecord } from "./planning.ts";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type CompleteCanonicalContractRequest = {
  readonly cwd: string;
  readonly topic: string;
  readonly contractId: string;
  readonly expectedPlanRevision: number;
  readonly expectedContractPath: string;
  readonly expectedPreCompletionContentHash: string;
  readonly verification: { readonly path: string; readonly contentHash: string };
  readonly review: { readonly path: string; readonly contentHash: string; readonly decision: "approve" };
  readonly nextActiveContract: "clear" | "advance";
  readonly completedAt?: string;
};

export const COMPLETION_FAULT_POINTS = [
  "after-contract-index-prepared",
  "after-contract-index-backup",
  "after-manifest-prepared",
  "after-manifest-backup",
  "after-prepared-files",
  "after-stage-prepared",
  "after-contract-index-rename",
  "after-contract-index-installed",
  "after-manifest-rename",
  "after-manifest-installed",
  "after-rollback-stage",
  "after-restore-contract-index",
  "after-restore-manifest",
  "after-validated",
  "after-cleanup-stage",
  "after-cleanup-artifact",
] as const;
export type CompletionFaultPoint = (typeof COMPLETION_FAULT_POINTS)[number];
export type CompletionOptions = { readonly faultInjector?: (point: CompletionFaultPoint) => void };

export type CompletionSuccess = {
  readonly status: "completed";
  readonly contractId: string;
  readonly requestId: string;
  readonly readyContractIds: readonly string[];
  readonly activeContractId: string | null;
  readonly phaseProgress: string;
};
export type CompletionAlreadyComplete = {
  readonly status: "already-complete";
  readonly contractId: string;
  readonly requestId: string;
  readonly recordedNextState: CanonicalCompletionRecord["nextState"];
  readonly currentReadyContractIds: readonly string[];
  readonly currentActiveContractId: string | null;
};
export type CompletionFailure = {
  readonly status: "rejected" | "conflict" | "blocked-recovery";
  readonly contractId?: string;
  readonly message: string;
  readonly artifact?: string;
};
export type CompleteCanonicalContractResult = CompletionSuccess | CompletionAlreadyComplete | CompletionFailure;

export type RecoverCanonicalCompletionRequest = { readonly cwd: string; readonly topic: string };
export type RecoverCanonicalCompletionResult =
  | { readonly status: "no-transaction" }
  | { readonly status: "rolled-back"; readonly requestId: string }
  | { readonly status: "committed-cleanup"; readonly requestId: string }
  | { readonly status: "blocked-recovery"; readonly message: string; readonly artifact: string };

type TransactionStage = "prepared" | "contract-index-installed" | "manifest-installed" | "rollback" | "validated" | "cleanup";
type TransactionRoleName = "contract-index" | "manifest";
type TransactionRole = {
  readonly targetPath: string;
  readonly preparedPath: string;
  readonly preparedHash: string;
  readonly preimageBackupPath: string;
  readonly preimageHash: string;
  readonly restorePath: string;
};
type CompletionJournal = {
  readonly schemaVersion: 1;
  readonly topic: string;
  readonly ownerToken: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly stage: TransactionStage;
  readonly roles: Readonly<Record<TransactionRoleName, TransactionRole>>;
};
type MutableJson = Record<string, any>;

type CompletionContext = {
  readonly root: string;
  readonly topic: string;
  readonly journalPath: string;
  readonly options: CompletionOptions;
  ownerToken?: string;
};
type CompletionClaim = { readonly schemaVersion: 1; readonly token: string; readonly pid: number; readonly requestId: string; readonly createdAt: string };
type VerificationEnvelope = {
  readonly schemaVersion: 1;
  readonly mode: "verification";
  readonly topic: string;
  readonly contractId: string;
  readonly contractPath: string;
  readonly planRevision: number;
  readonly contractContentHash: string;
  readonly outcome: "pass";
  readonly gaps: "none";
};
type ReviewEnvelope = {
  readonly schemaVersion: 1;
  readonly mode: "implementation-review";
  readonly topic: string;
  readonly contractId: string;
  readonly contractPath: string;
  readonly planRevision: number;
  readonly contractContentHash: string;
  readonly decision: "approve";
  readonly blockingFindings: 0;
  readonly verification: { readonly path: string; readonly contentHash: string };
};

export function completionJournalPath(topic: string): string {
  return `.model-artifacts/logs/${topic}/completion-transaction.json`;
}

export function completionClaimPath(topic: string): string {
  return `.model-artifacts/logs/${topic}/completion-transaction.lock`;
}

export function deriveCompletionRequestId(request: CompleteCanonicalContractRequest): string {
  return deriveCanonicalCompletionRequestId({
    topic: request.topic,
    contractId: request.contractId,
    planRevision: request.expectedPlanRevision,
    contractPath: request.expectedContractPath,
    preCompletionContentHash: request.expectedPreCompletionContentHash,
    verification: request.verification,
    review: request.review,
  });
}

export function completeCanonicalContract(
  request: CompleteCanonicalContractRequest,
  options: CompletionOptions = {},
): CompleteCanonicalContractResult {
  const requestError = validateCompletionRequest(request);
  if (requestError) return { status: "rejected", contractId: request.contractId, message: requestError };
  const context = createContext(request.cwd, request.topic, options);
  if (!context) return { status: "rejected", contractId: request.contractId, message: "repository cwd or topic is invalid" };
  const requestId = deriveCompletionRequestId(request);
  const existingJournal = existsSync(absolute(context, context.journalPath)) ? readJournal(context) : undefined;
  const claim = acquireCompletionClaim(context, requestId, existingJournal?.ownerToken);
  if (!claim) {
    return { status: "conflict", contractId: request.contractId, message: "another local completion transaction owns this topic", artifact: completionClaimPath(request.topic) };
  }
  context.ownerToken = claim.token;
  try {
  if (existsSync(absolute(context, context.journalPath))) {
    const recovery = recoverWithContext(context);
    if (recovery.status === "blocked-recovery") return { ...recovery, contractId: request.contractId };
  }

  const inspection = inspectCanonicalInitiative({ cwd: context.root, topic: request.topic });
  if (inspection.diagnostics.length || !inspection.manifest?.activePlan || !inspection.gateEvaluation?.approvalValid) {
    return { status: "rejected", contractId: request.contractId, message: firstInspectionProblem(inspection), artifact: inspection.manifestPath };
  }
  const manifest = inspection.manifest;
  const indexPath = `${manifest.activePlan!.contractRoot}/contracts.json`;
  const index = readBoundedJson(context, indexPath);
  if (!index || !Array.isArray(index.contracts)) return { status: "rejected", contractId: request.contractId, message: "active contract index is unavailable", artifact: indexPath };
  const contract = index.contracts.find((candidate: any) => candidate?.id === request.contractId);
  if (!contract) return { status: "rejected", contractId: request.contractId, message: `contract ${request.contractId} is not indexed`, artifact: indexPath };

  if (contract.status === "complete") {
    const record = inspection.completionRecords[request.contractId];
    if (!record || !completionIdentityMatches(record, request, requestId) || !evidenceRemainsValid(context, request)) {
      return { status: "conflict", contractId: request.contractId, message: `completed contract ${request.contractId} has a different durable completion identity`, artifact: indexPath };
    }
    return {
      status: "already-complete",
      contractId: request.contractId,
      requestId,
      recordedNextState: record.nextState,
      currentReadyContractIds: inspection.readyIds,
      currentActiveContractId: manifest.activeContract?.id ?? null,
    };
  }

  const guardFailure = validateMutationGuards(request, manifest, index.contracts, contract, inspection.readyIds);
  if (guardFailure) return { status: "rejected", contractId: request.contractId, message: guardFailure, artifact: indexPath };
  const evidenceFailure = validateEvidence(context, request);
  if (evidenceFailure) return { status: "rejected", contractId: request.contractId, message: evidenceFailure };

  const preparedIndex = structuredClone(index);
  const preparedContract = preparedIndex.contracts.find((candidate: any) => candidate.id === request.contractId)!;
  preparedContract.status = "complete";
  const preparedContracts = preparedIndex.contracts as ContractNode[];
  const readyContractIds = computeReadyContracts(preparedContracts, preparedIndex.contractFacts ?? {});
  const allComplete = preparedContracts.every((candidate) => candidate.status === "complete");
  const initiativeState: "executing" | "finalizing" = allComplete ? "finalizing" : "executing";
  const activeContractId = request.nextActiveContract === "advance" ? readyContractIds[0] ?? null : null;
  const preparedManifest = structuredClone(manifest) as MutableJson;
  preparedManifest.initiativeState = initiativeState;
  preparedManifest.updatedAt = request.completedAt ?? new Date().toISOString();
  if (activeContractId) {
    const next = preparedIndex.contracts.find((candidate: any) => candidate.id === activeContractId)!;
    preparedManifest.activeContract = { id: next.id, path: next.path };
  } else {
    delete preparedManifest.activeContract;
  }
  const record: CanonicalCompletionRecord = {
    schemaVersion: 1,
    requestId,
    planRevision: request.expectedPlanRevision,
    contractPath: request.expectedContractPath,
    preCompletionContentHash: request.expectedPreCompletionContentHash,
    verification: { ...request.verification },
    review: { ...request.review },
    completedAt: preparedManifest.updatedAt,
    nextState: { initiativeState, activeContractId, readyContractIds },
  };
  preparedIndex.completionRecords = { ...(preparedIndex.completionRecords ?? {}), [request.contractId]: record };

  const preparedIndexBytes = serializeJson(preparedIndex);
  const preparedManifestBytes = serializeJson(preparedManifest);
  const journal = prepareTransaction(context, request, requestId, indexPath, preparedIndexBytes, preparedManifestBytes);
  fault(options, "after-prepared-files");
  createJournalExclusive(context, journal);
  fault(options, "after-stage-prepared");

  installPrepared(context, journal.roles["contract-index"]);
  fault(options, "after-contract-index-rename");
  let currentJournal: CompletionJournal = { ...journal, stage: "contract-index-installed" };
  persistJournal(context, currentJournal);
  fault(options, "after-contract-index-installed");

  installPrepared(context, journal.roles.manifest);
  fault(options, "after-manifest-rename");
  currentJournal = { ...journal, stage: "manifest-installed" as const };
  persistJournal(context, currentJournal);
  fault(options, "after-manifest-installed");

  const committedError = validateCommittedState(context, currentJournal);
  if (committedError) {
    currentJournal = { ...journal, stage: "rollback" as const };
    persistJournal(context, currentJournal);
    fault(options, "after-rollback-stage");
    const rolledBack = restorePreimages(context, currentJournal);
    if (rolledBack.status === "blocked-recovery") return { ...rolledBack, contractId: request.contractId };
    return { status: "rejected", contractId: request.contractId, message: `post-write validation failed and was rolled back: ${committedError}` };
  }

  currentJournal = { ...journal, stage: "validated" as const };
  persistJournal(context, currentJournal);
  fault(options, "after-validated");
  currentJournal = { ...journal, stage: "cleanup" as const };
  persistJournal(context, currentJournal);
  fault(options, "after-cleanup-stage");
  cleanupCommitted(context, currentJournal);

  return {
    status: "completed",
    contractId: request.contractId,
    requestId,
    readyContractIds,
    activeContractId,
    phaseProgress: formatPhaseProgress(preparedContracts, request.contractId),
  };
  } finally {
    releaseCompletionClaim(context, claim);
  }
}

export function recoverCanonicalCompletion(
  request: RecoverCanonicalCompletionRequest,
  options: CompletionOptions = {},
): RecoverCanonicalCompletionResult {
  const context = createContext(request.cwd, request.topic, options);
  if (!context) return { status: "blocked-recovery", message: "repository cwd or topic is invalid", artifact: completionJournalPath(request.topic) };
  const existingJournal = existsSync(absolute(context, context.journalPath)) ? readJournal(context) : undefined;
  const claim = acquireCompletionClaim(context, `recovery:${randomUUID()}`, existingJournal?.ownerToken);
  if (!claim) return { status: "blocked-recovery", message: "completion ownership is present; automatic stale-claim reaping is disabled, so remove the lock only after confirming its owner is gone", artifact: completionClaimPath(request.topic) };
  context.ownerToken = claim.token;
  try {
    return recoverWithContext(context);
  } finally {
    releaseCompletionClaim(context, claim);
  }
}

function recoverWithContext(context: CompletionContext): RecoverCanonicalCompletionResult {
  const journal = readJournal(context);
  if (!journal) {
    return existsSync(absolute(context, context.journalPath))
      ? blocked(context, "completion journal is malformed or outside its bounded schema")
      : { status: "no-transaction" };
  }
  if (journal.ownerToken !== requiredOwnerToken(context)) return blocked(context, "completion journal owner does not match the held claim");
  const invariantError = validateStageInvariant(context, journal);
  if (invariantError) return blocked(context, invariantError);

  if (journal.stage === "prepared" || journal.stage === "contract-index-installed") {
    const rollback = { ...journal, stage: "rollback" as const };
    persistJournal(context, rollback);
    fault(context.options, "after-rollback-stage");
    return restorePreimages(context, rollback);
  }
  if (journal.stage === "manifest-installed") {
    const committedError = validateCommittedState(context, journal);
    if (committedError) {
      const rollback = { ...journal, stage: "rollback" as const };
      persistJournal(context, rollback);
      fault(context.options, "after-rollback-stage");
      return restorePreimages(context, rollback);
    }
    const validated = { ...journal, stage: "validated" as const };
    persistJournal(context, validated);
    fault(context.options, "after-validated");
    const cleanup = { ...journal, stage: "cleanup" as const };
    persistJournal(context, cleanup);
    fault(context.options, "after-cleanup-stage");
    cleanupCommitted(context, cleanup);
    return { status: "committed-cleanup", requestId: journal.requestId };
  }
  if (journal.stage === "rollback") return restorePreimages(context, journal);

  const committedError = validateCommittedState(context, journal);
  if (committedError) return blocked(context, `committed completion state is invalid: ${committedError}`);
  const cleanup = journal.stage === "cleanup" ? journal : { ...journal, stage: "cleanup" as const };
  if (journal.stage !== "cleanup") persistJournal(context, cleanup);
  fault(context.options, "after-cleanup-stage");
  cleanupCommitted(context, cleanup);
  return { status: "committed-cleanup", requestId: journal.requestId };
}

function prepareTransaction(
  context: CompletionContext,
  request: CompleteCanonicalContractRequest,
  requestId: string,
  indexPath: string,
  indexBytes: string,
  manifestBytes: string,
): CompletionJournal {
  const suffix = requestId.slice("sha256:".length, "sha256:".length + 16);
  const roles = {} as Record<TransactionRoleName, TransactionRole>;
  try {
    roles["contract-index"] = prepareRole(context, "contract-index", indexPath, indexBytes, suffix);
    roles.manifest = prepareRole(context, "manifest", `.model-artifacts/specs/${request.topic}/manifest.json`, manifestBytes, suffix);
    return { schemaVersion: 1, topic: request.topic, ownerToken: requiredOwnerToken(context), requestId, contractId: request.contractId, stage: "prepared", roles };
  } catch (error) {
    for (const role of Object.values(roles)) {
      for (const path of [role.preparedPath, role.preimageBackupPath, role.restorePath]) removeArtifact(context, path);
    }
    throw error;
  }
}

function prepareRole(
  context: CompletionContext,
  name: TransactionRoleName,
  targetPath: string,
  preparedBytes: string,
  suffix: string,
): TransactionRole {
  assertClaimOwnership(context);
  const target = absolute(context, targetPath);
  const preimageBytes = readFileSync(target, "utf8");
  const preparedPath = `${targetPath}.completion-${suffix}.prepared`;
  const preimageBackupPath = `${targetPath}.completion-${suffix}.preimage`;
  const restorePath = `${targetPath}.completion-${suffix}.restore`;
  const preparedHash = sha256(preparedBytes);
  const preimageHash = sha256(preimageBytes);
  removeMatchingOrphan(context, preparedPath, preparedHash);
  removeMatchingOrphan(context, preimageBackupPath, preimageHash);
  removeMatchingOrphan(context, restorePath, preimageHash);
  writeDurableNew(context, preparedPath, preparedBytes);
  fault(context.options, name === "contract-index" ? "after-contract-index-prepared" : "after-manifest-prepared");
  writeDurableNew(context, preimageBackupPath, preimageBytes);
  fault(context.options, name === "contract-index" ? "after-contract-index-backup" : "after-manifest-backup");
  return { targetPath, preparedPath, preparedHash, preimageBackupPath, preimageHash, restorePath };
}

function installPrepared(context: CompletionContext, role: TransactionRole): void {
  assertClaimOwnership(context);
  renameSync(absolute(context, role.preparedPath), absolute(context, role.targetPath));
  fsyncDirectory(dirname(absolute(context, role.targetPath)));
}

function restorePreimages(context: CompletionContext, journal: CompletionJournal): RecoverCanonicalCompletionResult {
  assertJournalOwnership(context, journal);
  for (const name of ["contract-index", "manifest"] as const) {
    const role = journal.roles[name];
    if (fileHash(context, role.targetPath) !== role.preimageHash) {
      assertClaimOwnership(context);
      const restoreHash = fileHash(context, role.restorePath);
      if (restoreHash !== undefined && restoreHash !== role.preimageHash) return blocked(context, `restore temporary is corrupt: ${role.restorePath}`);
      if (restoreHash === undefined) {
        const backup = readFileSync(absolute(context, role.preimageBackupPath), "utf8");
        if (sha256(backup) !== role.preimageHash) return blocked(context, `preimage backup is corrupt: ${role.preimageBackupPath}`);
        writeDurableNew(context, role.restorePath, backup);
      }
      assertClaimOwnership(context);
      renameSync(absolute(context, role.restorePath), absolute(context, role.targetPath));
      fsyncDirectory(dirname(absolute(context, role.targetPath)));
    }
    if (fileHash(context, role.targetPath) !== role.preimageHash) return blocked(context, `could not restore preimage: ${role.targetPath}`);
    fault(context.options, name === "contract-index" ? "after-restore-contract-index" : "after-restore-manifest");
  }
  for (const role of Object.values(journal.roles)) {
    for (const path of [role.restorePath, role.preparedPath, role.preimageBackupPath]) removeArtifact(context, path);
  }
  removeJournal(context);
  return { status: "rolled-back", requestId: journal.requestId };
}

function cleanupCommitted(context: CompletionContext, journal: CompletionJournal): void {
  assertJournalOwnership(context, journal);
  for (const role of Object.values(journal.roles)) {
    for (const path of [role.preparedPath, role.restorePath, role.preimageBackupPath]) {
      assertClaimOwnership(context);
      removeArtifact(context, path);
      fault(context.options, "after-cleanup-artifact");
    }
  }
  removeJournal(context);
}

function validateStageInvariant(context: CompletionContext, journal: CompletionJournal): string | undefined {
  const index = journal.roles["contract-index"];
  const manifest = journal.roles.manifest;
  const backupError = (role: TransactionRole) => fileHash(context, role.preimageBackupPath) === role.preimageHash ? undefined : `required preimage backup is missing or corrupt: ${role.preimageBackupPath}`;
  const installState = (role: TransactionRole): "pre" | "new" | "invalid" => {
    const targetHash = fileHash(context, role.targetPath);
    const preparedHash = fileHash(context, role.preparedPath);
    if (targetHash === role.preimageHash && preparedHash === role.preparedHash) return "pre";
    if (targetHash === role.preparedHash && preparedHash === undefined) return "new";
    return "invalid";
  };
  const committedArtifactsValid = (role: TransactionRole): boolean => {
    if (fileHash(context, role.targetPath) !== role.preparedHash || fileHash(context, role.preparedPath) !== undefined) return false;
    const backup = fileHash(context, role.preimageBackupPath);
    const restore = fileHash(context, role.restorePath);
    return (backup === undefined || backup === role.preimageHash) && (restore === undefined || restore === role.preimageHash);
  };

  if (journal.stage === "prepared") {
    return backupError(index) ?? backupError(manifest)
      ?? (installState(manifest) !== "pre" ? "prepared stage requires manifest preimage and prepared source" : undefined)
      ?? (installState(index) === "invalid" ? "prepared stage has an impossible contract-index target/source combination" : undefined);
  }
  if (journal.stage === "contract-index-installed") {
    return backupError(index) ?? backupError(manifest)
      ?? (installState(index) !== "new" ? "contract-index-installed stage requires consumed contract-index source" : undefined)
      ?? (installState(manifest) === "invalid" ? "contract-index-installed stage has an impossible manifest target/source combination" : undefined);
  }
  if (journal.stage === "manifest-installed") {
    return backupError(index) ?? backupError(manifest)
      ?? (installState(index) !== "new" || installState(manifest) !== "new" ? "manifest-installed stage requires both new targets and consumed sources" : undefined);
  }
  if (journal.stage === "rollback") {
    for (const role of [index, manifest]) {
      const targetHash = fileHash(context, role.targetPath);
      const preparedHash = fileHash(context, role.preparedPath);
      const restoreHash = fileHash(context, role.restorePath);
      const error = backupError(role);
      if (error) return error;
      if (targetHash !== role.preimageHash && targetHash !== role.preparedHash) return `rollback target has an impossible hash: ${role.targetPath}`;
      if (preparedHash !== undefined && preparedHash !== role.preparedHash) return `rollback prepared source is corrupt: ${role.preparedPath}`;
      if (restoreHash !== undefined && restoreHash !== role.preimageHash) return `rollback restore temporary is corrupt: ${role.restorePath}`;
    }
    return undefined;
  }
  return committedArtifactsValid(index) && committedArtifactsValid(manifest)
    ? undefined
    : `${journal.stage} stage requires committed targets, consumed prepared sources, and valid remaining cleanup artifacts`;
}

function validateCommittedState(context: CompletionContext, journal: CompletionJournal): string | undefined {
  const inspection = inspectCanonicalInitiative({ cwd: context.root, topic: context.topic, recoveryMode: true });
  if (inspection.diagnostics.length) return firstInspectionProblem(inspection);
  const contract = inspection.contracts.find((candidate) => candidate.id === journal.contractId);
  const record = inspection.completionRecords[journal.contractId];
  if (contract?.status !== "complete" || record?.requestId !== journal.requestId) return `completion record or complete disposition is missing for ${journal.contractId}`;
  const activeContractId = inspection.manifest?.activeContract?.id ?? null;
  if (inspection.manifest?.initiativeState !== record.nextState.initiativeState
    || activeContractId !== record.nextState.activeContractId
    || !sameStrings(inspection.readyIds, record.nextState.readyContractIds)) {
    return `completion record nextState does not match the same manifest/index readiness snapshot`;
  }
  return undefined;
}

function validateMutationGuards(
  request: CompleteCanonicalContractRequest,
  manifest: InitiativeManifest,
  contracts: readonly any[],
  contract: any,
  readyIds: readonly string[],
): string | undefined {
  if (manifest.activePlan?.revision !== request.expectedPlanRevision) return `active plan revision does not match expected revision ${request.expectedPlanRevision}`;
  if (contract.planRevision !== request.expectedPlanRevision) return `contract plan revision is stale`;
  if (contract.path !== request.expectedContractPath) return `contract path does not match the expected stable path`;
  if (contract.contentHash !== request.expectedPreCompletionContentHash) return `contract content hash is stale`;
  if (manifest.activeContract?.id !== request.contractId || manifest.activeContract.path !== contract.path) return `activeContract does not name ${request.contractId}`;
  if (contract.status !== "pending" && contract.status !== "in_progress") return `contract ${request.contractId} has conflicting status ${String(contract.status)}`;
  if (!readyIds.includes(request.contractId)) return `contract ${request.contractId} is not readiness-selected`;
  const byId = new Map(contracts.map((candidate) => [candidate.id, candidate]));
  if (contract.dependsOn.some((id: string) => byId.get(id)?.status !== "complete")) return `contract dependencies are incomplete`;
  return undefined;
}

function validateEvidence(context: CompletionContext, request: CompleteCanonicalContractRequest): string | undefined {
  const verificationContent = readEvidence(context, request.verification.path, request.verification.contentHash);
  const verification = verificationContent ? readEvidenceEnvelope(verificationContent, "verification") : undefined;
  if (!verification
    || verification.topic !== request.topic
    || verification.contractId !== request.contractId
    || verification.contractPath !== request.expectedContractPath
    || verification.planRevision !== request.expectedPlanRevision
    || verification.contractContentHash !== request.expectedPreCompletionContentHash
    || verification.outcome !== "pass"
    || verification.gaps !== "none") {
    return `verification evidence is missing, stale, partial, or not bound to the exact contract`;
  }
  const reviewContent = readEvidence(context, request.review.path, request.review.contentHash);
  const review = reviewContent ? readEvidenceEnvelope(reviewContent, "implementation-review") : undefined;
  if (!review
    || request.review.decision !== "approve"
    || review.topic !== request.topic
    || review.contractId !== request.contractId
    || review.contractPath !== request.expectedContractPath
    || review.planRevision !== request.expectedPlanRevision
    || review.contractContentHash !== request.expectedPreCompletionContentHash
    || review.decision !== "approve"
    || review.blockingFindings !== 0
    || review.verification.path !== request.verification.path
    || review.verification.contentHash !== request.verification.contentHash) {
    return `implementation review evidence is missing, stale, blocked, or not bound to the exact contract and verification identity`;
  }
  return undefined;
}

function readEvidenceEnvelope(content: string, mode: "verification"): VerificationEnvelope | undefined;
function readEvidenceEnvelope(content: string, mode: "implementation-review"): ReviewEnvelope | undefined;
function readEvidenceEnvelope(content: string, mode: "verification" | "implementation-review"): VerificationEnvelope | ReviewEnvelope | undefined {
  const matches = [...content.matchAll(/^Pi-SWE-Evidence:\s*(\{[^\n]+\})\s*$/gm)];
  if (matches.length !== 1) return undefined;
  let value: unknown;
  try { value = JSON.parse(matches[0]![1]!); } catch { return undefined; }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== mode) return undefined;
  const commonValid = typeof value.topic === "string"
    && typeof value.contractId === "string"
    && typeof value.contractPath === "string"
    && Number.isSafeInteger(value.planRevision)
    && isSha256(value.contractContentHash);
  if (!commonValid) return undefined;
  if (mode === "verification") {
    const keys = new Set(["schemaVersion", "mode", "topic", "contractId", "contractPath", "planRevision", "contractContentHash", "outcome", "gaps"]);
    return hasExactKeys(value, keys) && value.outcome === "pass" && value.gaps === "none" ? value as VerificationEnvelope : undefined;
  }
  const keys = new Set(["schemaVersion", "mode", "topic", "contractId", "contractPath", "planRevision", "contractContentHash", "decision", "blockingFindings", "verification"]);
  if (!hasExactKeys(value, keys) || value.decision !== "approve" || value.blockingFindings !== 0 || !isRecord(value.verification)
    || !hasExactKeys(value.verification, new Set(["path", "contentHash"]))
    || typeof value.verification.path !== "string" || !isSha256(value.verification.contentHash)) return undefined;
  return value as ReviewEnvelope;
}

function evidenceRemainsValid(context: CompletionContext, request: CompleteCanonicalContractRequest): boolean {
  return validateEvidence(context, request) === undefined;
}

function readEvidence(context: CompletionContext, path: string, expectedHash: string): string | undefined {
  if (!isTopicReportPath(path, context.topic)) return undefined;
  try {
    const absolutePath = safeAbsolute(context.root, path, false);
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) return undefined;
    const content = readFileSync(absolutePath, "utf8");
    return sha256(content) === expectedHash ? content : undefined;
  } catch {
    return undefined;
  }
}

function completionIdentityMatches(record: CanonicalCompletionRecord, request: CompleteCanonicalContractRequest, requestId: string): boolean {
  return record.requestId === requestId
    && record.planRevision === request.expectedPlanRevision
    && record.contractPath === request.expectedContractPath
    && record.preCompletionContentHash === request.expectedPreCompletionContentHash
    && record.verification.path === request.verification.path
    && record.verification.contentHash === request.verification.contentHash
    && record.review.path === request.review.path
    && record.review.contentHash === request.review.contentHash
    && record.review.decision === request.review.decision
    && (request.nextActiveContract === "clear"
      ? record.nextState.activeContractId === null
      : record.nextState.activeContractId === (record.nextState.readyContractIds[0] ?? null));
}

function computeReadyContracts(contracts: readonly ContractNode[], facts: Readonly<Record<string, any>>): string[] {
  const graph = analyzeContractGraph(contracts, (contract) => {
    const item = facts[contract.id];
    return Boolean(item?.entryInputsAvailable
      && item?.capabilitiesAvailable
      && item?.applicability === "applicable"
      && item?.acceptanceDefined
      && item?.verificationDefined);
  });
  return graph.ok ? [...graph.ready] : [];
}

function formatPhaseProgress(contracts: readonly ContractNode[], contractId: string): string {
  const phase = contractId.split(".")[0]!;
  const phaseContracts = contracts.filter((contract) => contract.id === phase || contract.id.startsWith(`${phase}.`));
  const completed = phaseContracts.filter((contract) => contract.status === "complete").length;
  return `${phase}:${completed}/${phaseContracts.length}`;
}

function validateCompletionRequest(request: CompleteCanonicalContractRequest): string | undefined {
  if (!isValidTopic(request.topic)) return "topic is invalid";
  if (!request.contractId || request.contractId.length > 32) return "contractId is invalid";
  if (!Number.isSafeInteger(request.expectedPlanRevision) || request.expectedPlanRevision < 1) return "expectedPlanRevision must be positive";
  if (!isSafeRelativePath(request.expectedContractPath) || !request.expectedContractPath.startsWith(`.model-artifacts/plans/${request.topic}/`)) return "expectedContractPath is outside the active topic";
  if (!SHA256_PATTERN.test(request.expectedPreCompletionContentHash)
    || !SHA256_PATTERN.test(request.verification.contentHash)
    || !SHA256_PATTERN.test(request.review.contentHash)) return "completion hashes must use sha256:<hex>";
  if (!isTopicReportPath(request.verification.path, request.topic) || !isTopicReportPath(request.review.path, request.topic)) return "evidence paths must stay under reports for the topic";
  if (request.review.decision !== "approve") return "review decision must be approve";
  if (request.completedAt !== undefined && Number.isNaN(Date.parse(request.completedAt))) return "completedAt must be a timestamp";
  return undefined;
}

function createContext(cwd: string, topic: string, options: CompletionOptions): CompletionContext | undefined {
  if (!isValidTopic(topic)) return undefined;
  try {
    const root = realpathSync(resolve(cwd));
    if (!statSync(root).isDirectory()) return undefined;
    return { root, topic, journalPath: completionJournalPath(topic), options };
  } catch {
    return undefined;
  }
}

function readBoundedJson(context: CompletionContext, path: string): MutableJson | undefined {
  try {
    const absolutePath = safeAbsolute(context.root, path, false);
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
    const value: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readJournal(context: CompletionContext): CompletionJournal | undefined {
  const value = readBoundedJsonAtLimit(context, context.journalPath, MAX_JOURNAL_BYTES);
  if (!isRecord(value) || !hasExactKeys(value, new Set(["schemaVersion", "topic", "ownerToken", "requestId", "contractId", "stage", "roles"]))) return undefined;
  if (value.schemaVersion !== 1 || value.topic !== context.topic || typeof value.ownerToken !== "string" || !value.ownerToken
    || !isSha256(value.requestId) || typeof value.contractId !== "string" || !isStage(value.stage) || !isRecord(value.roles)) return undefined;
  if (!hasExactKeys(value.roles, new Set(["contract-index", "manifest"]))) return undefined;
  const index = parseJournalRole(context, value.roles["contract-index"]);
  const manifest = parseJournalRole(context, value.roles.manifest);
  if (!index || !manifest) return undefined;
  if (manifest.targetPath !== `.model-artifacts/specs/${context.topic}/manifest.json`
    || !index.targetPath.startsWith(`.model-artifacts/plans/${context.topic}/`)
    || !index.targetPath.endsWith("/contracts.json")) return undefined;
  return {
    schemaVersion: 1,
    topic: context.topic,
    ownerToken: value.ownerToken,
    requestId: value.requestId,
    contractId: value.contractId,
    stage: value.stage,
    roles: { "contract-index": index, manifest },
  };
}

function parseJournalRole(context: CompletionContext, value: unknown): TransactionRole | undefined {
  const keys = new Set(["targetPath", "preparedPath", "preparedHash", "preimageBackupPath", "preimageHash", "restorePath"]);
  if (!isRecord(value) || !hasExactKeys(value, keys)) return undefined;
  for (const key of ["targetPath", "preparedPath", "preimageBackupPath", "restorePath"] as const) {
    if (typeof value[key] !== "string" || !isSafeRelativePath(value[key])) return undefined;
    try { safeAbsolute(context.root, value[key], true); } catch { return undefined; }
  }
  if (!isSha256(value.preparedHash) || !isSha256(value.preimageHash)) return undefined;
  if (!value.preparedPath.startsWith(`${value.targetPath}.completion-`)
    || !value.preimageBackupPath.startsWith(`${value.targetPath}.completion-`)
    || !value.restorePath.startsWith(`${value.targetPath}.completion-`)) return undefined;
  return value as TransactionRole;
}

function acquireCompletionClaim(context: CompletionContext, requestId: string, ownerToken: string = randomUUID()): CompletionClaim | undefined {
  const path = absolute(context, completionClaimPath(context.topic));
  mkdirSync(dirname(path), { recursive: true });
  const claim: CompletionClaim = { schemaVersion: 1, token: ownerToken, pid: process.pid, requestId, createdAt: new Date().toISOString() };
  try {
    writeDurableAbsolute(path, serializeJson(claim), "wx");
    fsyncDirectory(dirname(path));
    return claim;
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) return undefined;
    throw error;
  }
}

function requiredOwnerToken(context: CompletionContext): string {
  if (!context.ownerToken) throw new Error("completion claim token is unavailable");
  return context.ownerToken;
}

function assertClaimOwnership(context: CompletionContext): void {
  const claim = readClaim(absolute(context, completionClaimPath(context.topic)));
  if (!claim || claim.token !== requiredOwnerToken(context)) throw new Error("completion claim ownership changed");
}

function assertJournalOwnership(context: CompletionContext, journal: CompletionJournal): void {
  assertClaimOwnership(context);
  if (journal.ownerToken !== requiredOwnerToken(context)) throw new Error("completion journal ownership changed");
}

function releaseCompletionClaim(context: CompletionContext, claim: CompletionClaim): void {
  const path = absolute(context, completionClaimPath(context.topic));
  const current = readClaim(path);
  if (!current || current.token !== claim.token) return;
  rmSync(path, { force: true });
  fsyncDirectory(dirname(path));
}

function readClaim(path: string): CompletionClaim | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const keys = new Set(["schemaVersion", "token", "pid", "requestId", "createdAt"]);
    if (!isRecord(value) || !hasExactKeys(value, keys) || value.schemaVersion !== 1
      || typeof value.token !== "string" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.requestId !== "string" || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
    return value as CompletionClaim;
  } catch {
    return undefined;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function createJournalExclusive(context: CompletionContext, journal: CompletionJournal): void {
  assertClaimOwnership(context);
  if (journal.ownerToken !== requiredOwnerToken(context)) throw new Error("completion journal owner does not match held claim");
  const path = absolute(context, context.journalPath);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = serializeJson(journal);
  if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) throw new Error("completion journal exceeds bound");
  writeDurableAbsolute(path, bytes, "wx");
  fsyncDirectory(dirname(path));
}

function persistJournal(context: CompletionContext, journal: CompletionJournal): void {
  assertClaimOwnership(context);
  const ownerToken = requiredOwnerToken(context);
  const current = readJournal(context);
  if (!current || current.ownerToken !== ownerToken || journal.ownerToken !== ownerToken
    || current.requestId !== journal.requestId || current.contractId !== journal.contractId || current.topic !== journal.topic) {
    throw new Error("completion journal ownership changed before stage update");
  }
  const path = absolute(context, context.journalPath);
  const temporary = `${path}.next`;
  mkdirSync(dirname(path), { recursive: true });
  rmSync(temporary, { force: true });
  const bytes = serializeJson(journal);
  if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) throw new Error("completion journal exceeds bound");
  writeDurableAbsolute(temporary, bytes, "wx");
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function removeJournal(context: CompletionContext): void {
  assertClaimOwnership(context);
  const path = absolute(context, context.journalPath);
  rmSync(path, { force: true });
  rmSync(`${path}.next`, { force: true });
  fsyncDirectory(dirname(path));
}

function writeDurableNew(context: CompletionContext, path: string, content: string): void {
  assertClaimOwnership(context);
  const absolutePath = safeAbsolute(context.root, path, true);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeDurableAbsolute(absolutePath, content, "wx");
  fsyncDirectory(dirname(absolutePath));
}

function writeDurableAbsolute(path: string, content: string, flag: "wx"): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, flag, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function removeArtifact(context: CompletionContext, path: string): void {
  assertClaimOwnership(context);
  rmSync(absolute(context, path), { force: true });
  fsyncDirectory(dirname(absolute(context, path)));
}

function removeMatchingOrphan(context: CompletionContext, path: string, expectedHash: string): void {
  const actualHash = fileHash(context, path);
  if (actualHash === undefined) return;
  if (actualHash !== expectedHash) throw new Error(`completion artifact already exists with conflicting content: ${path}`);
  removeArtifact(context, path);
}

function fileHash(context: CompletionContext, path: string): string | undefined {
  try {
    const absolutePath = safeAbsolute(context.root, path, true);
    if (!existsSync(absolutePath)) return undefined;
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return "invalid";
    return sha256(readFileSync(absolutePath));
  } catch {
    return "invalid";
  }
}

function safeAbsolute(root: string, path: string, allowMissing: boolean): string {
  if (!isSafeRelativePath(path)) throw new Error(`unsafe repository-relative path: ${path}`);
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`path escapes repository: ${path}`);
  let current = root;
  const segments = fromRoot.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) {
      if (allowMissing || index < segments.length - 1) continue;
      throw new Error(`required path is missing: ${path}`);
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error(`path traverses symlink: ${path}`);
  }
  return candidate;
}

function absolute(context: CompletionContext, path: string): string {
  return safeAbsolute(context.root, path, true);
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && path.length <= 2048 && !isAbsolute(path) && !path.includes("\\")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isTopicReportPath(path: string, topic: string): boolean {
  return isSafeRelativePath(path) && path.startsWith(`.model-artifacts/reports/${topic}/`);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isStage(value: unknown): value is TransactionStage {
  return value === "prepared" || value === "contract-index-installed" || value === "manifest-installed"
    || value === "rollback" || value === "validated" || value === "cleanup";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, any>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function readBoundedJsonAtLimit(context: CompletionContext, path: string, maxBytes: number): unknown {
  try {
    const absolutePath = safeAbsolute(context.root, path, false);
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    return undefined;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function firstInspectionProblem(inspection: ReturnType<typeof inspectCanonicalInitiative>): string {
  return inspection.diagnostics[0]?.message ?? inspection.blockers[0]?.message ?? "canonical initiative is not approved and ready";
}

function fault(options: CompletionOptions, point: CompletionFaultPoint): void {
  options.faultInjector?.(point);
}

function blocked(context: CompletionContext, message: string): RecoverCanonicalCompletionResult {
  return { status: "blocked-recovery", message, artifact: context.journalPath };
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
