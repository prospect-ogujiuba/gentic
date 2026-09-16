import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { listWorkflowTopics } from "../extensions/pi-swe/src/store.ts";
import { createWorkflow, reduceWorkflow, type StageReport } from "../extensions/pi-swe/src/workflow.ts";
import { registerSweWorkflowTool } from "../extensions/pi-swe/src/tool.ts";
import { SweRuntimeRegistry, WorkflowControlService, type WorkflowControlIdentity } from "../extensions/pi-swe/src/ux.ts";
import { hasActiveSweWorkflow } from "../extensions/pi-todo/src/pi/swe-ownership.ts";
import {
  ManagedVerificationAuthority,
  decideManagedToolCall,
  registerParentIntegrity,
  renderVerificationCommand,
  type ParentExecutionIdentity,
  type RelevantSourceInspector,
  type RelevantSourceSnapshot,
} from "../extensions/pi-swe/src/integrity.ts";
import type { Workflow } from "../extensions/pi-swe/src/workflow.ts";
import { GitWorkspaceManager } from "../extensions/pi-swe/src/workspace.ts";

test("workflow ownership scans reject symlinked topic ancestry", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "gentic-workflow-outside-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "workflow.json"), JSON.stringify({ version: 1, status: "complete" }));
    symlinkSync(outside, join(root, "redirect"), "dir");
    assert.throws(() => listWorkflowTopics(cwd), /symlink|incomplete/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /symlink|incomplete/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("todo ownership shares pi-swe discovery and releases blocked workflows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-blocked-"));
  try {
    const now = "2026-09-14T00:00:00.000Z";
    let workflow = createWorkflow({
      topic: "blocked-topic",
      goal: "test ownership",
      now,
      tasks: [{ id: "T1", title: "blocked", assessmentStatus: "assessed", approaches: [], approachReasons: {}, verification: [] }],
    });
    workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
    workflow = reduceWorkflow(workflow, { type: "block", reason: "external" }, now).workflow;
    const topicDir = join(cwd, ".model-artifacts", "initiatives", "blocked-topic");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "workflow.json"), JSON.stringify(workflow));

    const ignoredDir = join(topicDir, "reports", "example");
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(join(ignoredDir, "workflow.json"), JSON.stringify({ ...workflow, status: "active", activeTask: "T1", tasks: [{ ...workflow.tasks[0], status: "active" }] }));
    assert.deepEqual(listWorkflowTopics(cwd), ["blocked-topic"]);
    assert.equal(hasActiveSweWorkflow(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow ownership scans bound wide directory materialization", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-wide-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    mkdirSync(root, { recursive: true });
    for (let index = 0; index <= 1_000; index += 1) writeFileSync(join(root, `.entry-${index}`), "");
    assert.throws(() => listWorkflowTopics(cwd), /entry limit|incomplete/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /entry limit|incomplete/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow contracts reject fabricated echo-style verification checks", () => {
  for (const verification of [
    { command: "echo", args: ["ok"] },
    { command: "printf", args: ["pass"] },
    { command: "true", args: [] },
    { command: "bash", args: ["-c", "echo passed"] },
  ]) assert.throws(() => createWorkflow({ topic: "fake-check", goal: "reject fake checks", tasks: [{ id: "T1", title: "test", writeScope: ["src/**"], nonGoals: [], verification: [verification] }] }), /objective check|fabricated pass/);
});

test("managed parent capability policy is fail-closed across alternate, nested, and dynamic execution tools", () => {
  const planned = { command: "node", args: ["--test", "test/pi-swe-tool.test.ts"] };
  const base = { managed: true, phase: "implementation" as const, planned: [planned], cwd: "/repo", expectedCwd: "/repo" };
  for (const toolName of ["edit", "write", "ctx_execute", "mcp", "mcpScript", "interactive_shell", "powershell", "shell_execute", "multi_tool_use.parallel", "batch", "dynamic_runner", "unknown_tool"]) {
    const decision = decideManagedToolCall({ ...base, toolName, input: {} });
    assert.equal(decision.allow, false, toolName);
  }
  assert.equal(decideManagedToolCall({ ...base, toolName: "read", input: { path: "src/a.ts" } }).allow, true);
  assert.equal(decideManagedToolCall({ ...base, toolName: "bash", input: { command: renderVerificationCommand(planned) } }).allow, false);

  const verification = { ...base, phase: "verification" as const };
  assert.equal(decideManagedToolCall({ ...verification, toolName: "bash", input: { command: renderVerificationCommand(planned) } }).allow, true);
  assert.equal(decideManagedToolCall({ ...verification, toolName: "bash", input: { command: "node --test" } }).allow, false);
  assert.equal(decideManagedToolCall({ ...verification, toolName: "bash", input: { command: `${renderVerificationCommand(planned)} && echo ok` } }).allow, false);
  assert.equal(decideManagedToolCall({ ...verification, toolName: "bash", input: { command: renderVerificationCommand(planned), cwd: "/tmp" } }).allow, false);
  assert.equal(decideManagedToolCall({ ...verification, toolName: "swe_workflow", input: { action: "complete" } }).allow, false);
  assert.equal(decideManagedToolCall({ ...verification, toolName: "swe_workflow", input: { action: "status" } }).allow, true);
});

class SnapshotInspector implements RelevantSourceInspector {
  snapshot: RelevantSourceSnapshot = { hash: "snapshot-integrated", head: "head-1", branch: "main", changedPaths: [] };
  inspect(): RelevantSourceSnapshot { return structuredClone(this.snapshot); }
}

function managedVerificationWorkflow(): Workflow {
  let value = createWorkflow({
    topic: "integrity-test", goal: "verify safely", now: "2026-09-17T00:00:00.000Z",
    tasks: [{ id: "T1", title: "verify", assessmentStatus: "assessed", approaches: [], approachReasons: {}, writeScope: ["src/**", "test/**"], nonGoals: [], verification: [
      { command: "node", args: ["--test", "test/pi-swe-tool.test.ts"] },
      { command: "npm", args: ["run", "typecheck"] },
    ] }],
  });
  value = {
    ...value,
    status: "active",
    activeTask: "T1",
    orchestration: { ...value.orchestration, mode: "multi-agent", phase: "task-execution", parent: { ownerId: "parent-a", sessionId: "session-a", runtimeId: "runtime-a", cwd: "/repo", claimedAt: "2026-09-17T00:00:01.000Z", valid: true } },
    tasks: value.tasks.map((task) => ({
      ...task, status: "active", phase: "verification",
      integrationReceipt: { integrationId: "i1", preSnapshotHash: "before", postSnapshotHash: "snapshot-integrated", patchHash: "patch", integratedAt: "2026-09-17T00:00:02.000Z", version: 1, workspaceId: "ws", resultCommit: "result", resultRef: "refs/result", observedHead: "head-1", observedIndexHash: "index", changedPaths: ["src/a.ts"] },
      workspaceReceipt: { workspaceId: "ws", baselineHash: "before", snapshotHash: "snapshot-integrated", changedPaths: ["src/a.ts"], createdAt: "2026-09-17T00:00:00.000Z", includedUntracked: [], managedPaths: ["src/a.ts"] },
      verificationCheckpoint: { revision: value.revision, at: "2026-09-17T00:00:02.000Z", sessionId: "session-a", branchLength: 4 },
    })),
  };
  return value;
}

const parent = (overrides: Partial<ParentExecutionIdentity> = {}): ParentExecutionIdentity => ({
  ownerId: "parent-a", sessionId: "session-a", runtimeId: "runtime-a", cwd: "/repo", sessionBranchId: "leaf-a", branchLength: 10, ...overrides,
});

test("reload or session replacement invalidates parent authority without transferring stale checkpoints", () => {
  let workflow = createWorkflow({ topic: "parent-lifecycle", goal: "fence parent", tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
  workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent-a", sessionId: "session-a", runtimeId: "runtime-a", cwd: "/repo", claimedAt: "2026-09-17T00:00:00.000Z", valid: true } }, "2026-09-17T00:00:00.000Z").workflow;
  workflow = reduceWorkflow(workflow, { type: "invalidate-parent", ownerId: "parent-a", sessionId: "session-a", runtimeId: "runtime-a", reason: "session reload" }, "2026-09-17T00:00:01.000Z").workflow;
  assert.equal(workflow.orchestration.parent?.valid, false);
  assert.equal(workflow.status, "paused");
  assert.throws(() => reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent-b", sessionId: "session-b", runtimeId: "runtime-b", cwd: "/repo", claimedAt: "2026-09-17T00:00:02.000Z", valid: true } }, "2026-09-17T00:00:02.000Z"), /explicit recovery|invalidated/);
});

test("registered tool-call gate denies direct writes and dynamically registered execution surfaces", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-integrity-hooks-"));
  const workflow = managedVerificationWorkflow();
  const statePath = join(cwd, ".model-artifacts", "initiatives", workflow.topic);
  mkdirSync(statePath, { recursive: true });
  writeFileSync(join(statePath, "workflow.json"), JSON.stringify({ ...workflow, orchestration: { ...workflow.orchestration, parent: undefined } }));
  const handlers = new Map<string, Function[]>();
  let tools = [
    { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
    { name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
  ];
  registerParentIntegrity({
    on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getAllTools: () => tools,
  } as never);
  const toolCall = handlers.get("tool_call")![0]!;
  const ctx = { cwd, sessionManager: { getSessionId: () => "session-a", getBranch: () => [], getLeafId: () => null, getSessionFile: () => undefined } };
  await handlers.get("session_start")![0]!({ reason: "startup" }, ctx);
  for (const toolName of ["edit", "write", "ctx_execute", "mcp", "interactive_shell", "brand_new_executor"]) {
    const blocked = await toolCall({ toolName, toolCallId: `call-${toolName}`, input: {} }, ctx);
    assert.equal(blocked?.block, true, toolName);
  }
  assert.equal(await toolCall({ toolName: "read", toolCallId: "read-1", input: { path: "src/a.ts" } }, ctx), undefined);
  tools = [{ name: "read", sourceInfo: { source: "dynamic-extension", path: "/tmp/override.ts" } }, ...tools.slice(1)];
  const replaced = await toolCall({ toolName: "read", toolCallId: "read-override", input: { path: "src/a.ts" } }, ctx);
  assert.equal(replaced?.block, true);
  assert.match(replaced?.reason, /replaced|untrusted/);

  tools = [
    { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
    { name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
  ];
  const second = { ...workflow, topic: "integrity-test-2" };
  const secondPath = join(cwd, ".model-artifacts", "initiatives", second.topic);
  mkdirSync(secondPath, { recursive: true });
  writeFileSync(join(secondPath, "workflow.json"), JSON.stringify({ ...second, orchestration: { ...second.orchestration, parent: undefined } }));
  const ambiguous = await toolCall({ toolName: "bash", toolCallId: "ambiguous", input: { command: renderVerificationCommand(workflow.tasks[0]!.verification[0]!) } }, ctx);
  assert.equal(ambiguous?.block, true);
  assert.match(ambiguous?.reason, /multiple managed workflows|ambiguous/i);
});

test("protected verification authorization binds exact command, cwd, parent checkpoint, contract, snapshot, and tool provenance", () => {
  const inspector = new SnapshotInspector();
  const authority = new ManagedVerificationAuthority("/repo", inspector, { id: () => "auth-1", now: () => "2026-09-17T00:00:03.000Z" });
  const workflow = managedVerificationWorkflow();
  const planned = workflow.tasks[0]!.verification[0]!;
  const legacyCommand = structuredClone(workflow);
  legacyCommand.tasks[0]!.verification = [{ command: "npm test", args: [] }];
  assert.throws(() => authority.authorize({ workflow: legacyCommand, taskId: "T1", toolName: "bash", toolCallId: "legacy", commandLine: "npm test", parent: parent() }), /shell-safe executable|revise the plan/);
  legacyCommand.tasks[0]!.verification = [{ command: "node;rm", args: ["-rf", "/tmp/x"] }];
  assert.throws(() => authority.authorize({ workflow: legacyCommand, taskId: "T1", toolName: "bash", toolCallId: "injected", commandLine: "node;rm -rf /tmp/x", parent: parent() }), /shell-safe executable|revise the plan/);
  assert.throws(() => authority.authorize({ workflow, taskId: "T1", toolName: "ctx_execute", toolCallId: "call-1", commandLine: renderVerificationCommand(planned), parent: parent() }), /protected bash/i);
  assert.throws(() => authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-1", commandLine: "node --test", parent: parent() }), /planned verification/i);
  assert.throws(() => authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-1", commandLine: renderVerificationCommand(planned), parent: parent({ cwd: "/other" }) }), /cwd|parent/i);
  assert.throws(() => authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-1", commandLine: renderVerificationCommand(planned), parent: parent({ sessionId: "session-b" }) }), /session|parent/i);

  const authorization = authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-1", commandLine: renderVerificationCommand(planned), parent: parent() });
  assert.throws(() => authority.finish({ authorizationId: authorization.id, workflow, taskId: "T1", toolCallId: "forged", exitCode: 0, parent: parent() }), /tool-call provenance/i);
  assert.throws(() => authority.finish({ authorizationId: authorization.id, workflow, taskId: "T1", toolCallId: "call-1", exitCode: 0, parent: parent({ sessionBranchId: "forked-leaf" }) }), /session checkpoint/i);
  const submission = authority.finish({ authorizationId: authorization.id, workflow, taskId: "T1", toolCallId: "call-1", exitCode: 0, parent: parent() });
  assert.deepEqual(submission.evidence.args, planned.args);
  assert.equal(submission.evidence.source?.toolCallId, "call-1");
  assert.equal(submission.evidence.source?.runtimeId, "runtime-a");
  assert.equal(submission.beforeSnapshotHash, "snapshot-integrated");
  assert.equal(submission.afterSnapshotHash, "snapshot-integrated");
  assert.throws(() => authority.consume({ ...submission, authorizationId: "invented" }, workflow, workflow.tasks[0]!, parent()), /forged|stale/i);
  assert.doesNotThrow(() => authority.consume(submission, workflow, workflow.tasks[0]!, parent()));
  assert.throws(() => authority.consume(submission, workflow, workflow.tasks[0]!, parent()), /forged|stale/i);
});

test("newer failures supersede older passes and missing planned checks block completion", () => {
  const inspector = new SnapshotInspector();
  const authority = new ManagedVerificationAuthority("/repo", inspector);
  const workflow = managedVerificationWorkflow();
  const task = workflow.tasks[0]!;
  const provenance = { kind: "bash-tool-result" as const, toolCallId: "call", toolName: "bash" as const, workflowRevision: workflow.revision, sessionId: "session-a", ownerId: "parent-a", runtimeId: "runtime-a", sessionBranchId: "leaf-a", branchLength: 10 };
  const base = { at: "2026-09-17T00:00:03.000Z", contractHash: task.contract.hash, snapshotHash: "snapshot-integrated", cwd: "/repo", branch: "main", head: "head-1", beforeSnapshotHash: "snapshot-integrated", afterSnapshotHash: "snapshot-integrated", source: provenance };
  task.evidence = [
    { ...task.verification[0]!, ...base, exitCode: 0 },
    { ...task.verification[0]!, ...base, exitCode: 1, at: "2026-09-17T00:00:04.000Z", source: { ...provenance, toolCallId: "call-newer" } },
    { ...task.verification[1]!, ...base, exitCode: 0, source: { ...provenance, toolCallId: "call-second" } },
  ];
  assert.throws(() => authority.assertCompletion(workflow, task, parent()), /missing current passing verification/);
  task.evidence = task.evidence.filter((item) => item.command !== "node");
  assert.throws(() => authority.assertCompletion(workflow, task, parent()), /missing current passing verification/);
  task.evidence = task.verification.map((command, index) => ({ ...command, ...base, exitCode: 0, source: { ...provenance, toolCallId: `branch-call-${index}` } }));
  assert.throws(() => authority.assertCompletion(workflow, task, parent({ branchToolCallIds: [] })), /active session branch/);
  inspector.snapshot = { ...inspector.snapshot, branch: "feature" };
  assert.throws(() => authority.assertCompletion(workflow, task, parent({ branchToolCallIds: ["branch-call-0", "branch-call-1"] })), /Git branch changed/);
});

test("Git source inspection fingerprints tracked config, tests, lockfiles, and explicitly included untracked files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-whole-source-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git(["init", "-q"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
  mkdirSync(join(cwd, "src")); mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "config.json"), "{}\n");
  writeFileSync(join(cwd, "test", "a.test.ts"), "// test\n");
  writeFileSync(join(cwd, "package-lock.json"), "{}\n");
  git(["add", "."]); git(["commit", "-qm", "initial"]);
  writeFileSync(join(cwd, "fixture.txt"), "fixture-v1\n");
  const manager = new GitWorkspaceManager(cwd);
  const receipt = manager.createWorkspace({ topic: "whole-source", taskId: "T1", writeScope: ["src/**"], includeUntracked: ["fixture.txt"], workspaceId: "whole-source-ws" });
  writeFileSync(join(receipt.path, "src", "a.ts"), "export const a = 2;\n");
  const prepared = manager.prepareIntegration(receipt);
  const integrated = manager.integrate(prepared, "2026-09-17T00:00:00.000Z");
  assert.equal(manager.inspectVerificationSource(prepared.receipt, integrated).hash, integrated.postSnapshotHash);
  writeFileSync(join(cwd, "config.json"), "{\"changed\":true}\n");
  writeFileSync(join(cwd, "test", "a.test.ts"), "// changed test\n");
  writeFileSync(join(cwd, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(join(cwd, "fixture.txt"), "fixture-v2\n");
  writeFileSync(join(cwd, "new-config.json"), "{\"generated\":true}\n");
  const drift = manager.inspectVerificationSource(prepared.receipt, integrated);
  assert.notEqual(drift.hash, integrated.postSnapshotHash);
  assert.deepEqual(drift.changedPaths, ["config.json", "fixture.txt", "new-config.json", "package-lock.json", "test/a.test.ts"]);
  writeFileSync(join(cwd, "config.json"), "{}\n");
  writeFileSync(join(cwd, "test", "a.test.ts"), "// test\n");
  writeFileSync(join(cwd, "package-lock.json"), "{}\n");
  writeFileSync(join(cwd, "fixture.txt"), "fixture-v1\n");
  rmSync(join(cwd, "new-config.json"));
  manager.cleanup(prepared.receipt, { finalizedIntegration: integrated });
  rmSync(cwd, { recursive: true, force: true });
});

test("whole-source drift and completion-time TOCTOU fail closed", () => {
  const inspector = new SnapshotInspector();
  const authority = new ManagedVerificationAuthority("/repo", inspector, { id: (() => { let n = 0; return () => `auth-${++n}`; })(), now: () => "2026-09-17T00:00:03.000Z" });
  const workflow = managedVerificationWorkflow();
  const command = workflow.tasks[0]!.verification[0]!;
  const authorization = authority.authorize({ workflow, taskId: "T1", toolName: "bash", toolCallId: "call-1", commandLine: renderVerificationCommand(command), parent: parent() });
  inspector.snapshot = { hash: "snapshot-mutated", head: "head-1", branch: "main", changedPaths: ["package-lock.json", "test/pi-swe-tool.test.ts"] };
  const changed = authority.finish({ authorizationId: authorization.id, workflow, taskId: "T1", toolCallId: "call-1", exitCode: 0, parent: parent() });
  assert.equal(changed.sourceChanged, true);
  assert.deepEqual(changed.observedChangedPaths, ["package-lock.json", "test/pi-swe-tool.test.ts"]);
  assert.throws(() => authority.assertCompletion(workflow, workflow.tasks[0]!, parent()), /source snapshot/i);
});

test("bounded workflow ownership scans fail closed when completeness cannot be proven", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-bound-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    for (let index = 0; index <= 100; index += 1) {
      const directory = join(root, `topic-${String(index).padStart(3, "0")}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "workflow.json"), JSON.stringify({ version: 1, status: "complete" }));
    }
    assert.throws(() => listWorkflowTopics(cwd), /scan.*(?:limit|incomplete)|too many workflows/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /scan.*(?:limit|incomplete)|too many workflows/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const UX_NOW = "2026-09-20T00:00:00.000Z";
const UX_IDENTITY: WorkflowControlIdentity = { sessionId: "session-tool", runtimeId: "runtime-tool", provider: "fixture-provider", model: "fixture-model", thinking: "medium", branchLength: 0 };

function uxWorkflow(topic: string) {
  const value = createWorkflow({ topic, goal: "tool parity", now: UX_NOW, tasks: [{ id: "T1", title: "work", assessmentStatus: "assessed", approaches: [], approachReasons: {}, writeScope: ["src/**"], nonGoals: ["no external effects"], verification: [{ command: "node", args: ["--test"] }] }] });
  const report: StageReport = { kind: "plan-review", outcome: "approved", summary: "approved", findings: [], provenance: { runId: "plan", role: "plan-reviewer", actorId: "plan-reviewer:plan", leaseId: "lease-plan", leaseFence: 1, contractHash: value.contract.hash, startedAt: "2026-09-19T23:00:00.000Z", completedAt: "2026-09-19T23:01:00.000Z" } };
  return { ...value, planReview: report };
}

function writeUxWorkflow(cwd: string, value: Workflow) {
  const directory = join(cwd, ".model-artifacts", "initiatives", value.topic);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workflow.json"), `${JSON.stringify(value)}\n`);
}

function toolHarness(cwd: string) {
  let definition: any;
  registerSweWorkflowTool({ registerTool: (value: any) => { definition = value; } } as never);
  const ctx = { cwd, model: { provider: UX_IDENTITY.provider, id: UX_IDENTITY.model }, thinkingLevel: UX_IDENTITY.thinking, sessionManager: { getSessionId: () => UX_IDENTITY.sessionId, getBranch: () => [] } };
  return (params: any) => definition.execute("tool-call", params, new AbortController().signal, undefined, ctx);
}

test("tool start and slash-command control share the same orchestrator ownership and stage service", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-parity-"));
  try {
    writeUxWorkflow(cwd, uxWorkflow("tool-parity"));
    const execute = toolHarness(cwd);
    const result = await execute({ action: "start", topic: "tool-parity" });
    const text = result.content[0].text as string;
    assert.match(text, /Use the v2 OrchestrationEngine/);
    assert.match(text, /do not implement in this parent/);
    assert.match(text, /fixture-provider\/fixture-model/);
    assert.equal(result.details.workflow.status, "active");
    assert.equal(result.details.workflow.activeTask, "T1");
    assert.equal(result.details.workflow.orchestration.phase, "task-execution");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tool status, inspect, and runs use bounded native inspection without attach claims", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-inspect-"));
  try {
    writeUxWorkflow(cwd, uxWorkflow("tool-inspect"));
    const execute = toolHarness(cwd);
    for (const action of ["status", "inspect"] as const) {
      const result = await execute({ action, topic: "tool-inspect" });
      const text = result.content[0].text as string;
      assert.match(text, /stage:/);
      assert.match(text, /retry\/remediation:/);
      assert.match(text, /Native non-PTY runs cannot be opened with interactive-shell \/attach/);
      assert.ok(text.length <= 12_000);
    }
    const runs = await execute({ action: "runs", topic: "tool-inspect" });
    assert.match(runs.content[0].text, /plan.*completed/s);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("expired leases are fenced before tool resume and stale live leases are rejected", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-lease-"));
  try {
    let value = uxWorkflow("tool-lease");
    value = { ...value, status: "paused", activeTask: "T1", tasks: value.tasks.map((task) => ({ ...task, status: "active" as const, phase: "implementation" as const })), orchestration: { ...value.orchestration, phase: "task-execution", activeRun: { id: "old", runId: "orphan", ownerId: "owner", stage: "implementation", taskId: "T1", fence: 1, acquiredAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T01:00:00.000Z" } } };
    writeUxWorkflow(cwd, value);
    const service = new WorkflowControlService(cwd, { runtimes: new SweRuntimeRegistry() });
    const resumed = await service.transition("tool-lease", "resume", UX_IDENTITY);
    assert.equal(resumed.decision.workflow.orchestration.activeRun, undefined);
    assert.ok(resumed.decision.workflow.orchestration.history.some((entry) => entry.type === "run-cancelled" && /orphaned/.test(entry.summary)));

    const current = resumed.decision.workflow;
    const live = { ...current, status: "paused" as const, orchestration: { ...current.orchestration, activeRun: { id: "live", runId: "live-child", ownerId: "owner", stage: "implementation" as const, taskId: "T1", fence: current.orchestration.nextFence, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } } };
    writeUxWorkflow(cwd, live);
    await assert.rejects(() => service.transition("tool-lease", "resume", UX_IDENTITY), /still active/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("pause and stop preserve workflow evidence while distinguishing interrupted and cancelled runtime outcomes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-stop-"));
  try {
    const registry = new SweRuntimeRegistry();
    const value = uxWorkflow("tool-stop");
    writeUxWorkflow(cwd, value);
    const controller = new AbortController();
    registry.begin({ topic: value.topic, runId: "child", role: "implementer", stage: "implementation", provider: "p", model: "m", startedAt: UX_NOW, outcome: "running", controller });
    const control = new WorkflowControlService(cwd, { runtimes: registry });
    await control.transition(value.topic, "pause", UX_IDENTITY);
    assert.equal(controller.signal.aborted, true);
    assert.equal(registry.list(value.topic)[0]!.outcome, "interrupted");
    assert.equal(control.mutations.read(value.topic)!.workflow.planReview?.summary, "approved");

    const second = new AbortController();
    registry.begin({ topic: value.topic, runId: "child-2", role: "implementer", stage: "implementation", provider: "p", model: "m", startedAt: UX_NOW, outcome: "running", controller: second });
    await control.transition(value.topic, "stop", UX_IDENTITY);
    assert.equal(registry.list(value.topic).find((run) => run.runId === "child-2")!.outcome, "cancelled");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("dismissing runtime output never removes accepted workflow report metadata", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-tool-dismiss-"));
  try {
    writeUxWorkflow(cwd, uxWorkflow("tool-dismiss"));
    const registry = new SweRuntimeRegistry();
    registry.begin({ topic: "tool-dismiss", runId: "plan", role: "plan-reviewer", stage: "plan-review", provider: "p", model: "m", startedAt: UX_NOW, outcome: "completed" });
    assert.equal(registry.dismiss("tool-dismiss", "plan"), true);
    assert.equal(new WorkflowControlService(cwd).mutations.read("tool-dismiss")!.workflow.planReview?.provenance.runId, "plan");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
