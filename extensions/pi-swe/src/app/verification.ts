import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, openSync, closeSync, readSync, realpathSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

import {
  contractFingerprint,
  type Initiative,
  type ModelReviewEvidence,
  type RelevantSourceSnapshot,
  type VerificationEvidence,
} from "../domain/initiative.ts";

export type VerificationRequest = { workId: string; obligationIds: string[]; command: string; relevantPaths: string[] };
export type ReviewRequest = {
  workId: string;
  obligationIds: string[];
  outcome: "passed" | "failed";
  relevantPaths: string[];
  dimensions: string[];
  summary: string;
  sessionId: string;
};
export type PreparedVerification = { token: string; command: string; workId: string; relevantPaths: string[] };
type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type ToolResult = { toolCallId: string; toolName: string; isError: boolean; content: Array<{ type: string; text?: string }> };
type Pending = PreparedVerification & { obligationIds: string[]; contractFingerprint: string; before: RelevantSourceSnapshot; preparedAt: string; toolCallId?: string; startedAt?: string };

export class VerificationCollector {
  readonly #root: string;
  readonly #now: () => string;
  #pending?: Pending;
  #completed: VerificationEvidence[] = [];

  constructor(cwd: string, options: { now?: () => string } = {}) {
    this.#root = realpathSync(resolve(cwd));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  prepare(initiative: Initiative, request: VerificationRequest): PreparedVerification {
    const work = initiative.work.find((item) => item.id === request.workId && item.kind !== "phase");
    if (!work) throw new Error(`unknown executable work ${request.workId}`);
    if (!request.obligationIds.length || request.obligationIds.some((id) => !work.obligationIds?.includes(id))) throw new Error("verification obligationIds must belong to work");
    for (const obligationId of request.obligationIds) {
      const obligation = initiative.obligations.find((item) => item.id === obligationId)!;
      if (!(obligation.verification.requiredEvidence ?? ["machine-command"]).includes("machine-command")) throw new Error(`obligation ${obligationId} does not accept machine-command evidence`);
    }
    if (typeof request.command !== "string" || !request.command.trim() || request.command.length > 8_192 || request.command.includes("\u0000")) throw new Error("verification command must be bounded non-empty text");
    const paths = normalizeRelevantPaths(request.relevantPaths);
    const prepared: Pending = {
      token: randomUUID(), command: request.command, workId: request.workId,
      obligationIds: [...new Set(request.obligationIds)], relevantPaths: paths,
      contractFingerprint: contractFingerprint(initiative), before: snapshotRelevantPaths(this.#root, paths),
      preparedAt: this.#now(),
    };
    this.#pending = prepared;
    return { token: prepared.token, command: prepared.command, workId: prepared.workId, relevantPaths: [...paths] };
  }

  observeToolCall(event: ToolCall, cwd: string): boolean {
    const pending = this.#pending;
    if (!pending || pending.toolCallId || event.toolName !== "bash" || event.input.command !== pending.command || resolve(cwd) !== this.#root) return false;
    pending.toolCallId = event.toolCallId;
    pending.startedAt = this.#now();
    return true;
  }

  observeToolResult(event: ToolResult): VerificationEvidence | undefined {
    const pending = this.#pending;
    if (!pending?.toolCallId || !pending.startedAt || event.toolName !== "bash" || event.toolCallId !== pending.toolCallId) return undefined;
    const completedAt = this.#now();
    const output = event.content.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
    const evidence: VerificationEvidence = {
      id: `E-${randomUUID()}`,
      kind: "machine-command",
      workId: pending.workId,
      obligationIds: pending.obligationIds,
      outcome: event.isError ? "failed" : "passed",
      execution: { executable: "bash", args: ["-lc", pending.command], cwd: "." },
      startedAt: pending.startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(pending.startedAt)),
      contractFingerprint: pending.contractFingerprint,
      source: { before: pending.before, after: snapshotRelevantPaths(this.#root, pending.relevantPaths) },
      provenance: { kind: "pi-tool-observation", toolCallId: pending.toolCallId, permissionBoundary: "ordinary-bash-tool-call" },
      outputHash: digest(Buffer.from(output)),
    };
    this.#completed.push(evidence);
    this.#pending = undefined;
    return evidence;
  }

  abort(_reason: string): boolean {
    if (!this.#pending) return false;
    this.#pending = undefined;
    return true;
  }

  drainEvidence(): VerificationEvidence[] {
    const evidence = this.#completed;
    this.#completed = [];
    return evidence;
  }
}

export function createModelReviewEvidence(cwd: string, initiative: Initiative, request: ReviewRequest, now = new Date().toISOString()): ModelReviewEvidence {
  const work = initiative.work.find((item) => item.id === request.workId && item.kind !== "phase");
  if (!work) throw new Error(`unknown executable work ${request.workId}`);
  if (work.status !== "implemented") throw new Error("model review can only be recorded for implemented work");
  if (!request.obligationIds.length || request.obligationIds.some((id) => !work.obligationIds?.includes(id))) throw new Error("review obligationIds must belong to work");
  for (const obligationId of request.obligationIds) {
    const obligation = initiative.obligations.find((item) => item.id === obligationId)!;
    if (!(obligation.verification.requiredEvidence ?? ["machine-command"]).includes("model-review")) throw new Error(`obligation ${obligationId} does not accept model-review evidence`);
  }
  if (!Array.isArray(request.dimensions) || !request.dimensions.length || request.dimensions.length > 32) throw new Error("review dimensions must contain 1 to 32 entries");
  for (const dimension of request.dimensions) if (typeof dimension !== "string" || !dimension.trim() || dimension.length > 128) throw new Error("review dimensions must be bounded non-empty text");
  if (typeof request.summary !== "string" || !request.summary.trim() || request.summary.length > 8_192) throw new Error("review summary must be bounded non-empty text");
  if (typeof request.sessionId !== "string" || !request.sessionId.trim() || request.sessionId.length > 256) throw new Error("review sessionId is required");
  return {
    id: `E-${randomUUID()}`, kind: "model-review", workId: request.workId,
    obligationIds: [...new Set(request.obligationIds)], outcome: request.outcome, reviewedAt: now,
    contractFingerprint: contractFingerprint(initiative), source: snapshotRelevantPaths(cwd, request.relevantPaths),
    dimensions: [...new Set(request.dimensions.map((item) => item.trim()))], summary: request.summary.trim(),
    provenance: { kind: "pi-model-self-review", sessionId: request.sessionId.trim() },
  };
}

export function snapshotRelevantPaths(cwd: string, relevantPaths: string[]): RelevantSourceSnapshot {
  const root = realpathSync(resolve(cwd));
  const paths = normalizeRelevantPaths(relevantPaths);
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error("relevant path must be safe project-relative");
    hash.update(`${path}\0`);
    if (!existsSync(absolute)) { hash.update("missing\0"); continue; }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`relevant path must be a regular non-symlink file: ${path}`);
    if (realpathSync(absolute) !== absolute) throw new Error(`relevant path traverses a symlink: ${path}`);
    hash.update(`${stat.size}\0`);
    const handle = openSync(absolute, "r");
    try { const buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0; while ((bytes = readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
    finally { closeSync(handle); }
    if (statSync(absolute).size !== stat.size) throw new Error(`relevant path changed while snapshotting: ${path}`);
    hash.update("\0");
  }
  return { kind: "bounded-paths", paths, hash: `sha256:${hash.digest("hex")}` };
}

function normalizeRelevantPaths(values: string[]): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 256) throw new Error("relevantPaths must contain at most 256 safe project-relative paths");
  const paths = [...new Set(values)].sort();
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.length > 1_024 || path.startsWith("/") || path.includes("\\") || path !== posix.normalize(path) || path === ".." || path.startsWith("../")) throw new Error("relevantPaths must contain safe project-relative paths");
  }
  return paths;
}
function digest(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
