import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { InitiativeCloseoutAuthority } from "../extensions/pi-swe/src/closeout.ts";
import { readRuntimeSelection, writeRuntimeSelection, REVIEWED_MIGRATION_EVIDENCE_HASH, REVIEWED_READINESS_EVIDENCE_HASH, type Gate2Decision } from "../extensions/pi-swe/src/cutover.ts";
import { GitRelevantSourceInspector, ManagedVerificationAuthority, registerParentIntegrity, renderVerificationCommand, type ParentExecutionIdentity, type RelevantSourceSnapshot } from "../extensions/pi-swe/src/integrity.ts";
import { SharedRuntimeController } from "../extensions/pi-swe/src/runtime.ts";
import { WorkflowMutationService } from "../extensions/pi-swe/src/service.ts";
import { createWorkflow, hashContract, parseWorkflow, reduceWorkflow, type Workflow } from "../extensions/pi-swe/src/workflow.ts";

type Handler = (event: any, context: any) => unknown;

function harness() {
  const hooks = new Map<string, Handler>();
  let command: any;
  let tool: any;
  let replaced = false;
  const pi = {
    registerCommand: (_name: string, value: any) => { command = value; },
    registerTool: (value: any) => { tool = value; },
    on: (name: string, value: Handler) => { hooks.set(name, value); },
    getAllTools: () => ["read", "grep", "find", "ls", "bash"].map((name) => ({ name, sourceInfo: { source: replaced && name === "bash" ? "extension" : "builtin", path: replaced && name === "bash" ? "/hostile/bash" : `<builtin:${name}>` } })),
    sendUserMessage: () => undefined,
  };
  return { pi, hooks, command: () => command, tool: () => tool, replaceBash: () => { replaced = true; } };
}

function context(cwd: string, sessionId = "session") {
  const notifications: string[] = [];
  return {
    cwd, hasUI: true, model: { provider: "openai", id: "test" }, thinkingLevel: "low",
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getLeafId: () => "leaf", getBranch: () => [] },
    ui: { notify: (text: string) => notifications.push(text), confirm: async () => true, input: async () => undefined, select: async () => undefined },
    notifications,
  };
}

function repository(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function persist(cwd: string, workflow: ReturnType<typeof createWorkflow>): string {
  const path = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(workflow)}\n`);
  return path;
}

class SnapshotInspector {
  snapshot: RelevantSourceSnapshot = { hash: "snapshot", head: "head", branch: "main", changedPaths: [] };
  inspect(): RelevantSourceSnapshot { return structuredClone(this.snapshot); }
}

function verificationWorkflow(): Workflow {
  let workflow = createWorkflow({ topic: "verification-grant", goal: "verify", tasks: [{ id: "T1", title: "verify", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
  workflow = { ...workflow, status: "active", activeTask: "T1", orchestration: { ...workflow.orchestration, phase: "task-execution", parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "runtime-old", cwd: "/repo", claimedAt: new Date().toISOString(), valid: true } }, tasks: workflow.tasks.map((task) => ({ ...task, status: "active", phase: "verification", workspaceReceipt: { version: 1, workspaceId: "ws", baselineHash: "base", snapshotHash: "snapshot", changedPaths: [], createdAt: new Date().toISOString(), includedUntracked: [], managedPaths: [] }, integrationReceipt: { version: 1, integrationId: "integration", workspaceId: "ws", preSnapshotHash: "base", postSnapshotHash: "snapshot", patchHash: "patch", integratedAt: new Date().toISOString(), resultCommit: "result", resultRef: "refs/result", observedHead: "head", observedBranch: "main", observedIndexHash: "index", changedPaths: [] }, verificationCheckpoint: { revision: workflow.revision, at: new Date().toISOString(), sessionId: "session", branchLength: 1 } })) };
  return workflow;
}

const verificationParent = (runtimeId = "runtime-old"): ParentExecutionIdentity => ({ ownerId: "parent:session", sessionId: "session", runtimeId, cwd: "/repo", sessionBranchId: "leaf", branchLength: 2 });

test("real registered command and tool handlers use the controller-selected bound identity, and session shutdown cleanup leaves a parser-valid restartable fence", async () => {
  const cwd = repository("pi-swe-bound-surfaces-");
  try {
    const captured = harness();
    piSwe(captured.pi as never);
    const ctx = context(cwd);
    let workflow = createWorkflow({ topic: "bound-surfaces", goal: "bind", tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent:session", sessionId: "session", runtimeId: "dead-process", cwd, claimedAt: new Date().toISOString(), valid: true } }).workflow;
    const path = persist(cwd, workflow);

    await captured.command().handler("work inspect bound-surfaces", ctx);
    assert.match(ctx.notifications.at(-1)!, /runtime: compatibility; selector generation 0/);
    const toolResult = await captured.tool().execute("call", { action: "inspect", topic: "bound-surfaces" }, undefined, undefined, ctx);
    assert.match(toolResult.content[0].text, /pi-swe bound-surfaces/);

    const fencedAfterResolve = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(fencedAfterResolve.orchestration.parent?.valid, false);
    await captured.command().handler("work start bound-surfaces", ctx);
    const resumed = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(resumed.orchestration.parent?.valid, true);
    assert.notEqual(resumed.orchestration.parent?.runtimeId, "session:session");
    assert.notEqual(resumed.orchestration.parent?.runtimeId, "dead-process");

    await captured.hooks.get("session_shutdown")!({ reason: "shutdown" }, ctx);
    const shutdown = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(shutdown.orchestration.parent?.valid, false);
    assert.equal(shutdown.orchestration.activeRun, undefined);
    const shutdownRuntimeId = shutdown.orchestration.parent!.runtimeId;
    await captured.command().handler("work resume bound-surfaces", ctx);
    const restarted = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(restarted.orchestration.parent?.valid, true);
    assert.notEqual(restarted.orchestration.parent?.runtimeId, shutdownRuntimeId);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("real controller serializes concurrent resolve to one winner and revalidates trusted tools instead of caching preflight", async () => {
  const cwd = repository("pi-swe-concurrent-resolve-");
  try {
    const captured = harness();
    const controller = new SharedRuntimeController(captured.pi as never);
    const identity = { sessionId: "session", runtimeId: "context", provider: "openai", model: "test", thinking: "low", branchLength: 0 };
    const [left, right] = await Promise.all([controller.resolve(cwd, identity), controller.resolve(cwd, identity)]);
    assert.equal(left, right);
    assert.equal(left.identity.runtimeId, right.identity.runtimeId);
    captured.replaceBash();
    await assert.rejects(() => controller.resolve(cwd, identity), /trusted tool identity failed: bash/);
    controller.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("late child and stale lease are rejected after expiry recovery under the real controller", async () => {
  const cwd = repository("pi-swe-expired-lease-");
  try {
    let workflow = createWorkflow({ topic: "expired-lease", goal: "fence", tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    persist(cwd, workflow);
    const service = new WorkflowMutationService(cwd);
    const claimed = await service.claimRun(workflow.topic, workflow.revision, { ownerId: "parent:session", runId: "late-child", stage: "plan-review", ttlMs: 1_000, now: "2020-01-01T00:00:00.000Z" });
    const controller = new SharedRuntimeController(harness().pi as never);
    await controller.resolve(cwd, { sessionId: "session", runtimeId: "context", provider: "openai", model: "test", thinking: "low", branchLength: 0 });
    const recovered = service.read(workflow.topic, false)!.workflow;
    assert.equal(recovered.orchestration.activeRun, undefined);
    await assert.rejects(() => service.settleRun(workflow.topic, recovered.revision, claimed.lease, (state) => ({ workflow: state, changed: false, message: "late" })), /stale.*lease|fence/i);
    controller.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("rollback generation invalidates stale verification and integrity grants; protected verification requires the fresh parent", () => {
  const inspector = new SnapshotInspector();
  const authority = new ManagedVerificationAuthority("/repo", inspector, { id: () => "grant", now: () => new Date().toISOString() });
  const workflow = verificationWorkflow();
  const planned = workflow.tasks[0]!.verification[0]!;
  const grant = authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-old", commandLine: renderVerificationCommand(planned), parent: verificationParent() });
  const rotated = reduceWorkflow({ ...workflow, orchestration: { ...workflow.orchestration, runtimeHandoff: { id: "cutover", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: new Date().toISOString(), reclaimedAt: new Date().toISOString() } } }, { type: "rotate-runtime-parent", handoffId: "rollback", decisionId: "decision", from: "v2", to: "compatibility", selectorGeneration: 2, authority: { ...workflow.orchestration.parent!, runtimeId: "runtime-fresh", valid: true } }).workflow;
  assert.throws(() => authority.finish({ authorizationId: grant.id, workflow: rotated, taskId: "T1", toolCallId: "call-old", exitCode: 0, parent: verificationParent("runtime-fresh") }), /ownership|session|stale|checkpoint|unavailable/i);
  authority.invalidate();
  assert.throws(() => authority.finish({ authorizationId: grant.id, workflow, taskId: "T1", toolCallId: "call-old", exitCode: 0, parent: verificationParent() }), /forged|stale|consumed/i);
  const freshAuthority = new ManagedVerificationAuthority("/repo", inspector, { id: () => "fresh-grant" });
  const freshWorkflow = { ...workflow, orchestration: { ...workflow.orchestration, parent: { ...workflow.orchestration.parent!, runtimeId: "runtime-fresh" } } };
  assert.doesNotThrow(() => freshAuthority.authorize({ workflow: freshWorkflow, taskId: "T1", toolName: "bash", toolCallId: "call-fresh", commandLine: renderVerificationCommand(planned), parent: verificationParent("runtime-fresh") }));
});

test("production hook rejects a stale protected result after controller-driven rollback", async (t) => {
  const cwd = repository("pi-swe-controller-hook-tombstone-");
  let controller: SharedRuntimeController | undefined;
  try {
    const captured = harness();
    const ctx = context(cwd);
    const at = new Date().toISOString();
    const decision: Gate2Decision = {
      decisionId: "controller-hook-rollback", authorizedBy: "operator", authorizedAt: at,
      readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH,
      targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "verify stale hook-result rejection",
    };
    let workflow = verificationWorkflow();
    workflow = {
      ...workflow, topic: "swe-production-rollout",
      orchestration: {
        ...workflow.orchestration,
        parent: { ...workflow.orchestration.parent!, runtimeId: "selected-runtime", cwd },
        runtimeHandoff: { id: "initial-cutover", decisionId: decision.decisionId, from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at },
      },
      tasks: workflow.tasks.map((task) => ({ ...task, workspaceReceipt: { ...task.workspaceReceipt!, version: undefined }, integrationReceipt: { ...task.integrationReceipt!, version: undefined } })),
    };
    persist(cwd, workflow as ReturnType<typeof createWorkflow>);
    const empty = readRuntimeSelection(cwd);
    writeRuntimeSelection(cwd, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "initial-cutover", from: "compatibility", to: "v2", preparedWorkflowRevision: workflow.revision, preparedAt: at, selectedAt: at, parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "selected-runtime" } } }, 0, empty.preimageHash!);

    t.mock.method(GitRelevantSourceInspector.prototype, "inspect", (() => ({ hash: "snapshot", head: undefined, branch: undefined, changedPaths: [] })) as never);
    controller = new SharedRuntimeController(captured.pi as never);
    const identity = { sessionId: "session", runtimeId: "context", provider: "openai", model: "test", thinking: "low", branchLength: 0 };
    const selected = await controller.resolve(cwd, identity);
    assert.equal(selected.kind, "v2");
    const workflowPath = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
    const rotated = parseWorkflow(JSON.parse(readFileSync(workflowPath, "utf8")));
    const verificationReady = parseWorkflow({ ...rotated, status: "active", activeTask: "T1", tasks: workflow.tasks });
    writeFileSync(workflowPath, `${JSON.stringify(verificationReady)}\n`);
    await captured.hooks.get("session_start")!({}, ctx);
    const call = await captured.hooks.get("tool_call")!({ toolName: "bash", toolCallId: "late-call", input: { command: "node --version", cwd } }, ctx);
    assert.equal(call, undefined);

    const rollback = await controller.handoff({ cwd, targetRuntime: "compatibility", identity, lifecycleContext: ctx });
    assert.equal(rollback.selectedRuntime, "compatibility");
    const result = await captured.hooks.get("tool_result")!({ toolName: "bash", toolCallId: "late-call", content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content.at(-1).text, /generation changed|rejected verification/i);
    assert.equal(parseWorkflow(JSON.parse(readFileSync(join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json"), "utf8"))).tasks[0]!.evidence.length, 0);
  } finally {
    controller?.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("evicted hook tombstones still fail closed with bounded revocation state", async () => {
  const cwd = repository("pi-swe-hook-eviction-");
  try {
    const captured = harness();
    const hookInspector = { inspect: () => ({ hash: "snapshot", head: undefined, branch: undefined, changedPaths: [] }) } as never;
    const router = registerParentIntegrity(captured.pi as never, { passive: true, authorityFactory: (root) => new ManagedVerificationAuthority(root, hookInspector) });
    const ctx = context(cwd);
    let workflow = verificationWorkflow();
    workflow = {
      ...workflow,
      orchestration: { ...workflow.orchestration, parent: { ...workflow.orchestration.parent!, cwd } },
      tasks: workflow.tasks.map((task) => ({ ...task, workspaceReceipt: { ...task.workspaceReceipt!, version: undefined }, integrationReceipt: { ...task.integrationReceipt!, version: undefined } })),
    };
    persist(cwd, workflow as ReturnType<typeof createWorkflow>);
    await captured.hooks.get("session_start")!({}, ctx);
    router.install(cwd, 1, "runtime-old", "session");
    for (let index = 0; index < 1_025; index += 1) {
      const call = await captured.hooks.get("tool_call")!({ toolName: "bash", toolCallId: `bounded-${index}`, input: { command: "node --version", cwd } }, ctx);
      assert.equal(call, undefined);
      await captured.hooks.get("user_bash")!({}, ctx);
    }
    const evicted = await captured.hooks.get("tool_result")!({ toolName: "bash", toolCallId: "bounded-0", content: [{ type: "text", text: "ok" }], details: { exitCode: 0 }, isError: false }, ctx);
    assert.equal(evicted.isError, true);
    assert.match(evicted.content.at(-1).text, /unknown or evicted protected bash authorization/i);
    assert.equal(parseWorkflow(JSON.parse(readFileSync(join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json"), "utf8"))).tasks[0]!.evidence.length, 0);
    router.invalidate();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("stale closeout grant dies on reload and cannot cross a rollback parent generation", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const check = { command: "node", args: ["--version"] };
  const snapshot = { hash: "snapshot", head: "head", branch: "main", changedPaths: [] as string[], capturedAt: at };
  let base = createWorkflow({ topic: "closeout-grant", goal: "close", now: at, initiativeVerification: [check], tasks: [{ id: "T1", title: "done", writeScope: ["src/**"], nonGoals: [], verification: [check] }] });
  const planReview = { kind: "plan-review", outcome: "approved", summary: "approved", findings: [], provenance: { runId: "plan", role: "plan-reviewer", actorId: "reviewer", leaseId: "lease", leaseFence: 1, contractHash: base.contract.hash, startedAt: at, completedAt: at } };
  base = parseWorkflow({ ...base, status: "paused", planReview, tasks: base.tasks.map((task) => ({ ...task, status: "complete", phase: "historical" })), orchestration: { ...base.orchestration, phase: "initiative-acceptance", parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "runtime-old", cwd: "/repo", claimedAt: at, valid: true } } });
  const workflow = reduceWorkflow(base, { type: "begin-initiative-closeout", snapshot, cumulativeDeltaHash: hashContract("delta"), unresolvedRisks: [], branchLength: 2 }, at).workflow;
  const inspector = { inspect: () => ({ snapshot, cumulativeDelta: "delta", unresolvedRisks: [] as string[] }) };
  const authority = new InitiativeCloseoutAuthority("/repo", inspector, { id: () => "closeout-grant", now: () => at });
  const oldParent = verificationParent();
  const grant = authority.authorize({ workflow, commandLine: renderVerificationCommand(check), toolName: "bash", toolCallId: "closeout-call", parent: oldParent });
  authority.invalidate();
  assert.throws(() => authority.finish({ authorizationId: grant.id, workflow, toolCallId: "closeout-call", exitCode: 0, parent: oldParent }), /reload|forged|stale/i);
  const freshParent = verificationParent("runtime-fresh");
  const rolledBackBase = { ...workflow, closeout: undefined, orchestration: { ...workflow.orchestration, parent: { ...workflow.orchestration.parent!, runtimeId: freshParent.runtimeId } } };
  const rolledBack = reduceWorkflow(rolledBackBase, { type: "begin-initiative-closeout", snapshot, cumulativeDeltaHash: hashContract("delta"), unresolvedRisks: [], branchLength: freshParent.branchLength }, at).workflow;
  const fresh = new InitiativeCloseoutAuthority("/repo", inspector, { id: () => "fresh-closeout" });
  assert.doesNotThrow(() => fresh.authorize({ workflow: rolledBack, commandLine: renderVerificationCommand(check), toolName: "bash", toolCallId: "fresh-call", parent: freshParent }));
});

test("real controller fails closed for malformed selector and workflow-selector mismatch", async () => {
  const malformed = repository("pi-swe-malformed-selector-");
  const mismatch = repository("pi-swe-selector-mismatch-");
  const identity = { sessionId: "session", runtimeId: "context", provider: "openai", model: "test", thinking: "low", branchLength: 0 };
  try {
    writeFileSync(join(malformed, ".git", "pi-swe-runtime-selector"), "not-json\n", { mode: 0o600 });
    const malformedController = new SharedRuntimeController(harness().pi as never);
    const malformedBinding = await malformedController.resolve(malformed, identity);
    assert.equal(malformedBinding.kind, "blocked");
    assert.match(malformedBinding.reason!, /JSON|selector/i);
    malformedController.shutdown();

    const at = new Date().toISOString();
    const decision: Gate2Decision = { decisionId: "decision", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "reviewed" };
    const empty = readRuntimeSelection(mismatch);
    writeRuntimeSelection(mismatch, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "missing-workflow", from: "compatibility", to: "v2", preparedWorkflowRevision: 1, preparedAt: at, selectedAt: at, parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "runtime" } } }, 0, empty.preimageHash!);
    const mismatchController = new SharedRuntimeController(harness().pi as never);
    const mismatchBinding = await mismatchController.resolve(mismatch, identity);
    assert.equal(mismatchBinding.kind, "blocked");
    assert.match(mismatchBinding.reason!, /lacks matching reclaimed durable workflow authority/i);
    mismatchController.shutdown();
  } finally {
    rmSync(malformed, { recursive: true, force: true });
    rmSync(mismatch, { recursive: true, force: true });
  }
});
