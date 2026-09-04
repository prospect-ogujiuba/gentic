import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseCompletionEvidenceEnvelope,
  type CompleteCanonicalContractRequest,
  type CompletionReviewEnvelope,
} from "./completion.ts";
import { resolveInitiative, type CanonicalInspectorResult } from "./planning.ts";

const MAX_REPORT_ENTRIES = 200;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_AGGREGATE_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 512;

export type ResolveCanonicalCompletionRequest = {
  readonly cwd: string;
  readonly topic?: string;
  readonly contractId?: string;
  readonly nextActiveContract: "clear" | "advance";
};

export type ResolveCanonicalCompletionResult =
  | { readonly status: "resolved"; readonly request: CompleteCanonicalContractRequest }
  | { readonly status: "rejected"; readonly contractId?: string; readonly message: string; readonly artifact: string };

export type CompletionResolutionOptions = { readonly onReportRead?: (path: string) => void };
type ReportFile = { readonly path: string; readonly bytes: Buffer; readonly content: string };
type ReportScan = { readonly files: ReadonlyMap<string, ReportFile> };
type PreflightReport = { readonly path: string; readonly absolutePath: string; readonly size: number; readonly dev: number; readonly ino: number };

export function resolveCanonicalCompletionRequest(
  input: ResolveCanonicalCompletionRequest,
  options: CompletionResolutionOptions = {},
): ResolveCanonicalCompletionResult {
  if (input.nextActiveContract !== "clear" && input.nextActiveContract !== "advance") {
    return rejected("nextActiveContract must be clear or advance", input.cwd);
  }

  const resolution = resolveInitiative({ cwd: input.cwd, explicitTopic: input.topic });
  if (resolution.sourceMode !== "canonical") {
    const message = resolution.sourceMode === "resolution"
      ? `canonical initiative selection is ${resolution.status}: ${resolution.remediation}`
      : `initiative ${resolution.topic} requires canonical layout-v2 migration before completion`;
    return rejected(message, ".model-artifacts/initiatives");
  }

  const { inspection, topic } = resolution;
  const stateFailure = validateCanonicalState(inspection);
  if (stateFailure) return stateFailure;
  const manifest = inspection.manifest!;
  const contractId = input.contractId ?? manifest.activeContract?.id;
  if (!contractId) {
    return rejected("contract selection is missing: set manifest.activeContract or provide contractId", inspection.manifestPath);
  }
  if (!manifest.activeContract
    || manifest.activeContract.id !== contractId) {
    return rejected(`contract ${contractId} is not the manifest activeContract`, inspection.manifestPath, contractId);
  }

  const indexed = inspection.contractIndex!.contracts.find((candidate) => candidate.id === contractId);
  if (!indexed || indexed.path !== manifest.activeContract.path) {
    return rejected(`active contract ${contractId} is not bound to the active contract index`, inspection.contractIndexPath!, contractId);
  }
  if (indexed.kind !== "subphase") {
    return rejected(`contract ${contractId} is not an executable subphase`, inspection.contractIndexPath!, contractId);
  }
  if ((indexed.status !== "pending" && indexed.status !== "in_progress") || !inspection.readyIds.includes(contractId)) {
    return rejected(`contract ${contractId} is not an active readiness-selected executable contract`, inspection.contractIndexPath!, contractId);
  }
  if (indexed.planRevision !== manifest.activePlan!.revision || !indexed.contentHash) {
    return rejected(`contract ${contractId} has a stale plan revision or missing content hash`, inspection.contractIndexPath!, contractId);
  }

  const rootResult = repositoryRoot(input.cwd);
  if (typeof rootResult !== "string") return rootResult;
  const contractBytes = readRegularFile(rootResult, indexed.path);
  if (!Buffer.isBuffer(contractBytes)) return rejected(contractBytes.message, indexed.path, contractId);
  const contractHash = sha256(contractBytes);
  if (contractHash !== indexed.contentHash) {
    return rejected(`contract ${contractId} content hash does not match the active index`, indexed.path, contractId);
  }

  const reportsScope = `.model-artifacts/initiatives/${topic}/reports`;
  const scan = scanReports(rootResult, reportsScope, options);
  if (!("files" in scan)) return rejected(scan.message, reportsScope, contractId);
  const matchingReviews = [...scan.files.values()].filter((file) => {
    const envelope = parseCompletionEvidenceEnvelope(file.content, "implementation-review");
    return envelope !== undefined && reviewMatches(envelope, topic, contractId, indexed.path, indexed.planRevision, contractHash);
  });
  if (matchingReviews.length !== 1) {
    return rejected(
      matchingReviews.length === 0
        ? `no current approving implementation review matches contract ${contractId}`
        : `multiple current approving implementation reviews match contract ${contractId}`,
      reportsScope,
      contractId,
    );
  }

  const reviewFile = matchingReviews[0]!;
  const review = parseCompletionEvidenceEnvelope(reviewFile.content, "implementation-review")!;
  if (!isDirectTopicReportPath(review.verification.path, reportsScope)) {
    return rejected("implementation review references an unsafe or non-direct verification report path", reviewFile.path, contractId);
  }
  const verificationFile = scan.files.get(review.verification.path);
  if (!verificationFile) {
    return rejected("implementation review references a missing or unreadable verification report", review.verification.path, contractId);
  }
  const verificationHash = sha256(verificationFile.bytes);
  if (verificationHash !== review.verification.contentHash) {
    return rejected("verification report content hash does not match the implementation review", review.verification.path, contractId);
  }
  const verification = parseCompletionEvidenceEnvelope(verificationFile.content, "verification");
  if (!verification
    || verification.topic !== topic
    || verification.contractId !== contractId
    || verification.contractPath !== indexed.path
    || verification.planRevision !== indexed.planRevision
    || verification.contractContentHash !== contractHash) {
    return rejected("verification evidence is malformed, stale, partial, or bound to another contract", review.verification.path, contractId);
  }

  return {
    status: "resolved",
    request: {
      cwd: rootResult,
      topic,
      contractId,
      expectedPlanRevision: indexed.planRevision,
      expectedContractPath: indexed.path,
      expectedPreCompletionContentHash: contractHash,
      verification: { path: review.verification.path, contentHash: verificationHash },
      review: { path: reviewFile.path, contentHash: sha256(reviewFile.bytes), decision: "approve" },
      nextActiveContract: input.nextActiveContract,
    },
  };
}

function validateCanonicalState(inspection: CanonicalInspectorResult): ResolveCanonicalCompletionResult | undefined {
  if (inspection.diagnostics.length) {
    const diagnostic = inspection.diagnostics[0]!;
    return rejected(`canonical inspection failed: ${diagnostic.message}`, diagnostic.path);
  }
  if (!inspection.manifest?.activePlan || !inspection.contractIndex || !inspection.contractIndexPath) {
    return rejected("canonical active plan or contract index is unavailable", inspection.manifestPath);
  }
  if (!inspection.gateEvaluation?.approvalValid) {
    return rejected("active plan approval is missing or stale", inspection.manifestPath);
  }
  return undefined;
}

function repositoryRoot(cwd: string): string | ResolveCanonicalCompletionResult {
  try {
    const root = realpathSync(resolve(cwd));
    if (!statSync(root).isDirectory()) return rejected("repository cwd is not a directory", cwd);
    return root;
  } catch {
    return rejected("repository cwd cannot be resolved", cwd);
  }
}

function scanReports(root: string, scope: string, options: CompletionResolutionOptions): ReportScan | { readonly message: string } {
  let directory: string;
  try {
    directory = safeAbsolute(root, scope);
    if (!lstatSync(directory).isDirectory()) return { message: "canonical reports scope is not a directory" };
  } catch {
    return { message: "canonical reports scope is missing, unsafe, or unreadable" };
  }

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } catch {
    return { message: "canonical reports scope cannot be enumerated completely" };
  }
  if (entries.length > MAX_REPORT_ENTRIES) return { message: `canonical reports scope exceeds ${MAX_REPORT_ENTRIES} entries` };

  const preflight: PreflightReport[] = [];
  let preflightBytes = 0;
  for (const entry of entries) {
    const path = `${scope}/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink()) return { message: `canonical reports scope contains a non-regular or symlink entry: ${path}` };
    try {
      const absolutePath = safeAbsolute(root, path);
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return { message: `report is not a direct regular file: ${path}` };
      if (stat.size > MAX_REPORT_BYTES) return { message: `report exceeds ${MAX_REPORT_BYTES} bytes: ${path}` };
      preflightBytes += stat.size;
      if (preflightBytes > MAX_AGGREGATE_REPORT_BYTES) return { message: `canonical reports exceed ${MAX_AGGREGATE_REPORT_BYTES} aggregate bytes` };
      preflight.push({ path, absolutePath, size: stat.size, dev: stat.dev, ino: stat.ino });
    } catch {
      return { message: `report cannot be inspected safely: ${path}` };
    }
  }

  const files = new Map<string, ReportFile>();
  let actualBytes = 0;
  let remainingPreflightBytes = preflightBytes;
  for (const report of preflight) {
    remainingPreflightBytes -= report.size;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(report.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== report.dev || opened.ino !== report.ino) {
        return { message: `report changed after preflight inspection: ${report.path}` };
      }
      if (opened.size > MAX_REPORT_BYTES) return { message: `report exceeds ${MAX_REPORT_BYTES} bytes: ${report.path}` };
      if (actualBytes + opened.size + remainingPreflightBytes > MAX_AGGREGATE_REPORT_BYTES) {
        return { message: `canonical reports exceed ${MAX_AGGREGATE_REPORT_BYTES} aggregate bytes` };
      }
      options.onReportRead?.(report.path);
      const bytes = readBoundedDescriptor(descriptor, opened.size);
      const afterRead = fstatSync(descriptor);
      if (!bytes || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.size !== bytes.length) {
        return { message: `report changed while being read: ${report.path}` };
      }
      actualBytes += bytes.length;
      files.set(report.path, { path: report.path, bytes, content: bytes.toString("utf8") });
    } catch {
      return { message: `report cannot be read safely: ${report.path}` };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return { files };
}

function readBoundedDescriptor(descriptor: number, expectedBytes: number): Buffer | undefined {
  const buffer = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === expectedBytes ? buffer : undefined;
}

function readRegularFile(root: string, path: string): Buffer | { readonly message: string } {
  try {
    const absolutePath = safeAbsolute(root, path);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { message: "artifact is not a regular non-symlink file" };
    return readFileSync(absolutePath);
  } catch {
    return { message: "artifact is missing, unsafe, or unreadable" };
  }
}

function safeAbsolute(root: string, path: string): string {
  if (!isSafeRelativePath(path)) throw new Error("unsafe path");
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("path escapes repository");
  let current = root;
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("path traverses symlink");
  }
  return candidate;
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && path.length <= 2048 && !isAbsolute(path) && !path.includes("\\")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isDirectTopicReportPath(path: string, scope: string): boolean {
  return isSafeRelativePath(path) && dirname(path) === scope;
}

function reviewMatches(
  review: CompletionReviewEnvelope,
  topic: string,
  contractId: string,
  contractPath: string,
  planRevision: number,
  contractHash: string,
): boolean {
  return review.topic === topic
    && review.contractId === contractId
    && review.contractPath === contractPath
    && review.planRevision === planRevision
    && review.contractContentHash === contractHash;
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function rejected(message: string, artifact: string, contractId?: string): ResolveCanonicalCompletionResult {
  return {
    status: "rejected",
    ...(contractId ? { contractId } : {}),
    message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : message,
    artifact,
  };
}
