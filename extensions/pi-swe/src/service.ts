import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
  hasLegacyInitiative,
  loadWorkflow,
  migrateLegacyWorkflow,
  saveWorkflow,
  workflowPath,
  type LocatedWorkflow,
} from "./store.ts";
import { hashContract, reduceWorkflow, type RunLease, type Workflow, type WorkflowDecision } from "./workflow.ts";

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const MAX_LINKED_PLAN_BYTES = 256 * 1024;

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

  constructor(cwd: string) { this.cwd = cwd; }

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
    return this.withLock(topic, async () => {
      const located = loadWorkflow(this.cwd, topic, true);
      if (!located) throw new Error(`workflow ${topic} was not found`);
      if (located.kind === "legacy") return migrateLegacyWorkflow(this.cwd, topic);
      if (located.storedVersion === 2) return located;
      const upgraded = { ...located.workflow, revision: located.workflow.revision + 1, updatedAt: new Date().toISOString() };
      saveWorkflow(this.cwd, upgraded, located.workflow.revision);
      return { kind: "native", path: workflowPath(topic), workflow: upgraded, storedVersion: 2 };
    });
  }

  async mutate(topic: string, expectedRevision: number, reducer: (workflow: Workflow) => WorkflowDecision, options: { allowPlanDrift?: boolean } = {}): Promise<WorkflowDecision> {
    return this.withLock(topic, async () => {
      const located = loadWorkflow(this.cwd, topic, true);
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
      if (located.kind === "legacy") {
        const migrated = migrateLegacyWorkflow(this.cwd, topic);
        return { workflow: migrated.workflow, changed: true, message: `${decision.message}; imported legacy state` };
      }
      if (located.storedVersion === 1) {
        const upgraded = { ...located.workflow, revision: located.workflow.revision + 1, updatedAt: new Date().toISOString() };
        saveWorkflow(this.cwd, upgraded, located.workflow.revision);
        return { workflow: upgraded, changed: true, message: `${decision.message}; upgraded workflow schema to v2` };
      }
      return decision;
    });
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
    const target = resolve(this.cwd, workflowPath(topic));
    return withFileMutationQueue(target, async () => {
      const lockPath = resolve(this.cwd, ".model-artifacts/system/logs/pi-swe-mutation.lock");
      mkdirSync(dirname(lockPath), { recursive: true });
      const started = Date.now();
      const lockToken = randomUUID();
      let descriptor: number | undefined;
      while (descriptor === undefined) {
        try {
          descriptor = openSync(lockPath, "wx", 0o600);
          writeFileSync(descriptor, JSON.stringify({ token: lockToken, pid: process.pid, acquiredAt: new Date().toISOString() }), "utf8");
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          if (isStaleLock(lockPath)) {
            try { rmSync(lockPath); } catch { /* another process recovered it */ }
            continue;
          }
          if (Date.now() - started >= LOCK_WAIT_MS) throw new Error("workflow mutation lock timed out");
          await delay(LOCK_RETRY_MS);
        }
      }
      try {
        return await operation();
      } finally {
        try { closeSync(descriptor); } finally {
          try {
            const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
            if (owner.token === lockToken) rmSync(lockPath);
          } catch { /* lock may have been recovered */ }
        }
      }
    });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST";
}
function isStaleLock(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
