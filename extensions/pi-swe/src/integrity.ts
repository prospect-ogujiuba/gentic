import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readRuntimeSelection } from "./cutover.ts";
import { listWorkflowTopics, loadWorkflow } from "./store.ts";
import { WorkflowMutationService } from "./service.ts";
import { reduceWorkflow, type VerificationCommand, type VerificationEvidence, type Workflow, type WorkflowTask } from "./workflow.ts";
import { GitWorkspaceManager, type GitIntegrationReceipt, type GitWorkspaceReceipt } from "./workspace.ts";

const MAX_REVOKED_TOOL_CALLS = 1_024;
const APPROVED_READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "code_search",
  "ctx_search", "ctx_stats", "ctx_doctor", "context_mode_ctx_search", "context_mode_ctx_stats", "context_mode_ctx_doctor",
  "web_search", "source_check", "fetch_content", "get_search_content",
]);
const APPROVED_COORDINATION_TOOLS = new Set(["intercom"]);
const APPROVED_COORDINATION_ACTIONS = new Set(["list", "status", "pending", "reply"]);

export type ManagedToolPhase = "plan-review" | "implementation" | "general-review" | "concern-review" | "workspace" | "integration" | "verification" | "ready-to-complete" | "initiative-acceptance" | "complete" | "pending" | "remediation" | "historical";
export type ManagedToolDecision = { allow: boolean; reason?: string; plannedCommand?: VerificationCommand };

export function renderVerificationCommand(command: VerificationCommand): string {
  if (!command.command.trim() || /[\n\r\0]/.test(command.command)) throw new Error("verification command contains an unsafe executable");
  return [command.command.trim(), ...command.args.map(shellWord)].join(" ");
}

export function decideManagedToolCall(input: {
  managed: boolean;
  phase: ManagedToolPhase;
  planned: VerificationCommand[];
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  expectedCwd: string;
  trustedTool?: boolean;
}): ManagedToolDecision {
  if (!input.managed) return { allow: true };
  if (input.trustedTool === false) return { allow: false, reason: `managed execution denies replaced or untrusted tool ${input.toolName}` };
  if (APPROVED_READ_ONLY_TOOLS.has(input.toolName)) return { allow: true };
  if (APPROVED_COORDINATION_TOOLS.has(input.toolName)) {
    const action = String(input.input.action ?? "");
    if (!APPROVED_COORDINATION_ACTIONS.has(action)) return { allow: false, reason: `managed execution denies unsupported coordination action ${action}` };
    if (action === "reply" && (input.input.to !== undefined || input.input.replyTo !== undefined || input.input.cwd !== undefined || input.input.attachments !== undefined || input.input.openProjectPaneIfMissing !== undefined)) return { allow: false, reason: "managed execution permits replies only to the active inbound coordination thread without routing, attachments, or pane creation" };
    return { allow: true };
  }
  if (input.toolName === "swe_workflow") {
    return input.input.action === "status" ? { allow: true } : { allow: false, reason: "managed execution permits only read-only workflow inspection; orchestration mutations must use the fenced engine" };
  }
  if (input.toolName === "todo") return input.input.action === "list" ? { allow: true } : { allow: false, reason: "managed execution denies parent todo mutations" };
  if (input.toolName !== "bash") return { allow: false, reason: `managed execution denies unapproved tool ${input.toolName}; unknown and execution-capable tools fail closed` };
  if (input.phase !== "verification") return { allow: false, reason: "protected bash is available only during an authorized verification phase" };
  if (input.cwd !== input.expectedCwd || (typeof input.input.cwd === "string" && input.input.cwd !== input.expectedCwd)) return { allow: false, reason: "verification cwd does not match the managed repository checkpoint" };
  if (typeof input.input.command !== "string") return { allow: false, reason: "protected bash requires an exact command string" };
  const plannedCommand = input.planned.find((command) => renderVerificationCommand(command) === input.input.command);
  if (!plannedCommand) return { allow: false, reason: "bash command is not an exact planned verification command" };
  return { allow: true, plannedCommand };
}

export type ParentExecutionIdentity = {
  ownerId: string;
  sessionId: string;
  runtimeId: string;
  cwd: string;
  sessionFile?: string;
  sessionBranchId?: string;
  branchLength: number;
  branchToolCallIds?: string[];
};

export type RelevantSourceSnapshot = {
  hash: string;
  head: string;
  branch: string | null;
  changedPaths: string[];
};

export interface RelevantSourceInspector {
  inspect(workflow: Workflow, task: WorkflowTask): RelevantSourceSnapshot;
}

export class GitRelevantSourceInspector implements RelevantSourceInspector {
  readonly workspace: GitWorkspaceManager;
  constructor(cwd: string, workspace = new GitWorkspaceManager(cwd)) { this.workspace = workspace; }
  inspect(_workflow: Workflow, task: WorkflowTask): RelevantSourceSnapshot {
    if (!task.workspaceReceipt) throw new Error("verification source inspection requires a prepared workspace receipt");
    const receipt = task.workspaceReceipt as GitWorkspaceReceipt;
    const integration = task.integrationReceipt as GitIntegrationReceipt | undefined;
    const source = integration ?? {
      version: 1 as const, integrationId: "no-change-verification", workspaceId: receipt.workspaceId,
      preSnapshotHash: receipt.baselineHash, postSnapshotHash: receipt.snapshotHash, patchHash: receipt.preparedPatchHash!, integratedAt: receipt.createdAt,
      resultCommit: receipt.preparedResultCommit!, resultRef: receipt.preparedResultRef!, observedHead: receipt.realHead, observedBranch: receipt.realBranch,
      observedIndexHash: receipt.realIndexHash, changedPaths: receipt.changedPaths,
    };
    return this.workspace.inspectVerificationSource(receipt, source);
  }
}

export type VerificationAuthorization = {
  id: string;
  topic: string;
  taskId: string;
  workflowRevision: number;
  contractHash: string;
  expectedSnapshotHash: string;
  command: VerificationCommand;
  commandLine: string;
  cwd: string;
  toolName: "bash";
  toolCallId: string;
  parent: ParentExecutionIdentity;
  sourceBefore: RelevantSourceSnapshot;
  authorizedAt: string;
};

export type ProtectedVerificationSubmission = {
  authorizationId: string;
  topic: string;
  taskId: string;
  workflowRevision: number;
  evidence: VerificationEvidence;
  beforeSnapshotHash: string;
  afterSnapshotHash: string;
  sourceChanged: boolean;
  observedChangedPaths: string[];
};

/**
 * In-memory authorizations intentionally die on reload, session replacement, or
 * process exit. Persisted workflow evidence is accepted only after consuming a
 * live one-shot authorization. This is a workflow integrity boundary, not an OS
 * sandbox: hostile same-user processes and users disabling the extension remain
 * outside the guarantee.
 */
export class ManagedVerificationAuthority {
  readonly cwd: string;
  readonly inspector: RelevantSourceInspector;
  readonly now: () => string;
  readonly id: () => string;
  private readonly authorizations = new Map<string, VerificationAuthorization>();
  private readonly submissions = new Map<string, string>();

  constructor(cwd: string, inspector: RelevantSourceInspector, options: { now?: () => string; id?: () => string } = {}) {
    this.cwd = cwd;
    this.inspector = inspector;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => `verification-${randomUUID()}`);
  }

  authorize(input: {
    workflow: Workflow;
    taskId: string;
    toolName: string;
    toolCallId: string;
    commandLine: string;
    parent: ParentExecutionIdentity;
  }): VerificationAuthorization {
    const task = requireVerificationTask(input.workflow, input.taskId);
    assertParent(input.workflow, input.parent, this.cwd);
    if (input.toolName !== "bash") throw new Error("verification authorization requires protected bash provenance");
    if (!input.toolCallId.trim()) throw new Error("verification tool-call provenance is required");
    if (this.authorizations.size) throw new Error("another protected verification command is already authorized");
    const command = task.verification.find((candidate) => renderVerificationCommand(candidate) === input.commandLine);
    if (!command) throw new Error("command is not an exact planned verification");
    if (!/^[A-Za-z0-9_./:@%+=,-]+$/.test(command.command)) throw new Error("managed verification requires one shell-safe executable in command and separate exact args; revise the plan contract");
    const sourceBefore = this.inspector.inspect(input.workflow, task);
    const expectedSnapshot = taskExpectedSnapshot(task);
    const expectedHead = task.integrationReceipt?.observedHead ?? task.workspaceReceipt?.realHead;
    const expectedBranch = task.integrationReceipt?.observedBranch ?? task.workspaceReceipt?.realBranch;
    if (sourceBefore.hash !== expectedSnapshot) throw new Error("relevant source snapshot drifted before verification; approvals and evidence must be invalidated");
    if (sourceBefore.head !== expectedHead) throw new Error("Git HEAD changed before verification; parent checkpoint is stale");
    if (expectedBranch !== undefined && sourceBefore.branch !== expectedBranch) throw new Error("Git branch changed before verification; parent checkpoint is stale");
    const authorization: VerificationAuthorization = {
      id: this.id(), topic: input.workflow.topic, taskId: task.id, workflowRevision: input.workflow.revision,
      contractHash: task.contract.hash, expectedSnapshotHash: expectedSnapshot!,
      command: structuredClone(command), commandLine: input.commandLine, cwd: this.cwd, toolName: "bash", toolCallId: input.toolCallId,
      parent: structuredClone(input.parent), sourceBefore, authorizedAt: this.now(),
    };
    if (!authorization.id || this.authorizations.has(authorization.id) || this.submissions.has(authorization.id)) throw new Error("verification authorization id is empty or reused");
    this.authorizations.set(authorization.id, authorization);
    return structuredClone(authorization);
  }

  finish(input: {
    authorizationId: string;
    workflow: Workflow;
    taskId: string;
    toolCallId: string;
    exitCode: number;
    parent: ParentExecutionIdentity;
  }): ProtectedVerificationSubmission {
    const authorization = this.authorizations.get(input.authorizationId);
    if (!authorization) throw new Error("verification authorization is forged, stale, or already consumed");
    const task = requireVerificationTask(input.workflow, input.taskId);
    assertParent(input.workflow, input.parent, this.cwd);
    if (input.toolCallId !== authorization.toolCallId) throw new Error("verification result has forged tool-call provenance");
    if (!sameParent(input.parent, authorization.parent)) throw new Error("verification parent/session checkpoint changed during command execution");
    if (input.workflow.topic !== authorization.topic || input.workflow.revision !== authorization.workflowRevision || task.contract.hash !== authorization.contractHash || taskExpectedSnapshot(task) !== authorization.expectedSnapshotHash) throw new Error("verification authorization is stale for the workflow, contract, or source snapshot");
    if (!Number.isSafeInteger(input.exitCode)) throw new Error("verification exit code is invalid");
    const sourceAfter = this.inspector.inspect(input.workflow, task);
    const completedAt = this.now();
    const evidence: VerificationEvidence = {
      ...structuredClone(authorization.command), exitCode: input.exitCode, at: completedAt,
      contractHash: authorization.contractHash, snapshotHash: authorization.expectedSnapshotHash,
      cwd: authorization.cwd, branch: sourceAfter.branch, head: sourceAfter.head,
      beforeSnapshotHash: authorization.sourceBefore.hash, afterSnapshotHash: sourceAfter.hash,
      source: {
        kind: "bash-tool-result", toolCallId: authorization.toolCallId, toolName: "bash",
        workflowRevision: authorization.workflowRevision, sessionId: authorization.parent.sessionId,
        ownerId: authorization.parent.ownerId, runtimeId: authorization.parent.runtimeId,
        ...(authorization.parent.sessionFile ? { sessionFile: authorization.parent.sessionFile } : {}),
        ...(authorization.parent.sessionBranchId ? { sessionBranchId: authorization.parent.sessionBranchId } : {}),
        branchLength: authorization.parent.branchLength,
      },
    };
    const submission: ProtectedVerificationSubmission = {
      authorizationId: authorization.id, topic: authorization.topic, taskId: authorization.taskId,
      workflowRevision: authorization.workflowRevision, evidence,
      beforeSnapshotHash: authorization.sourceBefore.hash, afterSnapshotHash: sourceAfter.hash,
      sourceChanged: authorization.sourceBefore.hash !== sourceAfter.hash || authorization.sourceBefore.head !== sourceAfter.head || authorization.sourceBefore.branch !== sourceAfter.branch,
      observedChangedPaths: [...sourceAfter.changedPaths],
    };
    this.authorizations.delete(authorization.id);
    this.submissions.set(authorization.id, digestSubmission(submission));
    return structuredClone(submission);
  }

  consume(submission: ProtectedVerificationSubmission, workflow: Workflow, task: WorkflowTask, parent: ParentExecutionIdentity): ProtectedVerificationSubmission {
    const expected = this.submissions.get(submission.authorizationId);
    if (!expected || expected !== digestSubmission(submission)) throw new Error("verification submission is forged, stale, or already consumed");
    assertParent(workflow, parent, this.cwd);
    if (submission.topic !== workflow.topic || submission.taskId !== task.id || submission.workflowRevision !== workflow.revision) throw new Error("verification submission is stale for the current workflow revision");
    const source = submission.evidence.source;
    if (!source || source.kind !== "bash-tool-result" || source.toolName !== "bash" || source.ownerId !== parent.ownerId || source.sessionId !== parent.sessionId || source.runtimeId !== parent.runtimeId || source.sessionBranchId !== parent.sessionBranchId || source.branchLength !== parent.branchLength) throw new Error("verification submission parent or protected-bash provenance is forged or stale");
    if (submission.evidence.contractHash !== task.contract.hash || submission.evidence.snapshotHash !== taskExpectedSnapshot(task) || submission.evidence.cwd !== this.cwd) throw new Error("verification submission contract, snapshot, or cwd is stale");
    this.submissions.delete(submission.authorizationId);
    return structuredClone(submission);
  }

  assertCompletion(workflow: Workflow, task: WorkflowTask, parent: ParentExecutionIdentity): void {
    assertParent(workflow, parent, this.cwd);
    const source = this.inspector.inspect(workflow, task);
    if (source.hash !== taskExpectedSnapshot(task)) throw new Error("relevant source snapshot changed immediately before completion");
    if (source.head !== (task.integrationReceipt?.observedHead ?? task.workspaceReceipt?.realHead)) throw new Error("Git HEAD changed immediately before completion");
    const expectedBranch = task.integrationReceipt?.observedBranch ?? task.workspaceReceipt?.realBranch;
    if (expectedBranch !== undefined && source.branch !== expectedBranch) throw new Error("Git branch changed immediately before completion");
    for (const planned of task.verification) {
      const matching = task.evidence.filter((item) => sameCommand(item, planned));
      const latest = matching.at(-1);
      if (!latest || latest.exitCode !== 0) throw new Error(`missing current passing verification: ${renderVerificationCommand(planned)}`);
      if (latest.contractHash !== task.contract.hash || latest.snapshotHash !== source.hash || latest.beforeSnapshotHash !== source.hash || latest.afterSnapshotHash !== source.hash || latest.cwd !== this.cwd) throw new Error("verification evidence is stale at completion");
      const provenance = latest.source;
      if (!provenance || provenance.toolName !== "bash" || provenance.ownerId !== parent.ownerId || provenance.sessionId !== parent.sessionId || provenance.runtimeId !== parent.runtimeId) throw new Error("completion requires protected-bash evidence from the current parent authority");
      if (parent.branchToolCallIds && !parent.branchToolCallIds.includes(provenance.toolCallId)) throw new Error("verification evidence is no longer on the active session branch");
      if (provenance.branchLength !== undefined && provenance.branchLength > parent.branchLength) throw new Error("verification evidence belongs to a newer or different session checkpoint");
      if (latest.branch !== source.branch) throw new Error("Git branch changed after verification evidence was recorded");
    }
  }

  invalidate(): void {
    this.authorizations.clear();
    this.submissions.clear();
  }
}

export type ParentIntegrityRouter = {
  install(cwd: string, generation: number, runtimeId: string, sessionId: string): void;
  block(cwd: string, reason?: string): void;
  remove(cwd: string, generation?: number): void;
  identity(cwd: string): { generation: number; runtimeId: string; sessionId: string } | undefined;
  onSessionShutdown(handler: (cwd: string) => void | Promise<void>): void;
  invalidate(): void;
};

/** Register one hook router. Runtime generations are installed atomically by the checkout controller. */
export function registerParentIntegrity(pi: ExtensionAPI, options: { passive?: boolean; authorityFactory?: (cwd: string) => ManagedVerificationAuthority } = {}): ParentIntegrityRouter {
  const routes = new Map<string, { generation: number; runtimeId: string; sessionId: string }>();
  const blockedCheckouts = new Map<string, string>();
  const authorities = new Map<string, ManagedVerificationAuthority>();
  const pending = new Map<string, { key: string; topic: string; authorizationId: string; generation: number }>();
  const revoked = new Map<string, string>();
  const revoke = (callId: string, reason: string) => {
    revoked.delete(callId);
    revoked.set(callId, reason);
    while (revoked.size > MAX_REVOKED_TOOL_CALLS) revoked.delete(revoked.keys().next().value!);
  };
  const revokePending = (matches: (item: { key: string }) => boolean, reason: string) => {
    for (const [callId, item] of pending) if (matches(item)) { pending.delete(callId); revoke(callId, reason); }
  };
  const trustedTools = new Map<string, { fingerprint: string; identity: unknown }>();
  let shutdownHandler: ((cwd: string) => void | Promise<void>) | undefined;
  const root = (cwd: string) => { try { return realpathSync(cwd); } catch { return cwd; } };
  const keyFor = (cwd: string, generation: number, topic: string) => `${root(cwd)}\0${generation}\0${topic}`;

  const authorityFor = (cwd: string, generation: number, topic: string): ManagedVerificationAuthority => {
    const key = keyFor(cwd, generation, topic);
    let authority = authorities.get(key);
    if (!authority) {
      authority = options.authorityFactory?.(root(cwd)) ?? new ManagedVerificationAuthority(root(cwd), new GitRelevantSourceInspector(root(cwd)));
      authorities.set(key, authority);
    }
    return authority;
  };

  const router: ParentIntegrityRouter = {
    install(cwd, generation, runtimeId, sessionId) {
      if (!Number.isSafeInteger(generation) || generation < 0 || !runtimeId.trim() || !sessionId.trim()) throw new Error("integrity route identity is invalid");
      const key = root(cwd);
      const prior = routes.get(key);
      if (prior && generation < prior.generation) throw new Error("integrity route generation cannot move backwards");
      if (prior && (prior.generation !== generation || prior.runtimeId !== runtimeId || prior.sessionId !== sessionId)) {
        for (const [authorityKey, authority] of authorities) if (authorityKey.startsWith(`${key}\0`)) { authority.invalidate(); authorities.delete(authorityKey); }
        revokePending((item) => item.key.startsWith(`${key}\0`), "runtime generation changed during verification");
      }
      blockedCheckouts.delete(key);
      routes.set(key, { generation, runtimeId, sessionId });
    },
    block(cwd, reason = "managed runtime authority is unavailable") {
      const key = root(cwd);
      if (!reason.trim()) throw new Error("managed runtime block reason is required");
      router.remove(key);
      blockedCheckouts.set(key, reason);
    },
    remove(cwd, generation) {
      const key = root(cwd);
      const route = routes.get(key);
      if (!route) { if (generation === undefined) blockedCheckouts.delete(key); return; }
      if (generation !== undefined && route.generation !== generation) return;
      routes.delete(key);
      blockedCheckouts.delete(key);
      for (const [authorityKey, authority] of authorities) if (authorityKey.startsWith(`${key}\0`)) { authority.invalidate(); authorities.delete(authorityKey); }
      revokePending((item) => item.key.startsWith(`${key}\0`), "runtime route was removed during verification");
    },
    identity(cwd) { return routes.get(root(cwd)); },
    onSessionShutdown(handler) { shutdownHandler = handler; },
    invalidate() { for (const authority of authorities.values()) authority.invalidate(); authorities.clear(); revokePending(() => true, "integrity controller shut down during verification"); routes.clear(); blockedCheckouts.clear(); },
  };

  if (typeof (pi as ExtensionAPI & { on?: unknown }).on !== "function") return router;
  const subscribe: ExtensionAPI["on"] = pi.on.bind(pi);

  subscribe("session_start", async (_event, ctx) => {
    trustedTools.clear();
    for (const tool of pi.getAllTools()) if (approvedRegisteredTool(tool)) trustedTools.set(tool.name, { fingerprint: toolFingerprint(tool), identity: tool });
    const sessionId = typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "unbound-session";
    if (!routes.has(root(ctx.cwd))) {
      if (!options.passive) {
        router.install(ctx.cwd, 1, `parent-runtime-${randomUUID()}`, sessionId);
      } else {
        const selected = readRuntimeSelection(ctx.cwd);
        if (selected.status === "blocked") router.block(ctx.cwd, `malformed runtime selector: ${selected.reason}`);
        else if (!selected.record) router.install(ctx.cwd, 0, `parent-runtime-${randomUUID()}`, sessionId);
        // Recorded generations are installed only after the controller validates
        // and, on process restart, atomically rotates the durable parent.
      }
    }
  });

  subscribe("tool_call", async (event, ctx) => {
    const checkout = root(ctx.cwd);
    const blockedReason = blockedCheckouts.get(checkout);
    if (blockedCheckouts.has(checkout)) {
      const decision = decideManagedToolCall({ managed: true, phase: "pending", planned: [], toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd, expectedCwd: ctx.cwd, trustedTool: trustedToolCall(pi, trustedTools, event.toolName) });
      return decision.allow ? undefined : { block: true, reason: `managed execution blocked by ${blockedReason}: ${decision.reason}` };
    }
    const route = routes.get(checkout);
    if (!route) return undefined;
    const runtimeId = route.runtimeId;
    let workflows: Workflow[];
    try { workflows = managedWorkflows(ctx.cwd); }
    catch (error) {
      const readDecision = decideManagedToolCall({ managed: true, phase: "pending", planned: [], toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd, expectedCwd: ctx.cwd, trustedTool: trustedToolCall(pi, trustedTools, event.toolName) });
      if (readDecision.allow) return undefined;
      return { block: true, reason: `managed workflow discovery failed closed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!workflows.length) return undefined;
    const activeCandidates = workflows.filter((candidate) => candidate.status === "active");
    const workflow = workflows.length === 1 ? workflows[0]! : activeCandidates.length === 1 ? activeCandidates[0] : undefined;
    if (!workflow) {
      const decision = decideManagedToolCall({ managed: true, phase: "pending", planned: [], toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd, expectedCwd: ctx.cwd, trustedTool: trustedToolCall(pi, trustedTools, event.toolName) });
      return decision.allow ? undefined : { block: true, reason: "multiple managed workflows exist; execution fails closed until ownership is unambiguous" };
    }
    const task = workflow.activeTask ? workflow.tasks.find((candidate) => candidate.id === workflow.activeTask) : undefined;
    const decision = decideManagedToolCall({ managed: true, phase: task?.phase ?? (workflow.orchestration.phase === "plan-review" ? "plan-review" : workflow.orchestration.phase === "initiative-acceptance" ? "initiative-acceptance" : "pending"), planned: task?.verification ?? [], toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd, expectedCwd: workflow.orchestration.parent?.cwd ?? ctx.cwd, trustedTool: trustedToolCall(pi, trustedTools, event.toolName) });
    if (!decision.allow) return { block: true, reason: decision.reason };
    if (event.toolName !== "bash") return undefined;
    const parentAuthority = workflow.orchestration.parent;
    if (!task || !parentAuthority?.valid || parentAuthority.runtimeId !== runtimeId || parentAuthority.sessionId !== ctx.sessionManager.getSessionId()) return { block: true, reason: "protected bash requires the current claimed parent session and runtime" };
    const parent = executionIdentity(ctx, parentAuthority.ownerId, runtimeId);
    try {
      const key = keyFor(ctx.cwd, route.generation, workflow.topic);
      const authorization = authorityFor(ctx.cwd, route.generation, workflow.topic).authorize({ workflow, taskId: task.id, toolName: "bash", toolCallId: event.toolCallId, commandLine: String((event.input as { command?: unknown }).command ?? ""), parent });
      revoked.delete(event.toolCallId);
      pending.set(event.toolCallId, { key, topic: workflow.topic, authorizationId: authorization.id, generation: route.generation });
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  subscribe("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const revokedReason = revoked.get(event.toolCallId);
    if (revokedReason) {
      revoked.delete(event.toolCallId);
      return { isError: true, content: [...event.content, { type: "text" as const, text: `\npi-swe rejected verification evidence: ${revokedReason}` }] };
    }
    const active = pending.get(event.toolCallId);
    if (!active) {
      const checkout = root(ctx.cwd);
      if (blockedCheckouts.has(checkout) || routes.has(checkout)) {
        try {
          if (blockedCheckouts.has(checkout) || managedWorkflows(ctx.cwd).length > 0) return { isError: true, content: [...event.content, { type: "text" as const, text: "\npi-swe rejected verification evidence: unknown or evicted protected bash authorization" }] };
        } catch (error) {
          return { isError: true, content: [...event.content, { type: "text" as const, text: `\npi-swe rejected verification evidence: managed workflow discovery failed closed: ${error instanceof Error ? error.message : String(error)}` }] };
        }
      }
      return undefined;
    }
    pending.delete(event.toolCallId);
    const route = routes.get(root(ctx.cwd));
    if (!route || route.generation !== active.generation || active.key !== keyFor(ctx.cwd, route.generation, active.topic)) return { isError: true, content: [...event.content, { type: "text" as const, text: "\npi-swe rejected verification evidence: runtime generation changed during verification" }] };
    const runtimeId = route.runtimeId;
    try {
      const located = loadWorkflow(ctx.cwd, active.topic);
      if (!located) throw new Error(`managed workflow ${active.topic} disappeared during verification`);
      const workflow = located.workflow;
      const task = workflow.activeTask ? workflow.tasks.find((candidate) => candidate.id === workflow.activeTask) : undefined;
      if (!task) throw new Error("managed verification task is no longer active");
      const parentAuthority = workflow.orchestration.parent;
      if (!parentAuthority) throw new Error("managed parent authority disappeared during verification");
      const parent = executionIdentity(ctx, parentAuthority.ownerId, runtimeId);
      const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
      const detailCode = details.exitCode;
      const exitCode = Number.isSafeInteger(detailCode) ? detailCode as number : event.isError ? 1 : 0;
      const authority = authorityFor(ctx.cwd, route.generation, workflow.topic);
      const submission = authority.finish({ authorizationId: active.authorizationId, workflow, taskId: task.id, toolCallId: event.toolCallId, exitCode, parent });
      authority.consume(submission, workflow, task, parent);
      const service = new WorkflowMutationService(ctx.cwd);
      const expectedSnapshot = taskExpectedSnapshot(task);
      const sourceChanged = submission.sourceChanged || submission.afterSnapshotHash !== expectedSnapshot;
      await service.mutate(workflow.topic, workflow.revision, (current) => reduceWorkflow(current, sourceChanged || exitCode !== 0 ? {
        type: "record-verification-failure", evidence: submission.evidence, observedSnapshotHash: submission.afterSnapshotHash,
        observedChangedPaths: submission.observedChangedPaths, reason: sourceChanged ? `expected ${expectedSnapshot}, observed ${submission.afterSnapshotHash}` : `command exited ${exitCode}`,
      } : { type: "record-verification", evidence: submission.evidence }));
      return { details: { ...details, piSweProtectedVerification: { topic: workflow.topic, taskId: task.id, authorizationId: submission.authorizationId, sourceChanged } } };
    } catch (error) {
      authorityFor(ctx.cwd, route.generation, active.topic).invalidate();
      return { isError: true, content: [...event.content, { type: "text" as const, text: `\npi-swe rejected verification evidence: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });

  subscribe("before_agent_start", async (_event, ctx) => {
    if (!routes.has(root(ctx.cwd))) return;
    for (const workflow of managedWorkflows(ctx.cwd)) await invalidateIntegratedDrift(ctx.cwd, workflow);
  });

  subscribe("user_bash", async () => {
    for (const authority of authorities.values()) authority.invalidate();
    revokePending(() => true, "user bash invalidated protected verification");
    return undefined;
  });

  subscribe("session_shutdown", async (event, ctx) => {
    const cwd = root(ctx.cwd);
    const route = routes.get(cwd);
    if (route) {
      for (const workflow of managedWorkflows(cwd)) {
        const parent = workflow.orchestration.parent;
        if (!parent?.valid || parent.runtimeId !== route.runtimeId || parent.sessionId !== route.sessionId) continue;
        const service = new WorkflowMutationService(cwd);
        try { await service.fenceParent(workflow.topic, workflow.revision, parent, `session ${event.reason}`); }
        catch (error) {
          const latest = service.read(workflow.topic, false)?.workflow.orchestration.parent;
          if (latest?.valid && latest.runtimeId === route.runtimeId) throw error;
        }
      }
      router.remove(cwd, route.generation);
    }
    await shutdownHandler?.(cwd);
  });

  return router;
}

function managedWorkflows(cwd: string): Workflow[] {
  return listWorkflowTopics(cwd).map((topic) => loadWorkflow(cwd, topic)?.workflow).filter((workflow): workflow is Workflow => !!workflow && !workflow.migration && workflow.orchestration.mode === "multi-agent" && workflow.orchestration.phase !== "complete" && workflow.status !== "complete");
}

async function invalidateIntegratedDrift(cwd: string, workflow: Workflow): Promise<void> {
  const task = workflow.activeTask ? workflow.tasks.find((candidate) => candidate.id === workflow.activeTask) : undefined;
  if (!task || !["verification", "ready-to-complete"].includes(task.phase) || !task.workspaceReceipt || !taskExpectedSnapshot(task)) return;
  const observed = new GitRelevantSourceInspector(cwd).inspect(workflow, task);
  const expectedHead = task.integrationReceipt?.observedHead ?? task.workspaceReceipt.realHead;
  const expectedBranch = task.integrationReceipt?.observedBranch ?? task.workspaceReceipt.realBranch;
  if (observed.hash === taskExpectedSnapshot(task) && observed.head === expectedHead && (expectedBranch === undefined || observed.branch === expectedBranch)) return;
  if (!observed.changedPaths.length && (observed.head !== expectedHead || (expectedBranch !== undefined && observed.branch !== expectedBranch))) {
    const parent = workflow.orchestration.parent;
    if (!parent?.valid) throw new Error("managed Git branch/HEAD drift has no valid parent authority to invalidate");
    const service = new WorkflowMutationService(cwd);
    await service.fenceParent(workflow.topic, workflow.revision, parent, "Git branch or HEAD changed outside the managed checkpoint");
    return;
  }
  if (!observed.changedPaths.length) throw new Error("managed source drift could not be attributed to bounded paths");
  const service = new WorkflowMutationService(cwd);
  await service.mutate(workflow.topic, workflow.revision, (current) => reduceWorkflow(current, {
    type: "invalidate-integrated-source", observedSnapshotHash: observed.hash, observedChangedPaths: observed.changedPaths,
    reason: `external or user-controlled source drift before managed execution; expected ${taskExpectedSnapshot(task)}, observed ${observed.hash}`,
  }));
}

function executionIdentity(ctx: { cwd: string; sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getLeafId?(): string | null; getBranch(): readonly unknown[] } }, ownerId: string, runtimeId: string): ParentExecutionIdentity {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  const sessionBranchId = ctx.sessionManager.getLeafId?.() ?? undefined;
  const branch = ctx.sessionManager.getBranch();
  const branchToolCallIds = branch.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("message" in entry)) return [];
    const message = (entry as { message?: { role?: string; toolCallId?: string } }).message;
    return message?.role === "toolResult" && message.toolCallId ? [message.toolCallId] : [];
  });
  return { ownerId, sessionId: ctx.sessionManager.getSessionId(), runtimeId, cwd: ctx.cwd, ...(sessionFile ? { sessionFile } : {}), ...(sessionBranchId ? { sessionBranchId } : {}), branchLength: branch.length, branchToolCallIds };
}

function approvedRegisteredTool(tool: { name: string; sourceInfo?: unknown }): boolean {
  const sourceInfo = tool.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo as { source?: unknown; path?: unknown } : undefined;
  if (["read", "grep", "find", "ls", "bash"].includes(tool.name)) return sourceInfo?.source === "builtin" && typeof sourceInfo.path === "string" && sourceInfo.path === `<builtin:${tool.name}>`;
  if (tool.name === "intercom") return typeof sourceInfo?.source === "string" && sourceInfo.source !== "builtin" && typeof sourceInfo.path === "string" && /(?:^|[\\/])pi-intercom[\\/]index\.ts$/.test(sourceInfo.path);
  if (!APPROVED_READ_ONLY_TOOLS.has(tool.name) && tool.name !== "swe_workflow") return false;
  return typeof sourceInfo?.source === "string" && sourceInfo.source !== "builtin" && typeof sourceInfo.path === "string" && sourceInfo.path.length > 0;
}
function trustedToolCall(pi: ExtensionAPI, trusted: Map<string, { fingerprint: string; identity: unknown }>, name: string): boolean {
  const captured = trusted.get(name);
  if (!captured) return false;
  const current = pi.getAllTools().find((tool) => tool.name === name);
  return !!current && current === captured.identity && toolFingerprint(current) === captured.fingerprint;
}
function toolFingerprint(tool: { name: string; sourceInfo?: unknown }): string {
  const sourceInfo = tool.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo as { path?: unknown } : undefined;
  let sourceHash: string | null = null;
  if (typeof sourceInfo?.path === "string" && !sourceInfo.path.startsWith("<builtin:")) {
    try { sourceHash = createHash("sha256").update(readFileSync(realpathSync(sourceInfo.path))).digest("hex"); }
    catch { sourceHash = "unreadable"; }
  }
  return JSON.stringify({ name: tool.name, sourceInfo: tool.sourceInfo ?? null, sourceHash });
}

function requireVerificationTask(workflow: Workflow, taskId: string): WorkflowTask {
  const task = workflow.tasks.find((candidate) => candidate.id === taskId);
  if (!task || workflow.activeTask !== task.id || workflow.status !== "active" || task.status !== "active" || task.phase !== "verification" || !task.workspaceReceipt || !taskExpectedSnapshot(task)) throw new Error("protected verification is unavailable outside the active verification phase");
  return task;
}

function assertParent(workflow: Workflow, parent: ParentExecutionIdentity, cwd: string): void {
  const authority = workflow.orchestration.parent;
  if (!authority?.valid || authority.ownerId !== parent.ownerId || authority.sessionId !== parent.sessionId || authority.runtimeId !== parent.runtimeId) throw new Error("parent ownership or session authority is absent, stale, or belongs to a competing parent");
  if (parent.cwd !== cwd || authority.cwd !== cwd) throw new Error("parent cwd does not match the managed repository");
}

function sameParent(left: ParentExecutionIdentity, right: ParentExecutionIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runtimeId === right.runtimeId && left.cwd === right.cwd && left.sessionFile === right.sessionFile && left.sessionBranchId === right.sessionBranchId && left.branchLength === right.branchLength;
}

function digestSubmission(submission: ProtectedVerificationSubmission): string {
  return createHash("sha256").update(JSON.stringify(submission)).digest("hex");
}

function taskExpectedSnapshot(task: WorkflowTask): string | undefined { return task.integrationReceipt?.postSnapshotHash ?? task.workspaceReceipt?.snapshotHash; }

function sameCommand(left: VerificationCommand, right: VerificationCommand): boolean {
  return left.command === right.command && left.args.length === right.args.length && left.args.every((arg, index) => arg === right.args[index]);
}

function shellWord(value: string): string {
  if (!value || /[\n\r\0]/.test(value)) throw new Error("verification command contains an unsafe shell word");
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
