import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

import { isValidTopic, scopeAllowsPath, type IntegrationReceipt, type WorkspaceReceipt } from "./workflow.ts";

const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFiles: 20_000,
  maxBytes: 256 * 1024 * 1024,
  maxPatchBytes: 32 * 1024 * 1024,
  maxPathBytes: 4_096,
};
const AUTHORITY_PREFIXES = [".model-artifacts/initiatives/", ".model-artifacts/system/"];
const MAX_RECEIPT_PATHS = 128;
const MAX_BASELINE_UNTRACKED_PATHS = 512;
const MAX_WRITE_SCOPES = 64;
const MAX_RECEIPT_PATH_LENGTH = 512;
const ZERO = Buffer.from([0]);

export type WorkspaceLimits = { maxFiles: number; maxBytes: number; maxPatchBytes: number; maxPathBytes: number };
export type RepositoryPreflight = {
  root: string;
  gitDir: string;
  head: string;
  branch: string | null;
  indexHash: string;
  indexTree: string;
  stagedPatchHash: string;
  unstagedPatchHash: string;
  sourceSnapshotHash: string;
};
export type GitWorkspaceReceipt = WorkspaceReceipt & {
  version: 1;
  root: string;
  path: string;
  taskId: string;
  topic: string;
  baselineCommit: string;
  baselineRef: string;
  worktreeGitDir: string;
  ownershipToken: string;
  intentPath: string;
  workspaceHeadCommit: string;
  preparedResultCommit?: string;
  preparedResultRef?: string;
  preparedPatchHash?: string;
  realHead: string;
  realBranch?: string | null;
  realIndexHash: string;
  realIndexTree: string;
  stagedPatchHash: string;
  unstagedPatchHash: string;
  realSourceSnapshotHash: string;
  includedUntracked: string[];
  baselineUntrackedPathHashes?: string[];
  managedPaths: string[];
  integrationBaseCommit?: string;
  writeScope: string[];
};
export type PreparedIntegration = {
  receipt: GitWorkspaceReceipt;
  patch: Buffer;
  patchHash: string;
  resultCommit: string;
  resultRef: string;
  changedPaths: string[];
  patchPaths: string[];
  preflight: RepositoryPreflight;
};
type WorkspaceCreationIntent = {
  version: 1;
  workspaceId: string;
  workspacePath: string;
  ownershipToken: string;
  baselineCommit: string;
  baselineRef: string;
  workspaceHeadCommit: string;
  integrationBaseCommit?: string;
  managedPaths: string[];
  changedPaths: string[];
  before: RepositoryPreflight;
  input: { topic: string; taskId: string; writeScope: string[]; includedUntracked: string[]; baselineUntrackedPathHashes: string[]; createdAt: string };
  receipt?: GitWorkspaceReceipt;
};

export type GitIntegrationReceipt = IntegrationReceipt & {
  version: 1;
  workspaceId: string;
  resultCommit: string;
  resultRef: string;
  observedHead: string;
  observedBranch?: string | null;
  observedIndexHash: string;
  changedPaths: string[];
};

/**
 * Creates detached Git worktrees without staging, stashing, resetting, committing,
 * or pushing on the user's branch. Synthetic commits and pinned refs remain in the
 * local object database until cleanup. Worktrees are retained after every failed,
 * rejected, paused, or interrupted operation; explicit discard authorization is
 * required to remove unintegrated work.
 *
 * Integration verifies Git-visible preimages and uses `git apply` without `--index`.
 * It therefore preserves the user's index, but is not a filesystem transaction
 * against arbitrary same-user processes writing concurrently.
 */
export class GitWorkspaceManager {
  readonly root: string;
  readonly limits: WorkspaceLimits;

  constructor(cwd: string, limits: Partial<WorkspaceLimits> = {}) {
    this.root = resolve(cwd);
    if (this.root !== this.root.trim()) throw new Error("repository roots with leading/trailing whitespace are unsupported");
    if (this.root.length > 2_048) throw new Error("repository root exceeds workflow receipt bounds");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits) as Array<[keyof WorkspaceLimits, number]>) {
      if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) throw new Error(`invalid workspace limit ${name}`);
    }
  }

  preflight(includedUntracked: string[] = []): RepositoryPreflight {
    const sourcePaths = includedUntracked.map(validatePath);
    if (sourcePaths.some(isAuthorityPath)) throw new Error("Git/workflow authority cannot be included in a source fingerprint");
    const root = this.gitText(["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(this.root)) throw new Error(`cwd must be the Git repository root: ${root}`);
    if (this.gitText(["rev-parse", "--is-bare-repository"]) !== "false") throw new Error("bare repositories are unsupported");
    const gitDir = resolve(this.root, this.gitText(["rev-parse", "--git-dir"]));
    const head = this.requiredCommit("HEAD", "an unborn repository is unsupported");
    this.rejectRepositoryFeatures(gitDir, sourcePaths);
    if (this.git(["ls-files", "--unmerged", "-z"]).length) throw new Error("unresolved index conflicts are unsupported");
    const stagedEntries = this.git(["ls-files", "--stage", "-z"]);
    if (splitZero(this.git(["status", "--porcelain=v2", "-z", "--untracked-files=no"])).some((entry) => /^1 \.A /.test(entry))) throw new Error("intent-to-add index entries are unsupported; stage or unstage them before creating a workspace");
    const flags = this.git(["ls-files", "-v", "-z"]);
    if (splitZero(flags).some((entry) => entry.startsWith("S ") || entry.startsWith("h "))) throw new Error("skip-worktree/assume-unchanged index entries are unsupported");
    const indexHash = hash(stagedEntries);
    const indexTree = this.gitText(["write-tree"]);
    const stagedPatchHash = hash(this.git(["diff", "--cached", "--binary", "--full-index", head]));
    const unstagedPatchHash = hash(this.git(["diff", "--binary", "--full-index"]));
    const sourceSnapshotHash = this.fingerprintSource(sourcePaths);
    return { root: this.root, gitDir, head, branch: this.optionalText(["symbolic-ref", "--short", "HEAD"]), indexHash, indexTree, stagedPatchHash, unstagedPatchHash, sourceSnapshotHash };
  }

  inspectVerificationSource(receipt: GitWorkspaceReceipt, integration: GitIntegrationReceipt): { hash: string; head: string; branch: string | null; changedPaths: string[] } {
    this.validateReceiptShape(receipt);
    if (integration.workspaceId !== receipt.workspaceId || integration.resultCommit !== receipt.preparedResultCommit || integration.postSnapshotHash !== receipt.snapshotHash) throw new Error("verification receipts do not describe the same integrated source snapshot");
    if (!receipt.baselineUntrackedPathHashes) throw new Error("workspace receipt lacks the bounded baseline untracked inventory required for verification");
    const baselineUntracked = new Set(receipt.baselineUntrackedPathHashes);
    const known = new Set([...receipt.includedUntracked, ...receipt.managedPaths]);
    const unexpectedUntracked = this.eligibleUntrackedPaths().filter((path) => !known.has(path) && !baselineUntracked.has(hash(Buffer.from(path))));
    const current = this.preflight([...this.receiptSourcePaths(receipt), ...unexpectedUntracked]);
    const changedPaths = [...new Set([
      ...splitZero(this.git(["diff", "--name-only", "-z", integration.resultCommit, "--"])).filter(Boolean).filter((path) => !isAuthorityPath(path)),
      ...unexpectedUntracked,
    ])].sort(compareUtf8);
    return { hash: current.sourceSnapshotHash, head: current.head, branch: current.branch, changedPaths };
  }

  createWorkspace(input: { topic: string; taskId: string; writeScope: string[]; includeUntracked?: string[]; workspaceId?: string; createdAt?: string }): GitWorkspaceReceipt {
    if (!input.writeScope.length) throw new Error("workspace requires a non-empty write scope");
    if (input.writeScope.length > MAX_WRITE_SCOPES) throw new Error(`workspace write scope exceeds ${MAX_WRITE_SCOPES} entries`);
    if (!isValidTopic(input.topic)) throw new Error("invalid workspace topic");
    const taskId = safeId(input.taskId, "task id");
    const writeScope = input.writeScope.map(validateScope);
    const createdAt = validTimestamp(input.createdAt ?? new Date().toISOString(), "workspace creation timestamp");
    const workspaceId = safeId(input.workspaceId ?? randomUUID(), "workspace id");
    const eligibleUntracked = this.eligibleUntrackedPaths();
    const includedUntracked = this.validateIncludedUntracked(input.includeUntracked ?? [], eligibleUntracked);
    const baselineUntrackedPathHashes = eligibleUntracked.map((path) => hash(Buffer.from(path))).sort();
    const before = this.preflight(includedUntracked);
    const baseline = this.captureCommit(before.head, includedUntracked, `pi-swe baseline ${workspaceId}`);
    const baselineRef = `refs/pi-swe/baselines/${workspaceId}`;
    const resultRef = `refs/pi-swe/results/${workspaceId}`;
    if (this.refCommit(baselineRef) || this.refCommit(resultRef)) throw new Error(`workspace retention ref already exists: ${workspaceId}`);
    const workspacePath = mkdtempSync(join(tmpdir(), `pi-swe-${workspaceId.slice(0, 12)}-`));
    const ownershipToken = randomUUID();
    const intentPath = this.intentPath(workspaceId);
    const intent: WorkspaceCreationIntent = {
      version: 1, workspaceId, workspacePath, ownershipToken, baselineCommit: baseline, baselineRef,
      workspaceHeadCommit: baseline, managedPaths: [], changedPaths: [], before,
      input: { topic: input.topic, taskId, writeScope, includedUntracked, baselineUntrackedPathHashes, createdAt },
    };
    this.writeIntent(intent, true);
    let registered = false;
    let acquired = false;
    try {
      this.acquireRef(baselineRef, baseline);
      acquired = true;
      this.git(["worktree", "add", "--detach", workspacePath, baseline]);
      registered = true;
      const snapshotHash = this.fingerprintTree(baseline);
      if (snapshotHash !== before.sourceSnapshotHash) throw new Error("synthetic baseline does not match the captured working-copy bytes");
      const worktreeGitDir = this.gitText(["-C", workspacePath, "rev-parse", "--absolute-git-dir"]);
      writeFileSync(join(worktreeGitDir, "pi-swe-owner"), ownershipToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const receipt: GitWorkspaceReceipt = {
        version: 1, workspaceId, root: this.root, path: workspacePath, taskId,
        topic: input.topic, baselineHash: before.sourceSnapshotHash, baselineCommit: baseline, baselineRef,
        worktreeGitDir, ownershipToken, intentPath, workspaceHeadCommit: baseline, snapshotHash,
        realHead: before.head, realBranch: before.branch, realIndexHash: before.indexHash, realIndexTree: before.indexTree,
        stagedPatchHash: before.stagedPatchHash, unstagedPatchHash: before.unstagedPatchHash,
        realSourceSnapshotHash: before.sourceSnapshotHash,
        includedUntracked, baselineUntrackedPathHashes, managedPaths: [], writeScope, changedPaths: [], createdAt,
      };
      this.writeIntent({ ...intent, receipt });
      return receipt;
    } catch (error) {
      if (registered) this.gitBestEffort(["worktree", "remove", "--force", workspacePath]);
      if (acquired) this.gitBestEffort(["update-ref", "-d", baselineRef, baseline]);
      rmSync(workspacePath, { recursive: true, force: true });
      rmSync(intentPath, { force: true });
      this.gitBestEffort(["worktree", "prune", "--expire", "now"]);
      throw error;
    }
  }

  recoverWorkspace(workspaceId: string): GitWorkspaceReceipt {
    const intent = this.readIntent(safeId(workspaceId, "workspace id"));
    if (intent.receipt) {
      this.validateReceipt(intent.receipt);
      return intent.receipt;
    }
    const baselineCurrent = this.refCommit(intent.baselineRef);
    if (!baselineCurrent) this.acquireRef(intent.baselineRef, intent.baselineCommit);
    else if (baselineCurrent !== intent.baselineCommit) throw new Error("workspace creation baseline ref drifted");
    if (!entryExists(intent.workspacePath)) mkdirSync(intent.workspacePath, { recursive: true, mode: 0o700 });
    let worktreeGitDir = this.optionalText(["-C", intent.workspacePath, "rev-parse", "--absolute-git-dir"]);
    if (!worktreeGitDir) {
      this.git(["worktree", "prune", "--expire", "now"]);
      this.git(["worktree", "add", "--detach", intent.workspacePath, intent.workspaceHeadCommit]);
      worktreeGitDir = this.gitText(["-C", intent.workspacePath, "rev-parse", "--absolute-git-dir"]);
    }
    const marker = join(worktreeGitDir, "pi-swe-owner");
    if (!entryExists(marker)) writeFileSync(marker, intent.ownershipToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    else if (readFileSync(marker, "utf8") !== intent.ownershipToken) throw new Error("workspace creation ownership marker drifted");
    const receipt: GitWorkspaceReceipt = {
      version: 1, workspaceId: intent.workspaceId, root: this.root, path: intent.workspacePath, taskId: intent.input.taskId,
      topic: intent.input.topic, baselineHash: intent.before.sourceSnapshotHash, baselineCommit: intent.baselineCommit, baselineRef: intent.baselineRef,
      worktreeGitDir, ownershipToken: intent.ownershipToken, intentPath: this.intentPath(intent.workspaceId), workspaceHeadCommit: intent.workspaceHeadCommit,
      ...(intent.integrationBaseCommit ? { integrationBaseCommit: intent.integrationBaseCommit } : {}),
      snapshotHash: this.fingerprintTree(intent.workspaceHeadCommit), realHead: intent.before.head, realBranch: intent.before.branch, realIndexHash: intent.before.indexHash,
      realIndexTree: intent.before.indexTree, stagedPatchHash: intent.before.stagedPatchHash, unstagedPatchHash: intent.before.unstagedPatchHash,
      realSourceSnapshotHash: intent.before.sourceSnapshotHash, includedUntracked: intent.input.includedUntracked,
      baselineUntrackedPathHashes: intent.input.baselineUntrackedPathHashes,
      managedPaths: intent.managedPaths, writeScope: intent.input.writeScope, changedPaths: intent.changedPaths, createdAt: intent.input.createdAt,
    };
    this.validateReceipt(receipt);
    this.writeIntent({ ...intent, receipt });
    return receipt;
  }

  prepareIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    this.validateReceipt(receipt);
    const currentBaseline = this.requiredCommit(receipt.baselineRef, "workspace baseline ref is missing");
    if (currentBaseline !== receipt.baselineCommit) throw new Error("workspace baseline ref drifted");
    const preflight = this.preflight(this.receiptSourcePaths(receipt));
    this.assertMainUnchanged(receipt, preflight);
    const resultCommit = this.captureWorkspaceCommit(receipt);
    const applyBaseCommit = receipt.integrationBaseCommit ?? receipt.baselineCommit;
    const changedPaths = this.changedPaths(receipt.baselineCommit, resultCommit);
    const patchPaths = this.changedPaths(applyBaseCommit, resultCommit);
    if (changedPaths.length > MAX_RECEIPT_PATHS || patchPaths.length > MAX_RECEIPT_PATHS) throw new Error(`workspace change set exceeds ${MAX_RECEIPT_PATHS} receipt entries`);
    this.validateChangedPaths(receipt, resultCommit, [...new Set([...changedPaths, ...patchPaths])]);
    for (const path of patchPaths) {
      const existedAtApplyBase = this.optionalText(["ls-tree", applyBaseCommit, "--", path]);
      if (!existedAtApplyBase && existsSync(resolve(this.root, path))) throw new Error(`untracked collision blocks integration: ${path}`);
    }
    const patch = this.git(["diff", "--binary", "--full-index", "--find-renames", applyBaseCommit, resultCommit]);
    if (patch.byteLength > this.limits.maxPatchBytes) throw new Error(`patch exceeds ${this.limits.maxPatchBytes} byte limit`);
    const resultSnapshotHash = this.fingerprintTree(resultCommit);
    const resultRef = `refs/pi-swe/results/${receipt.workspaceId}`;
    const currentResult = this.refCommit(resultRef);
    if (currentResult) {
      if (currentResult === resultCommit) { /* idempotent recovery after ref acquisition but before receipt persistence */ }
      else if (receipt.preparedResultCommit && currentResult === receipt.preparedResultCommit) this.git(["update-ref", resultRef, resultCommit, currentResult]);
      else throw new Error("workspace result ref is owned by another preparation");
    } else this.acquireRef(resultRef, resultCommit);
    const patchHash = hash(patch);
    const preparedReceipt: GitWorkspaceReceipt = {
      ...receipt, snapshotHash: resultSnapshotHash, changedPaths,
      preparedResultCommit: resultCommit, preparedResultRef: resultRef, preparedPatchHash: patchHash,
    };
    this.updateIntentReceipt(preparedReceipt);
    return { receipt: preparedReceipt, patch, patchHash, resultCommit, resultRef, changedPaths, patchPaths, preflight };
  }

  resumePreparedIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    this.validateReceipt(receipt);
    if (!receipt.preparedResultCommit || !receipt.preparedResultRef || !receipt.preparedPatchHash) throw new Error("workspace receipt has no prepared integration intent");
    if (receipt.preparedResultRef !== `refs/pi-swe/results/${receipt.workspaceId}` || this.requiredCommit(receipt.preparedResultRef, "prepared result ref is missing") !== receipt.preparedResultCommit) throw new Error("prepared integration intent ref drifted");
    const applyBaseCommit = receipt.integrationBaseCommit ?? receipt.baselineCommit;
    if (this.requiredCommit(`${receipt.preparedResultCommit}^`, "prepared result commit has no parent") !== applyBaseCommit) throw new Error("prepared result commit has the wrong integration parent");
    const changedPaths = this.changedPaths(receipt.baselineCommit, receipt.preparedResultCommit);
    const patchPaths = this.changedPaths(applyBaseCommit, receipt.preparedResultCommit);
    this.validateChangedPaths(receipt, receipt.preparedResultCommit, [...new Set([...changedPaths, ...patchPaths])]);
    const patch = this.git(["diff", "--binary", "--full-index", "--find-renames", applyBaseCommit, receipt.preparedResultCommit]);
    if (patch.byteLength > this.limits.maxPatchBytes || hash(patch) !== receipt.preparedPatchHash) throw new Error("prepared integration intent patch drifted");
    if (this.fingerprintTree(receipt.preparedResultCommit) !== receipt.snapshotHash || !sameStrings(changedPaths, receipt.changedPaths)) throw new Error("prepared integration intent snapshot drifted");
    return {
      receipt, patch, patchHash: receipt.preparedPatchHash, resultCommit: receipt.preparedResultCommit,
      resultRef: receipt.preparedResultRef, changedPaths, patchPaths,
      preflight: this.preflight(this.receiptSourcePaths(receipt)),
    };
  }

  integrate(prepared: PreparedIntegration, integratedAt = new Date().toISOString()): GitIntegrationReceipt {
    const { receipt } = prepared;
    this.validateReceipt(receipt);
    validTimestamp(integratedAt, "integration timestamp");
    const expectedResultRef = `refs/pi-swe/results/${receipt.workspaceId}`;
    if (prepared.resultRef !== expectedResultRef) throw new Error("prepared result ref does not match the workspace owner");
    const pinnedResult = this.requiredCommit(prepared.resultRef, "prepared result ref is missing");
    if (pinnedResult !== prepared.resultCommit) throw new Error("prepared result ref drifted");
    const applyBaseCommit = receipt.integrationBaseCommit ?? receipt.baselineCommit;
    if (this.requiredCommit(`${prepared.resultCommit}^`, "prepared result commit has no parent") !== applyBaseCommit) throw new Error("prepared result commit has the wrong integration parent");
    const changedPaths = this.changedPaths(receipt.baselineCommit, prepared.resultCommit);
    const patchPaths = this.changedPaths(applyBaseCommit, prepared.resultCommit);
    if (!sameStrings(changedPaths, prepared.changedPaths) || !sameStrings(patchPaths, prepared.patchPaths)) throw new Error("prepared integration path metadata was modified");
    const patch = this.git(["diff", "--binary", "--full-index", "--find-renames", applyBaseCommit, prepared.resultCommit]);
    if (!patch.equals(prepared.patch) || hash(patch) !== prepared.patchHash) throw new Error("prepared integration patch was modified");
    const observed = this.preflight(this.receiptSourcePaths(receipt));
    this.assertMainHeadAndIndexUnchanged(receipt, observed);
    const expectedPost = this.fingerprintTree(prepared.resultCommit);
    const observedFull = this.fingerprintSource([...this.receiptSourcePaths(receipt), ...prepared.changedPaths]);
    if (observedFull === expectedPost) return this.integrationReceipt(prepared, observed, expectedPost, integratedAt);
    if (observed.sourceSnapshotHash !== receipt.realSourceSnapshotHash) throw new Error(`integration is partial or the main checkout drifted; workspace retained at ${receipt.path}`);
    for (const path of prepared.patchPaths) {
      const existedAtApplyBase = this.optionalText(["ls-tree", applyBaseCommit, "--", path]);
      if (!existedAtApplyBase && entryExists(resolve(this.root, path))) throw new Error(`integration is partial or has an untracked collision: ${path}`);
    }
    if (prepared.patch.length) {
      this.git(["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: prepared.patch });
      try {
        this.git(["apply", "--binary", "--whitespace=nowarn", "-"], { input: prepared.patch });
      } catch (error) {
        const afterFailure = this.preflight(this.receiptSourcePaths(receipt));
        this.assertMainHeadAndIndexUnchanged(receipt, afterFailure);
        const failedImage = this.fingerprintSource([...this.receiptSourcePaths(receipt), ...prepared.changedPaths]);
        if (failedImage !== receipt.realSourceSnapshotHash) throw new Error(`integration was interrupted or partially applied; workspace retained at ${receipt.path}; inspect the working tree before retrying`);
        throw error;
      }
    }
    const after = this.preflight(this.receiptSourcePaths(receipt));
    this.assertMainHeadAndIndexUnchanged(receipt, after);
    const afterFull = this.fingerprintSource([...this.receiptSourcePaths(receipt), ...prepared.changedPaths]);
    if (afterFull !== expectedPost) throw new Error("post-integration source image does not match the prepared patch; workspace retained for recovery");
    return this.integrationReceipt(prepared, after, expectedPost, integratedAt);
  }

  cumulativeDiff(receipt: GitWorkspaceReceipt): Buffer {
    this.validateReceipt(receipt);
    if (!receipt.preparedResultCommit) throw new Error("workspace receipt has no prepared cumulative result");
    const patch = this.git(["diff", "--binary", "--full-index", "--find-renames", receipt.baselineCommit, receipt.preparedResultCommit]);
    if (patch.byteLength > this.limits.maxPatchBytes) throw new Error(`cumulative delta exceeds ${this.limits.maxPatchBytes} byte limit`);
    return patch;
  }

  createRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt, workspaceId: string = randomUUID()): GitWorkspaceReceipt {
    this.validateReceipt(receipt);
    if (this.requiredCommit(receipt.baselineRef, "workspace baseline ref is missing") !== receipt.baselineCommit) throw new Error("workspace baseline ref drifted");
    if (integrated.workspaceId !== receipt.workspaceId || integrated.resultRef !== `refs/pi-swe/results/${receipt.workspaceId}`) throw new Error("integration receipt does not belong to the workspace");
    if (this.requiredCommit(integrated.resultRef, "integration result ref is missing") !== integrated.resultCommit) throw new Error("integration result ref drifted");
    if (this.fingerprintTree(integrated.resultCommit) !== integrated.postSnapshotHash) throw new Error("integration result commit does not match its post-image");
    const current = this.preflight([...this.receiptSourcePaths(receipt), ...integrated.changedPaths]);
    if (current.sourceSnapshotHash !== integrated.postSnapshotHash) throw new Error("cannot reconstruct remediation after source drift");
    const id = safeId(workspaceId, "workspace id");
    const ref = `refs/pi-swe/baselines/${id}`;
    const resultRef = `refs/pi-swe/results/${id}`;
    if (this.refCommit(ref) || this.refCommit(resultRef)) throw new Error(`workspace retention ref already exists: ${id}`);
    const path = mkdtempSync(join(tmpdir(), `pi-swe-${id.slice(0, 12)}-`));
    const ownershipToken = randomUUID();
    const createdAt = new Date().toISOString();
    const managedPaths = [...new Set([...receipt.managedPaths, ...integrated.changedPaths])].sort();
    const intent: WorkspaceCreationIntent = {
      version: 1, workspaceId: id, workspacePath: path, ownershipToken, baselineCommit: receipt.baselineCommit, baselineRef: ref,
      workspaceHeadCommit: integrated.resultCommit, integrationBaseCommit: integrated.resultCommit, managedPaths, changedPaths: integrated.changedPaths,
      before: current, input: { topic: receipt.topic, taskId: receipt.taskId, writeScope: receipt.writeScope, includedUntracked: receipt.includedUntracked, baselineUntrackedPathHashes: receipt.baselineUntrackedPathHashes ?? this.eligibleUntrackedPaths().map((item) => hash(Buffer.from(item))).sort(), createdAt },
    };
    const intentPath = this.intentPath(id);
    this.writeIntent(intent, true);
    let registered = false;
    let acquired = false;
    try {
      this.acquireRef(ref, receipt.baselineCommit);
      acquired = true;
      this.git(["worktree", "add", "--detach", path, integrated.resultCommit]);
      registered = true;
      const worktreeGitDir = this.gitText(["-C", path, "rev-parse", "--absolute-git-dir"]);
      writeFileSync(join(worktreeGitDir, "pi-swe-owner"), ownershipToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const remediation: GitWorkspaceReceipt = {
        ...receipt, workspaceId: id, path, baselineRef: ref, integrationBaseCommit: integrated.resultCommit,
        worktreeGitDir, ownershipToken, intentPath, workspaceHeadCommit: integrated.resultCommit,
        preparedResultCommit: undefined, preparedResultRef: undefined, preparedPatchHash: undefined,
        baselineHash: current.sourceSnapshotHash, snapshotHash: this.fingerprintTree(integrated.resultCommit), changedPaths: integrated.changedPaths,
        managedPaths, baselineUntrackedPathHashes: intent.input.baselineUntrackedPathHashes,
        realHead: current.head, realBranch: current.branch, realIndexHash: current.indexHash, realIndexTree: current.indexTree,
        stagedPatchHash: current.stagedPatchHash, unstagedPatchHash: current.unstagedPatchHash,
        realSourceSnapshotHash: current.sourceSnapshotHash, createdAt,
      };
      this.writeIntent({ ...intent, receipt: remediation });
      return remediation;
    } catch (error) {
      if (registered) this.gitBestEffort(["worktree", "remove", "--force", path]);
      if (acquired) this.gitBestEffort(["update-ref", "-d", ref, receipt.baselineCommit]);
      rmSync(path, { recursive: true, force: true });
      rmSync(intentPath, { force: true });
      this.gitBestEffort(["worktree", "prune", "--expire", "now"]);
      throw error;
    }
  }

  createDriftRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt, workspaceId: string = randomUUID(), observedChangedPaths: string[] = []): GitWorkspaceReceipt {
    this.validateReceipt(receipt);
    if (integrated.workspaceId !== receipt.workspaceId || integrated.resultCommit !== receipt.preparedResultCommit) throw new Error("integration receipt does not belong to the prepared workspace");
    const explicitDriftPaths = [...new Set(observedChangedPaths.map(validatePath))].sort();
    if (explicitDriftPaths.length > MAX_RECEIPT_PATHS || explicitDriftPaths.some(isAuthorityPath)) throw new Error("verification drift paths exceed bounds or include workflow authority");
    const sourcePaths = [...new Set([...this.receiptSourcePaths(receipt), ...integrated.changedPaths, ...explicitDriftPaths])].sort();
    const current = this.preflight(sourcePaths);
    this.assertMainHeadAndIndexUnchanged(receipt, current);
    const currentCommit = this.captureCommit(current.head, sourcePaths.filter((path) => !this.optionalText(["ls-files", "--error-unmatch", "--", path])), `pi-swe drift baseline ${workspaceId}`);
    const cumulativePaths = this.changedPaths(receipt.baselineCommit, currentCommit);
    if (cumulativePaths.length > MAX_RECEIPT_PATHS) throw new Error(`drift remediation change set exceeds ${MAX_RECEIPT_PATHS} receipt entries`);
    const id = safeId(workspaceId, "workspace id");
    const ref = `refs/pi-swe/baselines/${id}`;
    const resultRef = `refs/pi-swe/results/${id}`;
    if (this.refCommit(ref) || this.refCommit(resultRef)) throw new Error(`workspace retention ref already exists: ${id}`);
    const path = mkdtempSync(join(tmpdir(), `pi-swe-${id.slice(0, 12)}-`));
    const ownershipToken = randomUUID();
    const createdAt = new Date().toISOString();
    const managedPaths = [...new Set([...receipt.managedPaths, ...cumulativePaths])].sort();
    const intent: WorkspaceCreationIntent = {
      version: 1, workspaceId: id, workspacePath: path, ownershipToken, baselineCommit: receipt.baselineCommit, baselineRef: ref,
      workspaceHeadCommit: currentCommit, integrationBaseCommit: currentCommit, managedPaths, changedPaths: cumulativePaths,
      before: current, input: { topic: receipt.topic, taskId: receipt.taskId, writeScope: receipt.writeScope, includedUntracked: receipt.includedUntracked, baselineUntrackedPathHashes: receipt.baselineUntrackedPathHashes ?? this.eligibleUntrackedPaths().map((item) => hash(Buffer.from(item))).sort(), createdAt },
    };
    const intentPath = this.intentPath(id);
    this.writeIntent(intent, true);
    let registered = false;
    let acquired = false;
    try {
      this.acquireRef(ref, receipt.baselineCommit);
      acquired = true;
      this.git(["worktree", "add", "--detach", path, currentCommit]);
      registered = true;
      const worktreeGitDir = this.gitText(["-C", path, "rev-parse", "--absolute-git-dir"]);
      writeFileSync(join(worktreeGitDir, "pi-swe-owner"), ownershipToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const remediation: GitWorkspaceReceipt = {
        ...receipt, workspaceId: id, path, baselineRef: ref, integrationBaseCommit: currentCommit,
        worktreeGitDir, ownershipToken, intentPath, workspaceHeadCommit: currentCommit,
        preparedResultCommit: undefined, preparedResultRef: undefined, preparedPatchHash: undefined,
        baselineHash: current.sourceSnapshotHash, snapshotHash: this.fingerprintTree(currentCommit), changedPaths: cumulativePaths,
        managedPaths, baselineUntrackedPathHashes: intent.input.baselineUntrackedPathHashes,
        realHead: current.head, realBranch: current.branch, realIndexHash: current.indexHash, realIndexTree: current.indexTree,
        stagedPatchHash: current.stagedPatchHash, unstagedPatchHash: current.unstagedPatchHash,
        realSourceSnapshotHash: current.sourceSnapshotHash, createdAt,
      };
      this.validateChangedPaths(remediation, currentCommit, cumulativePaths);
      this.writeIntent({ ...intent, receipt: remediation });
      return remediation;
    } catch (error) {
      if (registered) this.gitBestEffort(["worktree", "remove", "--force", path]);
      if (acquired) this.gitBestEffort(["update-ref", "-d", ref, receipt.baselineCommit]);
      rmSync(path, { recursive: true, force: true });
      rmSync(intentPath, { force: true });
      this.gitBestEffort(["worktree", "prune", "--expire", "now"]);
      throw error;
    }
  }

  cleanup(receipt: GitWorkspaceReceipt, options: { finalizedIntegration?: GitIntegrationReceipt; authorizeDiscard?: boolean } = {}): void {
    this.validateReceiptShape(receipt);
    const finalized = options.finalizedIntegration;
    if (finalized && (finalized.workspaceId !== receipt.workspaceId || finalized.resultRef !== `refs/pi-swe/results/${receipt.workspaceId}`)) throw new Error("finalized integration receipt does not belong to the workspace");
    if (!finalized && !options.authorizeDiscard) throw new Error("discarding an unfinalized workspace requires explicit authorization");
    if (entryExists(receipt.intentPath)) {
      const intent = this.readIntent(receipt.workspaceId);
      if (intent.ownershipToken !== receipt.ownershipToken || intent.baselineCommit !== receipt.baselineCommit) throw new Error("workspace creation intent ownership drifted; refusing cleanup");
    }
    const baselineCurrent = this.refCommit(receipt.baselineRef);
    if (baselineCurrent && baselineCurrent !== receipt.baselineCommit) throw new Error("workspace baseline ref was reassigned; refusing cleanup");
    const resultRef = `refs/pi-swe/results/${receipt.workspaceId}`;
    const resultCurrent = this.refCommit(resultRef);
    const expectedResult = finalized?.resultCommit ?? receipt.preparedResultCommit;
    if (resultCurrent && (!expectedResult || resultCurrent !== expectedResult)) throw new Error("workspace result ref was reassigned; refusing cleanup");
    if (entryExists(receipt.path)) {
      this.validateWorkspaceOwnership(receipt);
      this.git(["worktree", "remove", "--force", receipt.path]);
    } else if (entryExists(receipt.worktreeGitDir)) {
      this.validateOwnershipMarker(receipt);
      const pointerPath = join(receipt.worktreeGitDir, "gitdir");
      const pointer = entryExists(pointerPath) ? readFileSync(pointerPath, "utf8").trim() : "";
      if (resolve(pointer) !== resolve(receipt.path, ".git")) throw new Error("workspace Git administration ownership is ambiguous; refusing cleanup");
      this.git(["worktree", "prune", "--expire", "now"]);
    }
    if (baselineCurrent) this.git(["update-ref", "-d", receipt.baselineRef, receipt.baselineCommit]);
    if (resultCurrent && expectedResult) this.git(["update-ref", "-d", resultRef, expectedResult]);
    rmSync(receipt.intentPath, { force: true });
  }

  private captureWorkspaceCommit(receipt: GitWorkspaceReceipt): string {
    this.preflightWorkspaceOutput(receipt);
    const index = this.temporaryIndex(receipt.baselineCommit);
    try {
      this.git(["-C", receipt.path, "add", "-A", "--", "."], { env: { GIT_INDEX_FILE: index } });
      const tree = this.gitText(["-C", receipt.path, "write-tree"], { env: { GIT_INDEX_FILE: index } });
      return this.commitTree(tree, receipt.integrationBaseCommit ?? receipt.baselineCommit, `pi-swe workspace ${receipt.workspaceId}`);
    } finally { rmSync(dirname(index), { recursive: true, force: true }); }
  }

  private preflightWorkspaceOutput(receipt: GitWorkspaceReceipt): void {
    const entries = splitZero(this.git(["-C", receipt.path, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
    const sourceEntries = [...new Set(entries)];
    if (sourceEntries.length) {
      const attributes = splitZero(this.git(["-C", receipt.path, "check-attr", "-a", "-z", "--stdin"], { input: Buffer.from(`${sourceEntries.join("\0")}\0`) }));
      rejectTransforms(attributes);
    }
    if (sourceEntries.length > this.limits.maxFiles) throw new Error(`workspace output exceeds ${this.limits.maxFiles} file limit before Git ingestion`);
    let bytes = 0;
    for (const rawPath of sourceEntries) {
      const path = validatePath(rawPath);
      const absolute = resolve(receipt.path, path);
      if (!entryExists(absolute)) continue;
      const stat = lstatSync(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported workspace output: ${path}`);
      bytes += stat.isSymbolicLink() ? Buffer.byteLength(readlinkSync(absolute)) : stat.size;
      if (bytes > this.limits.maxBytes) throw new Error(`workspace output exceeds ${this.limits.maxBytes} byte limit before Git ingestion`);
    }
  }

  private captureCommit(parent: string, includedUntracked: string[], message: string): string {
    const index = this.temporaryIndex(parent);
    try {
      this.git(["add", "-u", "--", "."], { env: { GIT_INDEX_FILE: index } });
      if (includedUntracked.length) this.git(["add", "--", ...includedUntracked], { env: { GIT_INDEX_FILE: index } });
      const tree = this.gitText(["write-tree"], { env: { GIT_INDEX_FILE: index } });
      return this.commitTree(tree, parent, message);
    } finally { rmSync(dirname(index), { recursive: true, force: true }); }
  }

  private temporaryIndex(treeish: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-swe-index-"));
    const index = join(dir, "index");
    try {
      this.git(["read-tree", treeish], { env: { GIT_INDEX_FILE: index } });
      return index;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private commitTree(tree: string, parent: string, message: string): string {
    return this.gitText(["commit-tree", tree, "-p", parent, "-m", message], { env: {
      GIT_AUTHOR_NAME: "pi-swe", GIT_AUTHOR_EMAIL: "pi-swe@local.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "pi-swe", GIT_COMMITTER_EMAIL: "pi-swe@local.invalid", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    } });
  }

  private fingerprintSource(includedUntracked: string[]): string {
    const entries = this.listSourceEntries(includedUntracked);
    let bytes = 0;
    const digest = createHash("sha256");
    for (const entry of entries) {
      const path = resolve(this.root, entry);
      const stat = lstatSync(path);
      let content: Buffer;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || escapesRoot(entry, target)) throw new Error(`source baseline contains an escaping symlink: ${entry}`);
        content = Buffer.from(target);
      } else {
        if (bytes + stat.size > this.limits.maxBytes) throw new Error(`source snapshot exceeds ${this.limits.maxBytes} byte limit`);
        content = readFileSync(path);
      }
      bytes += content.byteLength;
      if (bytes > this.limits.maxBytes) throw new Error(`source snapshot exceeds ${this.limits.maxBytes} byte limit`);
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
      digest.update(entry).update(ZERO).update(mode).update(ZERO).update(content).update(ZERO);
    }
    return `sha256:${digest.digest("hex")}`;
  }

  private fingerprintTree(treeish: string): string {
    const listing = this.git(["ls-tree", "-r", "-z", treeish]);
    const records = splitZero(listing).filter(Boolean).filter((record) => {
      const tab = record.indexOf("\t");
      return tab >= 0 && !isAuthorityPath(record.slice(tab + 1));
    });
    if (records.length > this.limits.maxFiles) throw new Error(`source snapshot exceeds ${this.limits.maxFiles} file limit`);
    let bytes = 0;
    const digest = createHash("sha256");
    records.sort((left, right) => compareUtf8(left.slice(left.indexOf("\t") + 1), right.slice(right.indexOf("\t") + 1)));
    for (const record of records) {
      const [metadata, path] = record.split("\t", 2);
      const [mode, , object] = metadata!.split(" ");
      const size = Number(this.gitText(["cat-file", "-s", object!]));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid Git blob size for ${path}`);
      bytes += size;
      if (bytes > this.limits.maxBytes) throw new Error(`source snapshot exceeds ${this.limits.maxBytes} byte limit`);
      const content = this.git(["cat-file", "blob", object!]);
      digest.update(path!).update(ZERO).update(mode!).update(ZERO).update(content).update(ZERO);
    }
    return `sha256:${digest.digest("hex")}`;
  }

  private listSourceEntries(includedUntracked: string[]): string[] {
    const tracked = splitZero(this.git(["ls-files", "-z", "--cached", "--modified", "--deleted"]));
    const entries = [...new Set([...tracked, ...includedUntracked])].filter(Boolean).filter((path) => !isAuthorityPath(path)).sort(compareUtf8);
    if (entries.length > this.limits.maxFiles) throw new Error(`source snapshot exceeds ${this.limits.maxFiles} file limit`);
    for (const path of entries) {
      if (Buffer.byteLength(path) > this.limits.maxPathBytes) throw new Error(`path exceeds ${this.limits.maxPathBytes} byte limit`);
      if (!entryExists(resolve(this.root, path))) continue;
      const stat = lstatSync(resolve(this.root, path));
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported source entry: ${path}`);
    }
    return entries.filter((path) => entryExists(resolve(this.root, path)));
  }

  private eligibleUntrackedPaths(): string[] {
    const paths = splitZero(this.git(["ls-files", "--others", "--exclude-standard", "-z"])).filter(Boolean).map(validatePath).filter((path) => !isAuthorityPath(path)).sort(compareUtf8);
    if (paths.length > MAX_BASELINE_UNTRACKED_PATHS) throw new Error(`eligible untracked path inventory exceeds ${MAX_BASELINE_UNTRACKED_PATHS} entries`);
    return paths;
  }

  private validateIncludedUntracked(paths: string[], eligible = this.eligibleUntrackedPaths()): string[] {
    const normalized = [...new Set(paths.map(validatePath))].sort();
    if (normalized.length > MAX_RECEIPT_PATHS) throw new Error(`included untracked inputs exceed ${MAX_RECEIPT_PATHS} receipt entries`);
    const untracked = new Set(eligible);
    for (const path of normalized) {
      if (isAuthorityPath(path)) throw new Error(`workflow/runtime authority cannot be included in a source baseline: ${path}`);
      if (!untracked.has(path)) throw new Error(`explicit untracked input is not an eligible untracked file: ${path}`);
      const stat = lstatSync(resolve(this.root, path));
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`untracked input must be a file or symlink: ${path}`);
    }
    return normalized;
  }

  private changedPaths(from: string, to: string): string[] {
    const fields = splitZero(this.git(["diff", "--name-status", "-z", "--find-renames", from, to]));
    const paths: string[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++]!;
      if (/^[RC]/.test(status)) { paths.push(fields[index++]!, fields[index++]!); }
      else paths.push(fields[index++]!);
    }
    return [...new Set(paths.filter(Boolean))].sort();
  }

  private validateChangedPaths(receipt: GitWorkspaceReceipt, resultCommit: string, paths: string[]): void {
    for (const path of paths) {
      validatePath(path);
      if (isAuthorityPath(path)) throw new Error(`workspace changed workflow/runtime authority: ${path}`);
      if (!receipt.writeScope.some((scope) => scopeAllowsPath(scope, path))) throw new Error(`workspace changed out-of-scope path: ${path}`);
      const entry = this.optionalText(["ls-tree", resultCommit, "--", path]);
      if (entry?.startsWith("120000 ")) {
        const targetBytes = this.git(["show", `${resultCommit}:${path}`]);
        const target = decodeUtf8(targetBytes, `symlink target for ${path}`);
        if (isAbsolute(target) || escapesRoot(path, target)) throw new Error(`workspace contains an escaping symlink: ${path}`);
      }
    }
  }

  private integrationReceipt(prepared: PreparedIntegration, observed: RepositoryPreflight, postSnapshotHash: string, integratedAt: string): GitIntegrationReceipt {
    return {
      version: 1, integrationId: randomUUID(), workspaceId: prepared.receipt.workspaceId,
      preSnapshotHash: prepared.receipt.realSourceSnapshotHash, postSnapshotHash, patchHash: prepared.patchHash,
      resultCommit: prepared.resultCommit, resultRef: prepared.resultRef, observedHead: observed.head, observedBranch: observed.branch,
      observedIndexHash: observed.indexHash, changedPaths: prepared.changedPaths, integratedAt,
    };
  }

  private assertMainHeadAndIndexUnchanged(receipt: GitWorkspaceReceipt, current: RepositoryPreflight): void {
    if (current.head !== receipt.realHead) throw new Error("main checkout HEAD drifted since workspace creation");
    if (current.indexHash !== receipt.realIndexHash) throw new Error("main checkout index drifted since workspace creation");
  }

  private assertMainUnchanged(receipt: GitWorkspaceReceipt, current: RepositoryPreflight): void {
    this.assertMainHeadAndIndexUnchanged(receipt, current);
    if (current.sourceSnapshotHash !== receipt.realSourceSnapshotHash) throw new Error("main checkout content drifted since workspace creation");
  }

  private rejectRepositoryFeatures(gitDir: string, includedPaths: string[]): void {
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge"]) {
      if (existsSync(join(gitDir, marker))) throw new Error(`repository operation in progress (${marker}); resolve it before creating a workspace`);
    }
    if (existsSync(join(this.root, ".gitmodules")) || this.git(["ls-files", "--stage"]).toString("utf8").split("\n").some((line) => line.startsWith("160000 "))) throw new Error("submodules/gitlinks are unsupported by isolated workspaces");
    if (this.gitBestEffort(["config", "--bool", "core.sparseCheckout"]).toString().trim() === "true") throw new Error("sparse checkouts are unsupported");
    if (this.gitBestEffort(["config", "--bool", "core.fileMode"]).toString().trim() === "false") throw new Error("repositories that do not track executable modes are unsupported");
    if (this.gitBestEffort(["config", "--bool", "core.symlinks"]).toString().trim() === "false") throw new Error("repositories without native symlink support are unsupported");
    const filters = this.gitBestEffort(["config", "--get-regexp", "^filter\\."]).toString().trim();
    if (filters) throw new Error("Git content filters/LFS are unsupported by isolated workspaces");
    const autocrlf = this.gitBestEffort(["config", "--get", "core.autocrlf"]).toString().trim().toLowerCase();
    if (autocrlf && autocrlf !== "false") throw new Error("core.autocrlf transforms are unsupported by isolated workspaces");
    const paths = [...new Set([...splitZero(this.git(["ls-files", "-z"])), ...includedPaths])].sort();
    if (paths.length) {
      const output = splitZero(this.git(["check-attr", "-a", "-z", "--stdin"], { input: Buffer.from(`${paths.join("\0")}\0`) }));
      rejectTransforms(output);
    }
  }

  private receiptSourcePaths(receipt: GitWorkspaceReceipt): string[] {
    return [...new Set([...receipt.includedUntracked, ...receipt.managedPaths])].sort();
  }

  private validateReceiptShape(receipt: GitWorkspaceReceipt): void {
    if (realpathSync(receipt.root) !== realpathSync(this.root)) throw new Error("workspace receipt belongs to another repository");
    safeId(receipt.workspaceId, "workspace id");
    safeId(receipt.ownershipToken, "workspace ownership token");
    if (receipt.baselineRef !== `refs/pi-swe/baselines/${receipt.workspaceId}`) throw new Error("workspace baseline ref does not match its owner");
    if (receipt.intentPath !== this.intentPath(receipt.workspaceId)) throw new Error("workspace recovery intent path does not match its owner");
    if (receipt.preparedResultRef && receipt.preparedResultRef !== `refs/pi-swe/results/${receipt.workspaceId}`) throw new Error("workspace result ref does not match its owner");
    if (receipt.baselineUntrackedPathHashes && (receipt.baselineUntrackedPathHashes.length > MAX_BASELINE_UNTRACKED_PATHS || receipt.baselineUntrackedPathHashes.some((item) => !/^sha256:[a-f0-9]{64}$/.test(item)))) throw new Error("workspace baseline untracked inventory is invalid");
    for (const path of this.receiptSourcePaths(receipt)) {
      validatePath(path);
      if (isAuthorityPath(path)) throw new Error(`workspace receipt includes authority path: ${path}`);
    }
  }

  private validateOwnershipMarker(receipt: GitWorkspaceReceipt): void {
    if (!entryExists(receipt.worktreeGitDir) || !lstatSync(receipt.worktreeGitDir).isDirectory()) throw new Error("workspace Git administration directory is missing");
    const marker = join(receipt.worktreeGitDir, "pi-swe-owner");
    if (!entryExists(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== receipt.ownershipToken) throw new Error("workspace ownership marker does not match its receipt");
  }

  private validateWorkspaceOwnership(receipt: GitWorkspaceReceipt): void {
    if (!entryExists(receipt.path) || lstatSync(receipt.path).isSymbolicLink() || !lstatSync(receipt.path).isDirectory()) throw new Error("workspace path is missing or unsafe; recover it before continuing");
    this.validateOwnershipMarker(receipt);
    const observedGitDir = this.gitText(["-C", receipt.path, "rev-parse", "--absolute-git-dir"]);
    if (realpathSync(observedGitDir) !== realpathSync(receipt.worktreeGitDir)) throw new Error("workspace path is registered to another Git worktree");
    const rootCommon = this.gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const workspaceCommon = this.gitText(["-C", receipt.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (realpathSync(rootCommon) !== realpathSync(workspaceCommon)) throw new Error("workspace belongs to another Git repository");
    if (this.gitText(["-C", receipt.path, "rev-parse", "--verify", "HEAD^{commit}"]) !== receipt.workspaceHeadCommit) throw new Error("workspace HEAD drifted from its ownership receipt");
  }

  private validateReceipt(receipt: GitWorkspaceReceipt): void {
    this.validateReceiptShape(receipt);
    this.validateWorkspaceOwnership(receipt);
    if (this.requiredCommit(receipt.baselineRef, "workspace baseline ref is missing") !== receipt.baselineCommit) throw new Error("workspace baseline ref drifted");
  }

  private intentPath(workspaceId: string): string {
    const commonDir = this.gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const directory = join(commonDir, "pi-swe-intents");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${workspaceId}.json`);
  }

  private writeIntent(intent: WorkspaceCreationIntent, create = false): void {
    const path = this.intentPath(intent.workspaceId);
    const content = `${JSON.stringify(intent)}\n`;
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error("workspace creation intent exceeds 64 KiB");
    if (create) {
      try { writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
      catch (error) { if (entryExists(path)) throw new Error(`workspace creation intent already exists; recover ${intent.workspaceId} instead`); throw error; }
      return;
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }

  private updateIntentReceipt(receipt: GitWorkspaceReceipt): void {
    const intent = this.readIntent(receipt.workspaceId);
    if (intent.ownershipToken !== receipt.ownershipToken || intent.baselineCommit !== receipt.baselineCommit) throw new Error("workspace creation intent ownership drifted");
    this.writeIntent({ ...intent, receipt });
  }

  private readIntent(workspaceId: string): WorkspaceCreationIntent {
    const path = this.intentPath(workspaceId);
    if (!entryExists(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || statSync(path).size > 64 * 1024) throw new Error(`bounded workspace creation intent is missing: ${workspaceId}`);
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("workspace creation intent is invalid JSON"); }
    if (!isRecord(value) || value.version !== 1 || value.workspaceId !== workspaceId || typeof value.workspacePath !== "string" || typeof value.ownershipToken !== "string" || typeof value.baselineCommit !== "string" || typeof value.baselineRef !== "string" || typeof value.workspaceHeadCommit !== "string" || !Array.isArray(value.managedPaths) || !Array.isArray(value.changedPaths) || !isRecord(value.before) || !isRecord(value.input)) throw new Error("workspace creation intent is invalid");
    const tempRelative = relative(resolve(tmpdir()), resolve(value.workspacePath));
    if (!tempRelative || tempRelative.includes(sep) || tempRelative === ".." || tempRelative.startsWith(`..${sep}`) || !/^pi-swe-[A-Za-z0-9._-]+$/.test(tempRelative)) throw new Error("workspace creation intent path escapes the recovery root");
    if (!/^[a-f0-9]{40,64}$/.test(value.baselineCommit) || value.baselineRef !== `refs/pi-swe/baselines/${workspaceId}`) throw new Error("workspace creation intent baseline is invalid");
    safeId(value.ownershipToken, "workspace ownership token");
    if (typeof value.input.topic !== "string" || !isValidTopic(value.input.topic) || typeof value.input.taskId !== "string" || !Array.isArray(value.input.writeScope) || !Array.isArray(value.input.includedUntracked) || !Array.isArray(value.input.baselineUntrackedPathHashes) || typeof value.input.createdAt !== "string") throw new Error("workspace creation intent input is invalid");
    if (typeof value.before.head !== "string" || typeof value.before.indexHash !== "string" || typeof value.before.indexTree !== "string" || typeof value.before.stagedPatchHash !== "string" || typeof value.before.unstagedPatchHash !== "string" || typeof value.before.sourceSnapshotHash !== "string") throw new Error("workspace creation intent preflight is invalid");
    const intent = value as unknown as WorkspaceCreationIntent;
    intent.input.writeScope = intent.input.writeScope.map(validateScope);
    intent.input.includedUntracked = intent.input.includedUntracked.map(validatePath);
    intent.input.baselineUntrackedPathHashes = intent.input.baselineUntrackedPathHashes.map((item) => { if (typeof item !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item)) throw new Error("workspace creation intent has an invalid untracked path hash"); return item; });
    if (intent.input.baselineUntrackedPathHashes.length > MAX_BASELINE_UNTRACKED_PATHS) throw new Error("workspace creation intent untracked inventory exceeds bounds");
    intent.managedPaths = intent.managedPaths.map(validatePath);
    intent.changedPaths = intent.changedPaths.map(validatePath);
    if (!/^[a-f0-9]{40,64}$/.test(intent.workspaceHeadCommit) || (intent.integrationBaseCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(intent.integrationBaseCommit))) throw new Error("workspace creation intent HEAD is invalid");
    validTimestamp(intent.input.createdAt, "workspace creation intent timestamp");
    if (intent.receipt !== undefined && !isRecord(intent.receipt)) throw new Error("workspace creation intent receipt is invalid");
    return intent;
  }

  private requiredCommit(value: string, message: string): string {
    const commit = this.optionalText(["rev-parse", "--verify", `${value}^{commit}`]);
    if (!commit) throw new Error(message);
    return commit;
  }
  private refCommit(ref: string): string | null { return this.optionalText(["rev-parse", "--verify", ref]); }
  private acquireRef(ref: string, commit: string): void { this.git(["update-ref", ref, commit, "0".repeat(commit.length)]); }
  private optionalText(args: string[]): string | null { try { return this.gitText(args); } catch { return null; } }
  private gitText(args: string[], options: { input?: Buffer; env?: Record<string, string> } = {}): string { return this.git(args, options).toString("utf8").trim(); }
  private git(args: string[], options: { input?: Buffer; env?: Record<string, string> } = {}): Buffer {
    try {
      return execFileSync("git", args, { cwd: this.root, input: options.input, encoding: "buffer", maxBuffer: Math.max(this.limits.maxPatchBytes * 2, this.limits.maxBytes + 1024, 16 * 1024 * 1024), env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" }, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error ? Buffer.from((error as { stderr?: Buffer }).stderr ?? []).toString("utf8").trim() : "";
      throw new Error(`git ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
  }
  private gitBestEffort(args: string[]): Buffer { try { return execFileSync("git", args, { cwd: this.root, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" }, stdio: ["ignore", "pipe", "ignore"] }); } catch { return Buffer.alloc(0); } }
}

function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function hash(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function decodeUtf8(value: Buffer, label: string): string {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) throw new Error(`${label} is not valid UTF-8`);
  return text;
}
function splitZero(value: Buffer): string[] { const text = decodeUtf8(value, "Git path output"); return text.endsWith("\0") ? text.slice(0, -1).split("\0") : text ? text.split("\0") : []; }
function validTimestamp(value: string, label: string): string { if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`); return value; }
function safeId(value: string, label: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`invalid ${label}`); return value; }
function validatePath(value: string): string {
  if (!value || value !== value.trim() || value.length > MAX_RECEIPT_PATH_LENGTH || isAbsolute(value) || value.includes("\\") || value.split("/").includes("..") || value.includes("\0")) throw new Error(`unsafe repository path: ${value}`);
  return value.replace(/^\.\//, "");
}
function validateScope(value: string): string { if (!value || value !== value.trim() || value.length > MAX_RECEIPT_PATH_LENGTH || isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")) throw new Error(`unsafe write scope: ${value}`); return value; }
function isAuthorityPath(path: string): boolean { return path === ".git" || path.startsWith(".git/") || AUTHORITY_PREFIXES.some((prefix) => path.startsWith(prefix)); }
function escapesRoot(linkPath: string, target: string): boolean {
  const normalized = posix.normalize(posix.join(posix.dirname(linkPath), target));
  return normalized === ".." || normalized.startsWith("../");
}
function entryExists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
function rejectTransforms(output: string[]): void {
  for (let index = 0; index + 2 < output.length; index += 3) {
    const [path, attribute, value] = output.slice(index, index + 3);
    const transformed = attribute === "filter" || attribute === "eol" || attribute === "working-tree-encoding" || attribute === "ident" || (attribute === "text" && value !== "unset");
    if (transformed && value !== "unspecified" && value !== "unset") throw new Error(`Git working-tree transform ${attribute}=${value} is unsupported: ${path}`);
  }
}
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function sameStrings(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
