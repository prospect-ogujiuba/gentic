import { createHash, randomUUID } from "node:crypto";

import { renderVerificationCommand, type ParentExecutionIdentity } from "./integrity.ts";
import type { RepositorySnapshot, VerificationCommand, VerificationEvidence, Workflow } from "./workflow.ts";

export type InitiativeInspection = {
  snapshot: RepositorySnapshot;
  cumulativeDelta: string;
  unresolvedRisks: string[];
};

export interface InitiativeCloseoutInspector {
  inspect(workflow: Workflow): InitiativeInspection;
  /** Coordinate pi-swe repository mutations through completion persistence; this is not an OS sandbox. */
  acquireFence?(workflow: Workflow): () => void;
}

export type InitiativeVerificationAuthorization = {
  id: string;
  topic: string;
  workflowRevision: number;
  contractHash: string;
  snapshot: RepositorySnapshot;
  command: VerificationCommand;
  commandLine: string;
  toolCallId: string;
  cwd: string;
  parent: ParentExecutionIdentity;
  authorizedAt: string;
};

export type InitiativeVerificationSubmission = {
  authorizationId: string;
  topic: string;
  workflowRevision: number;
  evidence: VerificationEvidence;
  observedSnapshot: RepositorySnapshot;
};

/** One-shot, in-memory protected-bash authority for final initiative checks. Reloading invalidates every grant. */
export class InitiativeCloseoutAuthority {
  readonly cwd: string;
  readonly inspector: InitiativeCloseoutInspector;
  readonly options: { now?: () => string; id?: () => string };
  private readonly authorizations = new Map<string, InitiativeVerificationAuthorization>();
  private readonly submissions = new Map<string, string>();

  constructor(cwd: string, inspector: InitiativeCloseoutInspector, options: { now?: () => string; id?: () => string } = {}) {
    this.cwd = cwd;
    this.inspector = inspector;
    this.options = options;
  }

  authorize(input: { workflow: Workflow; commandLine: string; toolName: string; toolCallId: string; parent: ParentExecutionIdentity }): InitiativeVerificationAuthorization {
    const closeout = requireCloseout(input.workflow);
    assertParent(input.workflow, input.parent, this.cwd);
    if (input.toolName !== "bash" || !input.toolCallId.trim()) throw new Error("final verification requires exact protected-bash tool-call provenance");
    if (this.authorizations.size) throw new Error("another final verification command is already authorized");
    const command = input.workflow.initiativeVerification.find((item) => renderVerificationCommand(item) === input.commandLine);
    if (!command) throw new Error("command is not an exact planned initiative integration check");
    if (!/^[A-Za-z0-9_./:@%+=,-]+$/.test(command.command)) throw new Error("final verification requires one shell-safe executable and separate exact args; revise the plan contract");
    const observed = this.inspector.inspect(input.workflow).snapshot;
    assertSnapshot(closeout.snapshot, observed, "before final verification");
    assertCheckpoint(closeout, input.parent);
    const authorization: InitiativeVerificationAuthorization = {
      id: this.options.id?.() ?? `initiative-verification-${randomUUID()}`,
      topic: input.workflow.topic,
      workflowRevision: input.workflow.revision,
      contractHash: input.workflow.contract.hash,
      snapshot: structuredClone(closeout.snapshot), command: structuredClone(command), commandLine: input.commandLine,
      toolCallId: input.toolCallId, cwd: this.cwd, parent: structuredClone(input.parent), authorizedAt: this.now(),
    };
    if (!authorization.id || this.authorizations.has(authorization.id) || this.submissions.has(authorization.id)) throw new Error("final verification authorization id is empty or reused");
    this.authorizations.set(authorization.id, authorization);
    return structuredClone(authorization);
  }

  finish(input: { authorizationId: string; workflow: Workflow; toolCallId: string; exitCode: number; parent: ParentExecutionIdentity }): InitiativeVerificationSubmission {
    const authorization = this.authorizations.get(input.authorizationId);
    if (!authorization) throw new Error("final verification authorization is forged, stale, consumed, or lost on reload");
    const closeout = requireCloseout(input.workflow);
    assertParent(input.workflow, input.parent, this.cwd);
    assertCheckpoint(closeout, input.parent);
    if (!sameParent(input.parent, authorization.parent) || input.toolCallId !== authorization.toolCallId) throw new Error("final verification parent, session branch, or tool-call provenance changed");
    if (input.workflow.topic !== authorization.topic || input.workflow.revision !== authorization.workflowRevision || input.workflow.contract.hash !== authorization.contractHash) throw new Error("final verification authorization is stale for the workflow contract or revision");
    if (!Number.isSafeInteger(input.exitCode)) throw new Error("final verification exit code is invalid");
    const observedSnapshot = this.inspector.inspect(input.workflow).snapshot;
    const at = this.now();
    const evidence: VerificationEvidence = {
      ...authorization.command, exitCode: input.exitCode, at, contractHash: authorization.contractHash,
      snapshotHash: authorization.snapshot.hash, beforeSnapshotHash: authorization.snapshot.hash, afterSnapshotHash: observedSnapshot.hash,
      cwd: authorization.cwd, head: observedSnapshot.head, branch: observedSnapshot.branch,
      source: {
        kind: "bash-tool-result", toolName: "bash", toolCallId: authorization.toolCallId,
        workflowRevision: closeout.checkpoint.revision, ownerId: input.parent.ownerId, sessionId: input.parent.sessionId,
        runtimeId: input.parent.runtimeId, ...(input.parent.sessionFile ? { sessionFile: input.parent.sessionFile } : {}),
        ...(input.parent.sessionBranchId ? { sessionBranchId: input.parent.sessionBranchId } : {}), branchLength: input.parent.branchLength,
      },
    };
    const submission = { authorizationId: authorization.id, topic: authorization.topic, workflowRevision: authorization.workflowRevision, evidence, observedSnapshot };
    this.authorizations.delete(authorization.id);
    this.submissions.set(authorization.id, digest(submission));
    return structuredClone(submission);
  }

  consume(submission: InitiativeVerificationSubmission, workflow: Workflow, parent: ParentExecutionIdentity): InitiativeVerificationSubmission {
    const expected = this.submissions.get(submission.authorizationId);
    if (!expected || expected !== digest(submission)) throw new Error("final verification submission is forged, stale, or already consumed");
    const closeout = requireCloseout(workflow);
    assertParent(workflow, parent, this.cwd);
    assertCheckpoint(closeout, parent);
    if (submission.topic !== workflow.topic || submission.workflowRevision !== workflow.revision) throw new Error("final verification submission is stale for the current workflow revision");
    assertSnapshot(closeout.snapshot, submission.observedSnapshot, "after final verification");
    this.submissions.delete(submission.authorizationId);
    return structuredClone(submission);
  }

  acquireCompletionFence(workflow: Workflow, parent: ParentExecutionIdentity): () => void {
    assertParent(workflow, parent, this.cwd);
    if (!this.inspector.acquireFence) throw new Error("completion requires a repository mutation fence; workflow integrity is not an OS sandbox");
    const release = this.inspector.acquireFence(workflow);
    try { this.assertCompletion(workflow, parent); }
    catch (error) { release(); throw error; }
    return release;
  }

  assertCompletion(workflow: Workflow, parent: ParentExecutionIdentity): RepositorySnapshot {
    const closeout = requireCloseout(workflow);
    assertParent(workflow, parent, this.cwd);
    assertCheckpoint(closeout, parent);
    const observed = this.inspector.inspect(workflow).snapshot;
    assertSnapshot(closeout.snapshot, observed, "at completion");
    for (const planned of workflow.initiativeVerification) {
      const latest = closeout.evidence.filter((item) => sameCommand(item, planned)).at(-1);
      if (!latest || latest.exitCode !== 0) throw new Error(`missing current passing final integration check: ${renderVerificationCommand(planned)}`);
      if (latest.contractHash !== workflow.contract.hash || latest.snapshotHash !== observed.hash || latest.beforeSnapshotHash !== observed.hash || latest.afterSnapshotHash !== observed.hash || latest.head !== observed.head || latest.branch !== observed.branch || latest.cwd !== this.cwd) throw new Error("final verification evidence is stale at completion");
      if (latest.source?.toolName !== "bash" || latest.source.ownerId !== parent.ownerId || latest.source.sessionId !== parent.sessionId || latest.source.runtimeId !== parent.runtimeId || latest.source.branchLength === undefined || latest.source.branchLength > parent.branchLength) throw new Error("completion requires current protected-bash parent/session/branch provenance");
      if (parent.branchToolCallIds && !parent.branchToolCallIds.includes(latest.source.toolCallId)) throw new Error("final verification evidence is no longer on the active session branch");
    }
    return observed;
  }

  invalidate(): void { this.authorizations.clear(); this.submissions.clear(); }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}

function requireCloseout(workflow: Workflow) {
  if (!["initiative-acceptance", "complete"].includes(workflow.orchestration.phase) || !workflow.closeout) throw new Error("initiative closeout checkpoint is unavailable");
  return workflow.closeout;
}
function assertParent(workflow: Workflow, parent: ParentExecutionIdentity, cwd: string): void {
  const authority = workflow.orchestration.parent;
  if (!authority?.valid || authority.ownerId !== parent.ownerId || authority.sessionId !== parent.sessionId || authority.runtimeId !== parent.runtimeId || authority.cwd !== cwd || parent.cwd !== cwd) throw new Error("final verification parent ownership, session, runtime, or cwd is stale");
}
function assertCheckpoint(closeout: NonNullable<Workflow["closeout"]>, parent: ParentExecutionIdentity): void {
  const checkpoint = closeout.checkpoint;
  if (checkpoint.ownerId !== parent.ownerId || checkpoint.sessionId !== parent.sessionId || checkpoint.runtimeId !== parent.runtimeId || parent.branchLength < checkpoint.branchLength) throw new Error("final verification does not match the closeout parent/session/branch checkpoint");
}
function assertSnapshot(expected: RepositorySnapshot, observed: RepositorySnapshot, stage: string): void {
  if (expected.hash !== observed.hash || expected.head !== observed.head || expected.branch !== observed.branch || !sameStrings(expected.changedPaths, observed.changedPaths)) throw new Error(`final repository snapshot changed ${stage}`);
}
function sameParent(left: ParentExecutionIdentity, right: ParentExecutionIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runtimeId === right.runtimeId && left.cwd === right.cwd && left.sessionFile === right.sessionFile && left.sessionBranchId === right.sessionBranchId && left.branchLength === right.branchLength;
}
function sameCommand(left: VerificationCommand, right: VerificationCommand): boolean { return left.command === right.command && left.args.length === right.args.length && left.args.every((arg, index) => arg === right.args[index]); }
function sameStrings(left: string[], right: string[]): boolean { return left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
