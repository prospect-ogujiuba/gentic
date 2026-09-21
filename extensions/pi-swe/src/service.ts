import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import {
  hasLegacyInitiative,
  loadWorkflow,
  saveWorkflow,
  withWorkflowMutationLock,
  type LocatedWorkflow,
} from "./store.ts";
import { assertWorkflowMigrationEligible } from "./migration.ts";
import { GitWorkspaceManager } from "./workspace.ts";
import { BOOTSTRAP_NATIVE_TAKEOVER_TASK, BOOTSTRAP_PLAN_ANCHOR, POST_CUTOVER_ADOPTION_TASK_IDS, POST_CUTOVER_HISTORICAL_HEAD, POST_CUTOVER_HISTORICAL_PATHS, POST_CUTOVER_REPAIR_PATHS, hashContract, reduceWorkflow, retiredV1ExecutionError, type BootstrapAdoption, type ParentAuthority, type PostCutoverAdoption, type RepositorySnapshot, type RunLease, type RuntimeHandoff, type Workflow, type WorkflowDecision } from "./workflow.ts";

const MAX_LINKED_PLAN_BYTES = 256 * 1024;
const MAX_RETAINED_EVIDENCE_BYTES = 1024 * 1024;
export const BOOTSTRAP_ANCHOR_COMMIT = BOOTSTRAP_PLAN_ANCHOR;
export const BOOTSTRAP_TAKEOVER_TASK_ID = BOOTSTRAP_NATIVE_TAKEOVER_TASK;

export interface BootstrapRepositoryInspector {
  inspect(anchorCommit: string): { anchorCommit: string; descendantHead: string; snapshot: RepositorySnapshot };
}

export class GitBootstrapRepositoryInspector implements BootstrapRepositoryInspector {
  readonly cwd: string;
  readonly workspace: GitWorkspaceManager;

  constructor(cwd: string, workspace = new GitWorkspaceManager(cwd)) { this.cwd = cwd; this.workspace = workspace; }

  inspect(anchorCommit: string): { anchorCommit: string; descendantHead: string; snapshot: RepositorySnapshot } {
    const resolvedAnchor = this.git(["rev-parse", "--verify", `${anchorCommit}^{commit}`]).trim();
    if (resolvedAnchor !== anchorCommit) throw new Error("bootstrap plan anchor did not resolve to the authorized commit");
    const descendantHead = this.git(["rev-parse", "HEAD"]).trim();
    try { execFileSync("git", ["merge-base", "--is-ancestor", anchorCommit, descendantHead], { cwd: this.cwd, stdio: "ignore" }); }
    catch { throw new Error("bootstrap HEAD is not a descendant of the authorized rollout-plan anchor"); }
    const descendantCount = Number(this.git(["rev-list", "--count", `${anchorCommit}..${descendantHead}`]).trim());
    if (!Number.isSafeInteger(descendantCount) || descendantCount > 256) throw new Error("bootstrap descendant history exceeds the bounded adoption window");
    this.git(["diff", "--binary", "--full-index", anchorCommit, "--"], 512 * 1024);
    const tracked = this.git(["diff", "--name-only", "-z", anchorCommit, "--"], 256 * 1024).split("\0").filter(Boolean);
    const status = this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], 256 * 1024).split("\0").filter(Boolean);
    const untracked = status.filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3));
    const changedPaths = [...new Set([...tracked, ...untracked].filter((path) => !path.startsWith(".model-artifacts/")))].sort();
    if (changedPaths.length > 2_000) throw new Error("bootstrap descendant path inventory exceeds repository bounds");
    const preflight = this.workspace.preflight(untracked.filter((path) => !path.startsWith(".model-artifacts/")));
    return { anchorCommit, descendantHead, snapshot: { hash: preflight.sourceSnapshotHash, head: descendantHead, branch: preflight.branch, changedPaths, capturedAt: new Date().toISOString() } };
  }

  private git(args: string[], maxBuffer = 128 * 1024): string { return execFileSync("git", args, { cwd: this.cwd, encoding: "utf8", maxBuffer }); }
}

export type BootstrapAdoptionRequest = Omit<BootstrapAdoption, "anchorCommit" | "descendantHead" | "snapshot" | "taskIds" | "adoptedAt">;
export type PostCutoverAdoptionRequest = Omit<PostCutoverAdoption, "adoptedAt">;
export type PostCutoverInspection = { anchorCommit: string; historicalHead: string; historicalTree: string; historicalChangedPaths: string[]; repairBase: string; repairChangedPaths: string[]; descendantHead: string; candidateTree: string; snapshot: RepositorySnapshot };

export interface PostCutoverRepositoryInspector { inspect(anchorCommit: string): PostCutoverInspection; }

export function unauthorizedPostCutoverRepairPaths(paths: readonly string[]): string[] {
  const allowed = new Set<string>(POST_CUTOVER_REPAIR_PATHS);
  return [...new Set(paths.filter((path) => !allowed.has(path)))].sort();
}

export class GitPostCutoverRepositoryInspector implements PostCutoverRepositoryInspector {
  readonly cwd: string;
  constructor(cwd: string) { this.cwd = cwd; }
  inspect(anchorCommit: string): PostCutoverInspection {
    const git = (args: string[], maxBuffer = 512 * 1024) => execFileSync("git", args, { cwd: this.cwd, encoding: "utf8", maxBuffer, timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }).trimEnd();
    const resolvedAnchor = git(["rev-parse", "--verify", `${anchorCommit}^{commit}`]);
    if (resolvedAnchor !== anchorCommit) throw new Error("post-cutover anchor did not resolve to the authorized commit");
    const historicalHead = git(["rev-parse", "--verify", `${POST_CUTOVER_HISTORICAL_HEAD}^{commit}`]);
    if (historicalHead !== POST_CUTOVER_HISTORICAL_HEAD) throw new Error("post-cutover historical Session 9 candidate is unavailable");
    const descendantHead = git(["rev-parse", "HEAD"]);
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", anchorCommit, historicalHead], { cwd: this.cwd, stdio: "ignore", timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
      execFileSync("git", ["merge-base", "--is-ancestor", historicalHead, descendantHead], { cwd: this.cwd, stdio: "ignore", timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
    } catch { throw new Error("post-cutover repair HEAD does not descend from the exact historical Session 9 candidate"); }
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], 256 * 1024).split("\0").filter(Boolean);
    const authorityPath = ".model-artifacts/initiatives/swe-production-rollout/workflow.json";
    if (status.length !== 1 || status[0] !== ` M ${authorityPath}`) throw new Error("post-cutover control checkout must contain only the exact unstaged workflow authority modification");
    const historicalTree = git(["rev-parse", `${historicalHead}^{tree}`]);
    const candidateTree = git(["rev-parse", `${descendantHead}^{tree}`]);
    const historicalChangedPaths = git(["diff", "--name-only", "-z", anchorCommit, historicalHead, "--"], 512 * 1024).split("\0").filter((path) => path && !path.startsWith(".model-artifacts/")).sort();
    const repairChangedPaths = git(["diff", "--name-only", "-z", historicalHead, descendantHead, "--"], 512 * 1024).split("\0").filter((path) => path && !path.startsWith(".model-artifacts/")).sort();
    if (JSON.stringify(historicalChangedPaths) !== JSON.stringify([...POST_CUTOVER_HISTORICAL_PATHS])) throw new Error("post-cutover historical range does not match the exact Session 1-9 path manifest");
    const unauthorizedRepairPaths = unauthorizedPostCutoverRepairPaths(repairChangedPaths);
    if (unauthorizedRepairPaths.length) throw new Error(`post-cutover repair range contains ${unauthorizedRepairPaths.length} path(s) outside the authorized authority-repair scope: ${unauthorizedRepairPaths.join(", ")}`);
    const changedPaths = [...new Set([...historicalChangedPaths, ...repairChangedPaths])].sort();
    if (changedPaths.length > 128) throw new Error("post-cutover changed-path inventory exceeds the 128-path review bound");
    const branch = git(["branch", "--show-current"]) || null;
    const capturedAt = new Date().toISOString();
    const hash = hashContract({ anchorCommit, historicalHead, historicalTree, historicalChangedPaths, repairBase: historicalHead, repairChangedPaths, descendantHead, candidateTree, changedPaths });
    return { anchorCommit, historicalHead, historicalTree, historicalChangedPaths, repairBase: historicalHead, repairChangedPaths, descendantHead, candidateTree, snapshot: { hash, head: descendantHead, branch, changedPaths, capturedAt } };
  }
}

export type RunClaim = {
  ownerId: string;
  runId: string;
  stage: RunLease["stage"];
  taskId?: string;
  ttlMs: number;
  now?: string;
};

/**
 * Sole mutation boundary for command and tool adapters. The filesystem lock is
 * intentionally held only while loading, reducing, and atomically persisting.
 * Child work in runWithLease executes after the lock is released.
 */
export function assertV2ExecutionRuntime(runtimeKind: "compatibility" | "v2" | "blocked", action: string): void {
  if (runtimeKind === "compatibility") throw retiredV1ExecutionError(action);
}

export class WorkflowMutationService {
  readonly cwd: string;
  readonly bootstrapInspector: BootstrapRepositoryInspector;
  readonly postCutoverInspector: PostCutoverRepositoryInspector;
  private postCutoverPreparation?: PostCutoverInspection;

  constructor(cwd: string, bootstrapInspector: BootstrapRepositoryInspector = new GitBootstrapRepositoryInspector(cwd), postCutoverInspector: PostCutoverRepositoryInspector = new GitPostCutoverRepositoryInspector(cwd)) { this.cwd = cwd; this.bootstrapInspector = bootstrapInspector; this.postCutoverInspector = postCutoverInspector; }

  read(topic: string, includeLegacy = true): LocatedWorkflow | undefined {
    return loadWorkflow(this.cwd, topic, includeLegacy);
  }

  linkedPlanContent(plan: string | undefined): string | undefined {
    if (!plan || plan.startsWith("/") || plan.includes("\\") || plan.split("/").includes("..")) return undefined;
    const path = resolve(this.cwd, plan);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return undefined;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_LINKED_PLAN_BYTES) return undefined;
    return readFileSync(path, "utf8");
  }

  async create(workflow: Workflow): Promise<string> {
    return this.withLock(workflow.topic, async () => {
      if (loadWorkflow(this.cwd, workflow.topic, false)) throw new Error(`workflow ${workflow.topic} already exists`);
      if (hasLegacyInitiative(this.cwd, workflow.topic)) throw new Error(`legacy initiative ${workflow.topic} already exists; migrate it instead of creating a shadow workflow`);
      return saveWorkflow(this.cwd, workflow);
    });
  }

  async migrate(topic: string): Promise<LocatedWorkflow> {
    throw new Error(`workflow ${topic} requires the explicit migration audit, plan, and apply surface`);
  }

  async mutate(topic: string, expectedRevision: number, reducer: (workflow: Workflow) => WorkflowDecision, options: { allowPlanDrift?: boolean } = {}): Promise<WorkflowDecision> {
    return withWorkflowMutationLock(this.cwd, topic, async () => {
      assertWorkflowMigrationEligible(this.cwd, topic);
      const located = loadWorkflow(this.cwd, topic, false);
      if (!located) throw new Error(`workflow ${topic} was not found`);
      if (located.workflow.revision !== expectedRevision) throw new Error(`workflow changed: expected revision ${expectedRevision}, found ${located.workflow.revision}`);
      if (!options.allowPlanDrift && located.workflow.plan && located.workflow.contract.linkedPlanHash) {
        const content = this.linkedPlanContent(located.workflow.plan);
        if (content === undefined || hashContract(content) !== located.workflow.contract.linkedPlanHash) throw new Error("linked plan content changed or is unavailable; revise the workflow before mutation");
      }
      const decision = reducer(located.workflow);
      if (decision.workflow.topic !== topic) throw new Error("workflow reducer cannot change topic identity");
      if (located.workflow.orchestration.runtimeHandoff && !decision.workflow.orchestration.runtimeHandoff) throw new Error("workflow mutation cannot discard retained runtime handoff authority");
      if (decision.changed && decision.workflow.revision !== located.workflow.revision + 1) throw new Error("workflow reducer must advance mutation revision exactly once");
      if (!decision.changed && decision.workflow !== located.workflow) throw new Error("unchanged workflow decision must preserve state identity");
      if (decision.changed) {
        saveWorkflow(this.cwd, decision.workflow, located.workflow.revision);
        return decision;
      }
      return decision;
    });
  }

  async adoptBootstrap(topic: string, expectedRevision: number, request: BootstrapAdoptionRequest, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => {
      const takeoverIndex = workflow.tasks.findIndex((task) => task.id === BOOTSTRAP_TAKEOVER_TASK_ID);
      if (takeoverIndex < 1) throw new Error(`bootstrap workflow is missing ordered takeover task ${BOOTSTRAP_TAKEOVER_TASK_ID}`);
      const inspection = this.bootstrapInspector.inspect(BOOTSTRAP_ANCHOR_COMMIT);
      if (inspection.anchorCommit !== BOOTSTRAP_ANCHOR_COMMIT) throw new Error("bootstrap inspector changed the authorized rollout-plan anchor");
      return reduceWorkflow(workflow, { type: "adopt-bootstrap", adoption: { ...request, ...inspection, taskIds: workflow.tasks.slice(0, takeoverIndex).map((task) => task.id) } }, now);
    });
  }

  inspectPostCutoverCandidate(): PostCutoverInspection {
    const inspection = this.postCutoverInspector.inspect(BOOTSTRAP_PLAN_ANCHOR);
    this.postCutoverPreparation = structuredClone(inspection);
    return inspection;
  }

  async adoptPostCutover(topic: string, expectedRevision: number, request: PostCutoverAdoptionRequest, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => {
      const prepared = this.postCutoverPreparation;
      this.postCutoverPreparation = undefined;
      if (!prepared || request.anchorCommit !== prepared.anchorCommit || request.historicalHead !== prepared.historicalHead || request.historicalTree !== prepared.historicalTree || JSON.stringify(request.historicalChangedPaths) !== JSON.stringify(prepared.historicalChangedPaths) || request.repairBase !== prepared.repairBase || JSON.stringify(request.repairChangedPaths) !== JSON.stringify(prepared.repairChangedPaths) || request.descendantHead !== prepared.descendantHead || request.candidateTree !== prepared.candidateTree || JSON.stringify(request.snapshot) !== JSON.stringify(prepared.snapshot)) throw new Error("post-cutover evidence does not match the one-shot prepared inspection");
      const inspection = this.postCutoverInspector.inspect(BOOTSTRAP_PLAN_ANCHOR);
      if (request.anchorCommit !== inspection.anchorCommit || request.historicalHead !== inspection.historicalHead || request.historicalTree !== inspection.historicalTree || JSON.stringify(request.historicalChangedPaths) !== JSON.stringify(inspection.historicalChangedPaths) || request.repairBase !== inspection.repairBase || JSON.stringify(request.repairChangedPaths) !== JSON.stringify(inspection.repairChangedPaths) || request.descendantHead !== inspection.descendantHead || request.candidateTree !== inspection.candidateTree || request.snapshot.hash !== inspection.snapshot.hash || request.snapshot.head !== inspection.snapshot.head || request.snapshot.branch !== inspection.snapshot.branch || JSON.stringify(request.snapshot.changedPaths) !== JSON.stringify(inspection.snapshot.changedPaths)) throw new Error("post-cutover candidate source changed after evidence preparation");
      for (const retained of request.retainedEvidence) {
        const path = safeRetainedEvidencePath(this.cwd, retained.path);
        const digest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
        if (digest !== retained.sha256) throw new Error(`retained post-cutover evidence hash changed: ${retained.path}`);
        try { execFileSync("git", ["cat-file", "-e", `${retained.commit}^{commit}`], { cwd: this.cwd, stdio: "ignore", timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }); }
        catch { throw new Error(`retained post-cutover evidence commit is unavailable: ${retained.commit}`); }
      }
      return reduceWorkflow(workflow, { type: "adopt-post-cutover", adoption: request }, now);
    });
  }

  async prepareRuntimeHandoff(topic: string, expectedRevision: number, handoff: Omit<RuntimeHandoff, "phase" | "preparedAt" | "reclaimedAt" | "previousParent">, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "prepare-runtime-handoff", handoff }, now));
  }

  async reclaimRuntimeHandoff(topic: string, expectedRevision: number, input: { handoffId: string; decisionId: string; selectorGeneration: number; authority: ParentAuthority }, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "reclaim-runtime-handoff", ...input }, now));
  }

  async rotateRuntimeParent(topic: string, expectedRevision: number, input: { handoffId: string; decisionId: string; from: "compatibility" | "v2"; to: "compatibility" | "v2"; selectorGeneration: number; authority: ParentAuthority }, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "rotate-runtime-parent", ...input }, now));
  }

  async fenceParent(topic: string, expectedRevision: number, parent: Pick<ParentAuthority, "ownerId" | "sessionId" | "runtimeId">, reason: string, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "fence-parent", ...parent, reason }, now));
  }

  async claimRun(topic: string, expectedRevision: number, claim: RunClaim): Promise<{ workflow: Workflow; lease: RunLease }> {
    if (!claim.ownerId.trim() || !claim.runId.trim()) throw new Error("run owner and run id are required");
    if (!Number.isSafeInteger(claim.ttlMs) || claim.ttlMs < 1_000 || claim.ttlMs > 24 * 60 * 60 * 1_000) throw new Error("run lease ttl must be between 1 second and 24 hours");
    const located = this.read(topic);
    if (!located) throw new Error(`workflow ${topic} was not found`);
    if (located.workflow.revision !== expectedRevision) throw new Error(`workflow changed: expected revision ${expectedRevision}, found ${located.workflow.revision}`);
    const now = claim.now ?? new Date().toISOString();
    const lease: RunLease = {
      id: randomUUID(),
      runId: claim.runId.trim(),
      ownerId: claim.ownerId.trim(),
      stage: claim.stage,
      ...(claim.taskId ? { taskId: claim.taskId } : {}),
      fence: located.workflow.orchestration.nextFence,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + claim.ttlMs).toISOString(),
    };
    const decision = await this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "claim-run", lease }, now));
    return { workflow: decision.workflow, lease };
  }

  async cancelRun(topic: string, expectedRevision: number, lease: RunLease, reason: string, now = new Date().toISOString()): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => reduceWorkflow(workflow, { type: "cancel-run", lease, reason }, now));
  }

  async settleRun(topic: string, expectedRevision: number, lease: RunLease, reducer: (workflow: Workflow) => WorkflowDecision): Promise<WorkflowDecision> {
    return this.mutate(topic, expectedRevision, (workflow) => {
      const active = workflow.orchestration.activeRun;
      if (!active || active.id !== lease.id || active.runId !== lease.runId || active.fence !== lease.fence || active.ownerId !== lease.ownerId) {
        throw new Error("stale run lease or fence cannot settle child completion");
      }
      const decision = reducer(workflow);
      if (!decision.changed) return decision;
      return {
        ...decision,
        workflow: {
          ...decision.workflow,
          orchestration: { ...decision.workflow.orchestration, activeRun: undefined },
        },
      };
    });
  }

  async runWithLease<T>(
    topic: string,
    expectedRevision: number,
    claim: RunClaim,
    child: (lease: RunLease) => Promise<T>,
    settle: (workflow: Workflow, result: T, lease: RunLease) => WorkflowDecision,
  ): Promise<WorkflowDecision> {
    const claimed = await this.claimRun(topic, expectedRevision, claim);
    // No filesystem lock is held while awaiting the child. Pause/cancel remains available.
    const result = await child(claimed.lease);
    return this.settleRun(topic, claimed.workflow.revision, claimed.lease, (workflow) => settle(workflow, result, claimed.lease));
  }

  private async withLock<T>(topic: string, operation: () => Promise<T> | T): Promise<T> {
    return withWorkflowMutationLock(this.cwd, topic, operation);
  }
}

function safeRetainedEvidencePath(cwd: string, retainedPath: string): string {
  const root = realpathSync(resolve(cwd));
  const candidate = resolve(root, retainedPath);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`retained post-cutover evidence is outside the repository: ${retainedPath}`);
  let cursor = candidate;
  while (cursor !== root) {
    if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) throw new Error(`retained post-cutover evidence has a missing or symlinked ancestor: ${retainedPath}`);
    cursor = dirname(cursor);
  }
  const real = realpathSync(candidate);
  const realRel = relative(root, real);
  const stat = statSync(real);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || !stat.isFile() || stat.size > MAX_RETAINED_EVIDENCE_BYTES || (stat.mode & 0o022) !== 0) throw new Error(`retained post-cutover evidence is missing, unsafe, writable, or oversized: ${retainedPath}`);
  return real;
}
