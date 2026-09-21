import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import type { OrchestrationEngine } from "./orchestration.ts";
import { BOOTSTRAP_PLAN_ANCHOR, POST_CUTOVER_ADOPTION_TASK_IDS, hashContract, postCutoverEvidenceHash, type ParentAuthority, type PostCutoverAdoption, type PostCutoverCheckReceipt, type VerificationCommand, type Workflow, type WorkflowTask } from "./workflow.ts";
import type { PostCutoverInspection, WorkflowMutationService } from "./service.ts";

const REPORT_PATH = ".model-artifacts/initiatives/swe-production-rollout/reports/2026-09-20_2313-post-cutover-approval.md";
export const MAX_POST_CUTOVER_DELTA_BYTES = 2 * 1024 * 1024;
export const MAX_POST_CUTOVER_CHANGED_PATHS = 128;
const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;
const CHECK_TIMEOUT_MS = 30 * 60_000;

export type PostCutoverPreparedEvidence = Omit<PostCutoverAdoption, "authorization" | "adoptedAt">;

export class PostCutoverAdoptionCoordinator {
  readonly cwd: string;
  readonly service: WorkflowMutationService;
  readonly engine: OrchestrationEngine;
  readonly now: () => string;

  constructor(cwd: string, service: WorkflowMutationService, engine: OrchestrationEngine, now = () => new Date().toISOString()) {
    this.cwd = resolve(cwd); this.service = service; this.engine = engine; this.now = now;
  }

  async prepare(workflow: Workflow): Promise<PostCutoverPreparedEvidence> {
    this.engine.assertPostCutoverPreparationEligibility(workflow);
    const inspection = this.service.inspectPostCutoverCandidate();
    const root = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-"));
    const checkout = join(root, "candidate");
    try {
      this.git(["worktree", "add", "--detach", checkout, inspection.descendantHead], this.cwd, 256 * 1024);
      this.assertCandidate(checkout, inspection);
      this.installCandidateDependencies(checkout);
      this.assertCandidate(checkout, inspection);
      const delta = this.gitRaw(["diff", "--binary", "--full-index", BOOTSTRAP_PLAN_ANCHOR, inspection.descendantHead, "--"], checkout, MAX_POST_CUTOVER_DELTA_BYTES + 1);
      assertPostCutoverReviewBounds(Buffer.byteLength(delta), inspection.snapshot.changedPaths);
      const retainedEvidence = [this.retainedEvidence()];
      const deltaRelativePath = "node_modules/.pi-swe-post-cutover-review.patch";
      writeFileSync(join(checkout, deltaRelativePath), delta);
      const deltaHash = `sha256:${createHash("sha256").update(delta).digest("hex")}`;
      const dependencyHash = postCutoverDependencyFingerprint(checkout);
      const reviews = await this.engine.preparePostCutoverReviews(workflow, checkout, { hash: inspection.snapshot.hash, changedPaths: inspection.snapshot.changedPaths, payload: { cumulativeDelta: "", cumulativeDeltaFile: { path: deltaRelativePath, hash: deltaHash, bytes: Buffer.byteLength(delta) }, relevantFiles: inspection.snapshot.changedPaths, objectiveEvidence: [{ historicalHead: inspection.historicalHead, historicalTree: inspection.historicalTree, repairBase: inspection.repairBase, descendantHead: inspection.descendantHead, candidateTree: inspection.candidateTree }, ...retainedEvidence] } }, { path: deltaRelativePath, content: delta, hash: deltaHash, bytes: Buffer.byteLength(delta), changedPaths: inspection.snapshot.changedPaths });
      if (postCutoverDependencyFingerprint(checkout) !== dependencyHash) throw new Error("post-cutover reviewer changed the lockfile-installed dependency snapshot");
      const checks = this.runChecks(workflow, checkout, inspection);
      if (postCutoverDependencyFingerprint(checkout) !== dependencyHash) throw new Error("post-cutover check sequence changed the lockfile-installed dependency snapshot");
      const prepared: PostCutoverPreparedEvidence = {
        ...inspection,
        authorityRevision: workflow.revision,
        authorityHistoryHash: hashContract(workflow.orchestration.history),
        authorityCwd: workflow.orchestration.parent?.cwd ?? "",
        taskIds: [...POST_CUTOVER_ADOPTION_TASK_IDS],
        taskContracts: workflow.tasks.slice(0, POST_CUTOVER_ADOPTION_TASK_IDS.length).map((task) => ({ taskId: task.id, revision: task.contract.revision, hash: task.contract.hash })),
        ...reviews,
        checks,
        retainedEvidence,
        decisions: [],
      };
      this.assertCandidate(checkout, inspection);
      return prepared;
    } finally {
      try { this.git(["worktree", "remove", "--force", checkout], this.cwd, 256 * 1024); } catch { rmSync(root, { recursive: true, force: true }); }
      rmSync(root, { recursive: true, force: true });
    }
  }

  evidenceHash(prepared: PostCutoverPreparedEvidence): string { return postCutoverEvidenceHash(prepared); }

  private runChecks(workflow: Workflow, checkout: string, inspection: PostCutoverInspection): PostCutoverCheckReceipt[] {
    const parent = workflow.orchestration.parent;
    if (!parent?.valid) throw new Error("post-cutover checks require the current valid parent authority");
    const authority = new PostCutoverCheckAuthority(checkout, inspection, parent, this.now);
    const receipts: PostCutoverCheckReceipt[] = [];
    for (const task of workflow.tasks.slice(0, POST_CUTOVER_ADOPTION_TASK_IDS.length)) for (const command of task.verification) {
      const grant = authority.authorize(task, command);
      receipts.push(authority.execute(grant, parent));
    }
    return receipts;
  }

  private installCandidateDependencies(checkout: string): void {
    const lock = readFileSync(join(checkout, "package-lock.json"));
    const lockHash = createHash("sha256").update(lock).digest("hex");
    const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000, maxBuffer: MAX_CHECK_OUTPUT_BYTES, env: { ...process.env, CI: "1" } });
    if (result.error || result.signal || result.status !== 0) throw new Error(`clean candidate dependency install failed for lock sha256:${lockHash}`);
    assertPostCutoverDependencyTree(join(checkout, "node_modules"));
  }

  private retainedEvidence(): { path: string; sha256: string; commit: string } {
    const root = realpathSync(this.cwd);
    const unresolved = resolve(root, REPORT_PATH);
    const rel = relative(root, unresolved);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("retained post-cutover approval report is outside the repository");
    let cursor = unresolved;
    while (cursor !== root) { if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) throw new Error("retained post-cutover approval report has a missing or symlinked ancestor"); cursor = dirname(cursor); }
    const path = realpathSync(unresolved);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0) throw new Error("retained post-cutover approval report is unsafe, writable, or oversized");
    const bytes = readFileSync(path);
    const match = bytes.toString("utf8").match(/^- Candidate commit: `([a-f0-9]{40})`$/m);
    if (!match) throw new Error("retained post-cutover approval report lacks an exact candidate commit");
    this.git(["cat-file", "-e", `${match[1]}^{commit}`], this.cwd);
    return { path: REPORT_PATH, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, commit: match[1]! };
  }

  private assertCandidate(checkout: string, inspection: PostCutoverInspection): void {
    if (this.git(["rev-parse", "HEAD"], checkout) !== inspection.descendantHead || this.git(["rev-parse", "HEAD^{tree}"], checkout) !== inspection.candidateTree || this.status(checkout)) throw new Error("disposable post-cutover candidate does not match the reviewed commit/tree");
  }
  private status(cwd: string): string { return this.git(["status", "--porcelain=v1", "--untracked-files=all"], cwd, 256 * 1024); }
  private git(args: string[], cwd: string, maxBuffer = 128 * 1024): string { return this.gitRaw(args, cwd, maxBuffer).trim(); }
  private gitRaw(args: string[], cwd: string, maxBuffer: number): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
    if (result.error || result.signal || result.status !== 0) throw new Error(`git ${args[0]} failed during post-cutover preparation`);
    return result.stdout ?? "";
  }
}

export function assertPostCutoverReviewBounds(deltaBytes: number, changedPaths: string[]): void {
  if (!Number.isSafeInteger(deltaBytes) || deltaBytes < 0 || deltaBytes > MAX_POST_CUTOVER_DELTA_BYTES) throw new Error(`post-cutover cumulative binary delta exceeds ${MAX_POST_CUTOVER_DELTA_BYTES} byte bound`);
  if (changedPaths.length > MAX_POST_CUTOVER_CHANGED_PATHS) throw new Error(`post-cutover changed-path inventory exceeds ${MAX_POST_CUTOVER_CHANGED_PATHS} path bound`);
}

type PostCutoverCheckGrant = {
  id: string; taskId: string; command: string; args: string[]; contractHash: string; snapshotHash: string; candidateTree: string;
  ownerId: string; sessionId: string; runtimeId: string; cwd: string;
};

export class PostCutoverCheckAuthority {
  readonly cwd: string;
  readonly inspection: PostCutoverInspection;
  readonly parent: ParentAuthority;
  readonly now: () => string;
  private readonly grants = new Map<string, PostCutoverCheckGrant>();

  constructor(cwd: string, inspection: PostCutoverInspection, parent: ParentAuthority, now = () => new Date().toISOString()) {
    this.cwd = resolve(cwd); this.inspection = inspection; this.parent = { ...parent }; this.now = now;
  }

  authorize(task: WorkflowTask, command: VerificationCommand): PostCutoverCheckGrant {
    if (!this.parent.valid || resolve(this.parent.cwd) === this.cwd) throw new Error("post-cutover check authority requires a distinct disposable checkout and valid controlling parent");
    const grant = Object.freeze({ id: `post-cutover-check-${randomUUID()}`, taskId: task.id, command: command.command, args: [...command.args], contractHash: task.contract.hash, snapshotHash: this.inspection.snapshot.hash, candidateTree: this.inspection.candidateTree, ownerId: this.parent.ownerId, sessionId: this.parent.sessionId, runtimeId: this.parent.runtimeId, cwd: this.cwd });
    this.grants.set(grant.id, grant);
    return grant;
  }

  execute(grant: PostCutoverCheckGrant, parent: ParentAuthority): PostCutoverCheckReceipt {
    const issued = this.grants.get(grant.id);
    this.grants.delete(grant.id);
    if (issued !== grant) throw new Error("post-cutover check grant is forged, stale, or already consumed");
    if (!parent.valid || parent.ownerId !== grant.ownerId || parent.sessionId !== grant.sessionId || parent.runtimeId !== grant.runtimeId || resolve(parent.cwd) !== resolve(this.parent.cwd)) throw new Error("post-cutover check parent authority changed");
    const beforeTree = this.git(["rev-parse", "HEAD^{tree}"]);
    if (beforeTree !== grant.candidateTree || this.status()) throw new Error("post-cutover candidate changed before a protected check");
    const startedAt = this.now();
    const result = spawnSync(grant.command, grant.args, { cwd: grant.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_CHECK_OUTPUT_BYTES, env: { ...process.env, CI: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
    const completedAt = this.now();
    const afterTree = this.git(["rev-parse", "HEAD^{tree}"]);
    const outputHash = `sha256:${createHash("sha256").update(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).digest("hex")}`;
    if (result.error || result.signal || result.status !== 0) throw new Error(`protected post-cutover check failed for ${grant.taskId}: ${grant.command}; output ${outputHash}`);
    if (beforeTree !== afterTree || afterTree !== grant.candidateTree || this.status()) throw new Error(`protected post-cutover check changed candidate source for ${grant.taskId}: ${grant.command}`);
    return { taskId: grant.taskId, command: grant.command, args: [...grant.args], exitCode: 0, contractHash: grant.contractHash, snapshotHash: grant.snapshotHash, beforeTree, afterTree, outputHash, startedAt, completedAt, authorizationId: grant.id, executor: "post-cutover-protected-executor", ownerId: grant.ownerId, sessionId: grant.sessionId, runtimeId: grant.runtimeId };
  }

  private status(): string { return this.git(["status", "--porcelain=v1", "--untracked-files=all"]); }
  private git(args: string[]): string {
    const result = spawnSync("git", args, { cwd: this.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
    if (result.error || result.signal || result.status !== 0) throw new Error(`git ${args[0]} failed during protected post-cutover check`);
    return (result.stdout ?? "").trim();
  }
}

export function postCutoverDependencyFingerprint(checkout: string): string {
  const root = realpathSync(checkout);
  const dependencyRoot = join(root, "node_modules");
  if (!existsSync(dependencyRoot)) return `sha256:${createHash("sha256").update("no-node-modules").digest("hex")}`;
  assertPostCutoverDependencyTree(dependencyRoot);
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const visit = (path: string, relativePath: string, depth: number): void => {
    if (depth > 32 || ++entries > 100_000) throw new Error("post-cutover dependency fingerprint exceeds depth or entry bounds");
    const stat = lstatSync(path);
    hash.update(`${relativePath}\0${stat.mode & 0o7777}\0${stat.size}\0`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const actual = realpathSync(path);
      const rel = relative(dependencyRoot, actual);
      if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("post-cutover dependency symlink escapes the isolated dependency tree");
      hash.update(`link\0${target}\0`);
      return;
    }
    if (stat.isDirectory()) { for (const entry of readdirSync(path).sort()) visit(join(path, entry), `${relativePath}/${entry}`, depth + 1); return; }
    if (!stat.isFile()) throw new Error("post-cutover dependency tree contains a non-regular entry");
    bytes += stat.size;
    if (bytes > 1024 * 1024 * 1024) throw new Error("post-cutover dependency fingerprint exceeds its byte bound");
    hash.update(readFileSync(path));
  };
  visit(dependencyRoot, "node_modules", 0);
  return `sha256:${hash.digest("hex")}`;
}

export function assertPostCutoverDependencyTree(path: string): void {
  const modules = lstatSync(path);
  if (!modules.isDirectory() || modules.isSymbolicLink()) throw new Error("clean candidate dependency install did not produce a real directory");
}
