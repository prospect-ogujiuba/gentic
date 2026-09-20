import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  hasLegacyInitiative,
  loadWorkflow,
  saveWorkflow,
  withWorkflowMutationLock,
  type LocatedWorkflow,
} from "./store.ts";
import { assertWorkflowMigrationEligible } from "./migration.ts";
import { GitWorkspaceManager } from "./workspace.ts";
import { BOOTSTRAP_NATIVE_TAKEOVER_TASK, BOOTSTRAP_PLAN_ANCHOR, hashContract, reduceWorkflow, type BootstrapAdoption, type ParentAuthority, type RepositorySnapshot, type RunLease, type RuntimeHandoff, type Workflow, type WorkflowDecision } from "./workflow.ts";

const MAX_LINKED_PLAN_BYTES = 256 * 1024;
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
export class WorkflowMutationService {
  readonly cwd: string;
  readonly bootstrapInspector: BootstrapRepositoryInspector;

  constructor(cwd: string, bootstrapInspector: BootstrapRepositoryInspector = new GitBootstrapRepositoryInspector(cwd)) { this.cwd = cwd; this.bootstrapInspector = bootstrapInspector; }

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
