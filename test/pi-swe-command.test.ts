import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { completeSweArgument, registerSweCommand } from "../extensions/pi-swe/src/command.ts";
import { createWorkflow, type StageReport, type Workflow } from "../extensions/pi-swe/src/workflow.ts";
import { assessRecovery, renderRunTails, renderWorkflowInspection, SweRuntimeRegistry, WorkflowControlService, type WorkflowControlIdentity } from "../extensions/pi-swe/src/ux.ts";

const NOW = "2026-09-20T00:00:00.000Z";
const identity: WorkflowControlIdentity = { sessionId: "session-a", runtimeId: "runtime-a", provider: "fixture-provider", model: "fixture-model", thinking: "low", branchLength: 3 };

function workflow(topic = "command-fixture"): Workflow {
  const value = createWorkflow({
    topic, goal: "exercise command recovery", now: NOW,
    tasks: [{ id: "T1", title: "implement", assessmentStatus: "assessed", approaches: ["operations"], approachReasons: { operations: "recovery" }, writeScope: ["src/**"], nonGoals: ["no release"], verification: [{ command: "node", args: ["--test"] }] }],
  });
  const planReview: StageReport = {
    kind: "plan-review", outcome: "approved", summary: "plan approved", findings: [],
    provenance: { runId: "plan-run", role: "plan-reviewer", actorId: "plan-reviewer:plan-run", leaseId: "plan-lease", leaseFence: 1, contractHash: value.contract.hash, startedAt: "2026-09-19T23:58:00.000Z", completedAt: "2026-09-19T23:59:00.000Z" },
  };
  return { ...value, planReview };
}

function fixture(value = workflow()) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-command-"));
  const directory = join(cwd, ".model-artifacts", "initiatives", value.topic);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workflow.json"), `${JSON.stringify(value)}\n`);
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function commandHarness(cwd: string, decisions: { input?: string; confirm?: boolean; select?: string } = {}) {
  let definition: { handler: (raw: string, ctx: any) => Promise<void> } | undefined;
  const messages: string[] = [];
  const notifications: string[] = [];
  registerSweCommand({
    registerCommand: (_name: string, value: typeof definition) => { definition = value; },
    sendUserMessage: (message: string) => { messages.push(message); },
  } as never);
  const ctx = {
    cwd, hasUI: true, model: { provider: identity.provider, id: identity.model }, thinkingLevel: identity.thinking,
    sessionManager: { getSessionId: () => identity.sessionId, getBranch: () => [{}, {}, {}] },
    ui: {
      notify: (message: string) => { notifications.push(message); },
      input: async () => decisions.input,
      confirm: async () => decisions.confirm ?? false,
      select: async () => decisions.select,
    },
  };
  return { handler: (raw: string) => definition!.handler(raw, ctx), messages, notifications };
}

test("command autocomplete exposes keyboard-addressable status, inspect, runs, pause, stop, and resume", () => {
  const values = completeSweArgument("work ")!.map((item) => item.value);
  for (const expected of ["work status", "work inspect", "work runs", "work start", "work resume", "work pause", "work stop"]) assert.ok(values.includes(expected));
});

test("/swe work start emits an orchestrator prompt and never a single-parent implementation fallback", async () => {
  const f = fixture();
  try {
    const harness = commandHarness(f.cwd);
    await harness.handler("work start command-fixture");
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0]!, /Use the v2 OrchestrationEngine/);
    assert.match(harness.messages[0]!, /do not implement in this parent/);
    assert.match(harness.messages[0]!, /fixture-provider\/fixture-model/);
    assert.match(harness.messages[0]!, /interactive-shell \/attach does not apply/);
    assert.doesNotMatch(harness.messages[0]!, /call swe_workflow action=complete/);
  } finally { f.cleanup(); }
});

test("/swe work resume emits the same orchestrator contract", async () => {
  const value = { ...workflow(), status: "paused" as const };
  const f = fixture(value);
  try {
    const harness = commandHarness(f.cwd);
    await harness.handler("work resume command-fixture");
    assert.match(harness.messages[0]!, /Orchestrate pi-swe workflow command-fixture/);
    assert.match(harness.messages[0]!, /fresh role children/);
  } finally { f.cleanup(); }
});

test("status and inspection are bounded and expose required operational fields without transcripts", () => {
  const value = workflow();
  value.status = "active";
  value.activeTask = "T1";
  value.tasks[0]!.status = "active";
  value.tasks[0]!.phase = "implementation";
  value.tasks[0]!.findings = Array.from({ length: 30 }, (_, index) => ({ id: `F${index}`, severity: "warning" as const, status: "open" as const, summary: `finding ${index} ${"x".repeat(500)}`, evidence: "bounded" }));
  const text = renderWorkflowInspection(value, [], identity, new Date(NOW));
  for (const label of ["stage:", "run:", "role:", "provider/model:", "elapsed:", "outcome:", "findings:", "clarifications:", "retry/remediation:", "workspace:", "next:"]) assert.match(text, new RegExp(label));
  assert.ok(text.length <= 12_000);
  assert.doesNotMatch(text, /full transcript/i);
  assert.match(text, /Native non-PTY runs cannot be opened with interactive-shell \/attach/);
});

test("pause and stop abort active children before awaiting workflow mutation", async () => {
  const registry = new SweRuntimeRegistry();
  const controller = new AbortController();
  registry.begin({ topic: "command-fixture", runId: "child-1", role: "implementer", stage: "implementation", taskId: "T1", provider: "p", model: "m", startedAt: NOW, outcome: "running", controller });
  assert.equal(registry.signal("command-fixture", "interrupted"), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.list("command-fixture")[0]!.outcome, "interrupted");
  registry.settle("command-fixture", "child-1", { outcome: "completed", completedAt: NOW, reportTail: "late success" });
  assert.equal(registry.list("command-fixture")[0]!.outcome, "interrupted", "a terminated child must not become successful after a late exit");
});

test("recovery reports orphan leases, prepared integration, unconsumed answers, and interrupted acceptance", () => {
  const value = workflow();
  value.status = "paused";
  value.activeTask = "T1";
  value.orchestration.phase = "initiative-acceptance";
  value.orchestration.activeRun = { id: "lease", runId: "orphan", ownerId: "parent", stage: "implementation", taskId: "T1", fence: 2, acquiredAt: "2026-09-19T20:00:00.000Z", expiresAt: "2026-09-19T21:00:00.000Z" };
  value.tasks[0]!.workspaceReceipt = { workspaceId: "ws", baselineHash: "before", snapshotHash: "after", changedPaths: ["src/a.ts"], createdAt: NOW, preparedResultRef: "refs/pi-swe/results/ws" };
  value.tasks[0]!.clarifications = [{ id: "Q1", question: "choose?", askedByRunId: "run-q", askedAt: NOW, answer: "yes", answeredBy: "user", answeredAt: NOW }];
  value.closeout = { snapshot: { hash: "s", head: "h", branch: "main", changedPaths: [], capturedAt: NOW }, cumulativeDeltaHash: `sha256:${"a".repeat(64)}`, checkpoint: { revision: 2, at: NOW, ownerId: "o", sessionId: "s", runtimeId: "r", branchLength: 1 }, evidence: [], unresolvedRisks: [], blockingRisks: [], followUpTaskIds: [] };
  const recovery = assessRecovery(value, new Date(NOW));
  assert.match(recovery.issues.join("\n"), /expired\/orphaned lease/);
  assert.match(recovery.issues.join("\n"), /prepared integration/);
  assert.match(recovery.issues.join("\n"), /unconsumed/);
  assert.match(recovery.issues.join("\n"), /acceptance was interrupted/);
});

test("run tails distinguish outcomes, remain bounded, and explain non-PTY inspection", () => {
  const registry = new SweRuntimeRegistry();
  for (const outcome of ["cancelled", "interrupted", "crashed", "timed-out", "changes-requested", "blocked", "completed"] as const) {
    registry.begin({ topic: "command-fixture", runId: outcome, stage: "implementation", role: "implementer", provider: "p", model: "m", startedAt: NOW, outcome, reportTail: "r".repeat(20_000), outputTail: "o".repeat(20_000) });
  }
  const text = renderRunTails(workflow(), registry.list("command-fixture"), new Date(NOW));
  for (const outcome of ["cancelled", "interrupted", "crashed", "timed-out", "changes-requested", "blocked", "completed"]) assert.match(text, new RegExp(outcome));
  assert.ok(text.length <= 16_000);
});

test("dismissing exited runtime entries cannot delete durable accepted report metadata", () => {
  const registry = new SweRuntimeRegistry();
  registry.begin({ topic: "command-fixture", runId: "plan-run", role: "plan-reviewer", stage: "plan-review", provider: "p", model: "m", startedAt: NOW, outcome: "completed" });
  assert.equal(registry.dismiss("command-fixture", "plan-run"), true);
  assert.equal(registry.list("command-fixture").length, 0);
  assert.equal(workflow().planReview?.provenance.runId, "plan-run");
});

test("interactive reset flow requires keyboard confirmation and records audited retry budget", async () => {
  const value = workflow();
  value.status = "blocked";
  value.tasks[0]!.status = "blocked";
  value.tasks[0]!.phase = "remediation";
  value.tasks[0]!.remediation = { used: 2, max: 2 };
  const f = fixture(value);
  try {
    const harness = commandHarness(f.cwd, { input: "one bounded retry", confirm: true });
    await harness.handler("work reset command-fixture");
    const current = new WorkflowControlService(f.cwd).mutations.read("command-fixture")!.workflow;
    assert.deepEqual(current.tasks[0]!.remediation, { used: 2, max: 3 });
    assert.ok(current.orchestration.history.some((entry) => entry.type === "remediation-reset" && /interactive-user/.test(entry.summary)));
  } finally { f.cleanup(); }
});

test("resume explicitly reclaims invalidated parent ownership and stales sensitive checkpoints", async () => {
  const value = workflow();
  value.status = "paused";
  value.activeTask = "T1";
  value.tasks[0]!.status = "active";
  value.tasks[0]!.phase = "verification";
  value.tasks[0]!.evidence = [{ command: "node", args: ["--test"], exitCode: 0, at: NOW }];
  const f = fixture(value);
  try {
    const stored = new WorkflowControlService(f.cwd).mutations.read("command-fixture")!.workflow;
    stored.orchestration.parent = { ownerId: "old", sessionId: "old-session", runtimeId: "old-runtime", cwd: f.cwd, claimedAt: NOW, valid: false, invalidatedAt: NOW, invalidatedReason: "restart" };
    writeFileSync(join(f.cwd, ".model-artifacts", "initiatives", "command-fixture", "workflow.json"), `${JSON.stringify(stored)}\n`);
    const resumed = await new WorkflowControlService(f.cwd).transition("command-fixture", "resume", identity);
    assert.equal(resumed.decision.workflow.orchestration.parent?.ownerId, `parent:${identity.sessionId}`);
    assert.equal(resumed.decision.workflow.orchestration.parent?.valid, true);
    assert.equal(resumed.decision.workflow.tasks[0]!.evidence.length, 0);
    assert.ok(resumed.decision.workflow.orchestration.history.some((entry) => entry.type === "parent-recovered"));
  } finally { f.cleanup(); }
});
