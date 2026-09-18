import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CUTOVER_RELEASE_CHECK_MANIFEST,
  captureCutoverRuntimeSelector,
  cutoverMigrationRemediation,
  evaluateCutoverReadiness,
  formatCutoverReadiness,
  inspectCutoverReadiness,
  rollbackCutoverRuntime,
  selectCutoverRuntime,
  type CutoverInspectionInput,
  type CutoverReadinessObservation,
} from "../extensions/pi-swe/src/cutover.ts";
import { applyWorkflowMigration, inventoryWorkflowMigrations, planWorkflowMigration, recoverWorkflowMigration, rollbackWorkflowMigration, workflowMigrationReceiptPath, type WorkflowMigrationDisposition } from "../extensions/pi-swe/src/migration.ts";
import { renderVerificationCommand, type ParentExecutionIdentity, type RelevantSourceSnapshot } from "../extensions/pi-swe/src/integrity.ts";
import type { AgentRunRequest, RunnerResult } from "../extensions/pi-swe/src/runner.ts";
import type { OrchestrationRunner, OrchestrationWorkspace } from "../extensions/pi-swe/src/orchestration.ts";
import { createWorkflow, reduceWorkflow, type StageReport, type Workflow } from "../extensions/pi-swe/src/workflow.ts";
import type { GitIntegrationReceipt, GitWorkspaceReceipt, PreparedIntegration } from "../extensions/pi-swe/src/workspace.ts";

const CANONICAL_WORKFLOW_CONTRACT = { revision: 6, hash: "sha256:3894b64f481fc360ba799bba914eeb08f88e1f85b18fad6d33b5e2e25c47f78f" } as const;
const CANONICAL_MIGRATION_CONTRACT = { revision: 6, hash: "sha256:8b28d01b0ca3feb60e0a139cad5256e8301f0c69c5c6f8f9791ed6c659abe134" } as const;
const CANONICAL_ACTIVATION_CONTRACT = { revision: 6, hash: "sha256:e6efba1a17d67dc23e60ffc9bac8095fa148fc84315b586bdc7540243cfb9efb" } as const;
const canonicalWorkflow = JSON.parse(readFileSync(new URL("../.model-artifacts/initiatives/swe-production-rollout/workflow.json", import.meta.url), "utf8")) as ReturnType<typeof createWorkflow>;

const releaseChecks = () => CUTOVER_RELEASE_CHECK_MANIFEST.map(({ name }) => ({ name, passed: true }));

const passingObservation = (): CutoverReadinessObservation => ({
  migrationContractComplete: true,
  activationContractComplete: true,
  migrationAuditClean: true,
  gitClean: true,
  nodeSupported: true,
  piSupported: true,
  activeWorkflowTopics: ["swe-production-rollout"],
  controllingTopic: "swe-production-rollout",
  activeTodoCount: 0,
  recoveryClean: true,
  releaseChecks: releaseChecks(),
});

function writeJson(cwd: string, path: string, value: unknown): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function qualifiedWorkflow(): ReturnType<typeof createWorkflow> {
  const workflow = structuredClone(canonicalWorkflow);
  assert.deepEqual(workflow.contract, CANONICAL_WORKFLOW_CONTRACT);
  for (const [id, contract] of [
    ["migration-qualification", CANONICAL_MIGRATION_CONTRACT],
    ["activation-qualification", CANONICAL_ACTIVATION_CONTRACT],
  ] as const) {
    const task = workflow.tasks.find((candidate) => candidate.id === id);
    assert.ok(task);
    assert.deepEqual(task.contract, contract);
    task.status = "complete";
    task.phase = "historical";
  }
  return workflow;
}

function createQualifiedRepository(prefix = "pi-swe-cutover-", mutate?: (workflow: ReturnType<typeof createWorkflow>) => void): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const workflow = qualifiedWorkflow();
  mutate?.(workflow);
  writeJson(cwd, ".model-artifacts/initiatives/swe-production-rollout/workflow.json", workflow);
  writeFileSync(join(cwd, "tracked.txt"), "clean\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Cutover Test");
  git(cwd, "config", "user.email", "cutover@example.invalid");
  git(cwd, "config", "maintenance.auto", "false");
  git(cwd, "config", "gc.auto", "0");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

function inspectionInput(overrides: Partial<CutoverInspectionInput> = {}): CutoverInspectionInput {
  return {
    activeTodoCount: 0,
    nodeVersion: "v22.19.0",
    nodeSupport: ">=22.19.0",
    piVersions: ["0.84.2", "0.84.2", "0.84.2"],
    expectedPiVersion: "0.84.2",
    releaseChecks: releaseChecks(),
    ...overrides,
  };
}

function tree(cwd: string): string[] {
  const output: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      output.push(`${entry.isDirectory() ? "d" : "f"}:${path}`);
      if (entry.isDirectory()) visit(join(directory, entry.name), path);
    }
  };
  visit(cwd);
  return output;
}

function failedGate(report: ReturnType<typeof evaluateCutoverReadiness>, id: string): boolean {
  return report.categories.some((category) => category.gates.some((gate) => gate.id === id && gate.status === "failed"));
}

test("cutover readiness reports four independent categories without granting activation", () => {
  const first = evaluateCutoverReadiness(passingObservation());
  const second = evaluateCutoverReadiness(passingObservation());

  assert.deepEqual(first, second);
  assert.equal(first.ready, true);
  assert.equal(first.activatesRuntime, false);
  assert.deepEqual(first.categories.map(({ id, status }) => [id, status]), [
    ["code", "ready"],
    ["repository-migration", "ready"],
    ["runtime-activation", "ready"],
    ["external-release-authorization", "pending"],
  ]);
  assert.match(first.nextAction, /separate operator cutover decision/i);
  assert.match(formatCutoverReadiness(first), /evidence only; runtime activation remains unchanged/i);
});

test("every required technical gate fails closed with bounded output and exactly one next action", () => {
  const cases: Array<[string, (value: CutoverReadinessObservation) => void]> = [
    ["clean Git", (value) => { value.gitClean = false; }],
    ["supported Node", (value) => { value.nodeSupported = false; }],
    ["supported Pi", (value) => { value.piSupported = false; }],
    ["release checks", (value) => { value.releaseChecks[0] = { ...value.releaseChecks[0]!, passed: false }; }],
    ["migration contract", (value) => { value.migrationContractComplete = false; }],
    ["migration audit", (value) => { value.migrationAuditClean = false; }],
    ["active workflow", (value) => { value.activeWorkflowTopics.push("other-work"); }],
    ["activation contract", (value) => { value.activationContractComplete = false; }],
    ["active todo", (value) => { value.activeTodoCount = 1; }],
    ["recovery", (value) => { value.recoveryClean = false; }],
  ];

  for (const [name, mutate] of cases) {
    const observation = passingObservation();
    mutate(observation);
    const report = evaluateCutoverReadiness(observation);
    const output = formatCutoverReadiness(report);
    assert.equal(report.ready, false, name);
    assert.equal(report.activatesRuntime, false, name);
    assert.equal(report.nextAction.length > 0, true, name);
    assert.equal((output.match(/^Next action:/gm) ?? []).length, 1, name);
    assert.equal(Buffer.byteLength(output) <= 4096, true, name);
  }
});

test("release checks must match the exact required manifest", () => {
  const exact = passingObservation();
  assert.equal(evaluateCutoverReadiness(exact).ready, true);

  const cases: Array<[string, typeof exact.releaseChecks]> = [
    ["omitted", exact.releaseChecks.slice(0, -1)],
    ["duplicate", exact.releaseChecks.map((check, index) => index === 1 ? { ...exact.releaseChecks[0]! } : check)],
    ["substituted", exact.releaseChecks.map((check, index) => index === 1 ? { name: "npm run substituted", passed: true } : check)],
    ["unexpected", [...exact.releaseChecks, { name: "npm run extra", passed: true }]],
    ["reordered", [exact.releaseChecks[1]!, exact.releaseChecks[0]!, ...exact.releaseChecks.slice(2)]],
  ];
  for (const [name, checks] of cases) {
    const observation = passingObservation();
    observation.releaseChecks = checks;
    const report = evaluateCutoverReadiness(observation);
    assert.equal(report.ready, false, name);
    assert.equal(failedGate(report, "release-checks"), true, name);
  }
});

test("repository inspection is deterministic and read-only", () => {
  const cwd = createQualifiedRepository();
  try {
    const before = tree(cwd);
    const first = inspectCutoverReadiness(cwd, inspectionInput());
    const second = inspectCutoverReadiness(cwd, inspectionInput());
    assert.deepEqual(first, second);
    assert.equal(first.ready, true);
    assert.deepEqual(tree(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repository inspection requires exact canonical workflow and prerequisite contract identities", () => {
  const wrongHash = `sha256:${"a".repeat(64)}`;
  const cases: Array<[string, (workflow: ReturnType<typeof createWorkflow>) => void]> = [
    ["substituted workflow contract", (workflow) => {
      workflow.contract = { revision: 7, hash: wrongHash };
      for (const task of workflow.tasks) delete (task as Partial<typeof task>).contract;
    }],
    ["missing workflow contract", (workflow) => { delete (workflow as Partial<typeof workflow>).contract; }],
    ["wrong workflow revision", (workflow) => { workflow.contract.revision = 5; }],
    ["wrong workflow hash", (workflow) => {
      workflow.contract.hash = wrongHash;
      for (const task of workflow.tasks) delete (task as Partial<typeof task>).contract;
    }],
    ["missing migration task contract", (workflow) => {
      const task = workflow.tasks.find(({ id }) => id === "migration-qualification")!;
      delete (task as Partial<typeof task>).contract;
    }],
    ["wrong migration task revision", (workflow) => {
      workflow.tasks.find(({ id }) => id === "migration-qualification")!.contract.revision = 5;
    }],
    ["wrong migration task hash", (workflow) => {
      const task = workflow.tasks.find(({ id }) => id === "migration-qualification")!;
      task.title = "substituted migration qualification";
      delete (task as Partial<typeof task>).contract;
    }],
    ["valid migration and substituted activation task", (workflow) => {
      const task = workflow.tasks.find(({ id }) => id === "activation-qualification")!;
      task.title = "substituted activation qualification";
      delete (task as Partial<typeof task>).contract;
    }],
  ];

  for (const [name, mutate] of cases) {
    const cwd = createQualifiedRepository(`pi-swe-cutover-contract-${name.replaceAll(" ", "-")}-`, mutate);
    try {
      const before = tree(cwd);
      const report = inspectCutoverReadiness(cwd, inspectionInput());
      const output = formatCutoverReadiness(report);
      assert.equal(report.ready, false, name);
      assert.equal(report.activatesRuntime, false, name);
      assert.equal((output.match(/^Next action:/gm) ?? []).length, 1, name);
      assert.equal(Buffer.byteLength(output) <= 4096, true, name);
      assert.doesNotMatch(output, /sha256:|substituted migration|substituted activation|stack/i, name);
      assert.deepEqual(tree(cwd), before, name);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("Git cleanliness gate rejects unstaged, staged, and untracked changes", () => {
  const cwd = createQualifiedRepository("pi-swe-cutover-dirty-");
  try {
    writeFileSync(join(cwd, "tracked.txt"), "unstaged\n");
    let report = inspectCutoverReadiness(cwd, inspectionInput());
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "clean-git"), true);

    git(cwd, "checkout", "--", "tracked.txt");
    writeFileSync(join(cwd, "tracked.txt"), "staged\n");
    git(cwd, "add", "tracked.txt");
    report = inspectCutoverReadiness(cwd, inspectionInput());
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "clean-git"), true);

    git(cwd, "reset", "--hard", "-q", "HEAD");
    writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
    report = inspectCutoverReadiness(cwd, inspectionInput());
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "clean-git"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Git inspection failures are redacted and fail closed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-cutover-no-git-"));
  try {
    writeJson(cwd, ".model-artifacts/initiatives/swe-production-rollout/workflow.json", qualifiedWorkflow());
    const report = inspectCutoverReadiness(cwd, inspectionInput());
    const output = formatCutoverReadiness(report);
    assert.equal(report.ready, false);
    assert.doesNotMatch(output, /not a git repository|fatal:|stack/i);
    assert.equal(Buffer.byteLength(output) <= 4096, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("retained intents are discovered in normal and linked-worktree Git common directories", () => {
  const cwd = createQualifiedRepository("pi-swe-cutover-intent-");
  const linkedParent = mkdtempSync(join(tmpdir(), "pi-swe-cutover-linked-parent-"));
  const linked = join(linkedParent, "linked");
  try {
    mkdirSync(join(cwd, ".git/pi-swe-intents"), { recursive: true });
    writeJson(cwd, ".git/pi-swe-intents/normal.json", { retained: true });
    let report = inspectCutoverReadiness(cwd, inspectionInput());
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "recovery-state"), true);

    rmSync(join(cwd, ".git/pi-swe-intents"), { recursive: true, force: true });
    git(cwd, "worktree", "add", "-q", "--detach", linked);
    mkdirSync(join(cwd, ".git/pi-swe-intents"), { recursive: true });
    writeJson(cwd, ".git/pi-swe-intents/linked.json", { retained: true });
    assert.equal(readFileSync(join(linked, ".git"), "utf8").startsWith("gitdir:"), true);
    report = inspectCutoverReadiness(linked, inspectionInput());
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "recovery-state"), true);
  } finally {
    rmSync(linkedParent, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the controlling authority cannot be substituted", () => {
  const observation = passingObservation();
  observation.controllingTopic = "other-controller";
  observation.activeWorkflowTopics = ["other-controller"];
  assert.equal(evaluateCutoverReadiness(observation).ready, false);

  const cwd = createQualifiedRepository("pi-swe-cutover-controller-");
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const other = createWorkflow({
      topic: "other-controller",
      goal: "must remain visible",
      now,
      tasks: [{ id: "work", title: "active work", writeScope: ["src/**"], nonGoals: [], verificationDecision: { kind: "manual", rationale: "fixture", decidedBy: "fixture", at: now } }],
    });
    other.status = "active";
    other.activeTask = "work";
    other.orchestration.phase = "task-execution";
    other.tasks[0]!.status = "active";
    other.tasks[0]!.phase = "implementation";
    writeJson(cwd, ".model-artifacts/initiatives/other-controller/workflow.json", other);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add active controller fixture");

    const substituted = { ...inspectionInput(), controllingTopic: "other-controller" } as CutoverInspectionInput & { controllingTopic: string };
    const report = inspectCutoverReadiness(cwd, substituted);
    assert.equal(report.ready, false);
    assert.equal(failedGate(report, "exclusive-workflow-authority"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Node support follows stable semver boundaries and rejects prereleases", () => {
  const cwd = createQualifiedRepository("pi-swe-cutover-node-");
  try {
    for (const [version, expected] of [
      ["v22.18.99", false],
      ["v22.19.0-rc.1", false],
      ["v22.19.0", true],
      ["22.19.1", true],
      ["v23.0.0", true],
      ["v24.0.0+build.1", true],
      ["v022.19.0", false],
      ["v22.19", false],
    ] as const) {
      assert.equal(inspectCutoverReadiness(cwd, inspectionInput({ nodeVersion: version })).ready, expected, version);
    }
    assert.equal(inspectCutoverReadiness(cwd, inspectionInput({ nodeSupport: ">=20" })).ready, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing or malformed repository authority fails closed without exposing parser details", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-cutover-invalid-"));
  try {
    git(cwd, "init", "-q");
    writeJson(cwd, ".model-artifacts/initiatives/swe-production-rollout/workflow.json", { token: "do-not-report" });
    const report = inspectCutoverReadiness(cwd, inspectionInput());
    const output = formatCutoverReadiness(report);
    assert.equal(report.ready, false);
    assert.doesNotMatch(output, /do-not-report|invalid workflow state|stack/i);
    assert.equal(Buffer.byteLength(output) <= 4096, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

type RehearsalCase = {
  id: string;
  migrationCaseId?: string;
  kind: string;
  disposition?: WorkflowMigrationDisposition;
  remediation?: string;
};

type MigrationCorpusCase = { id: string; kind: string; expected: string };
type RehearsalHarness = {
  options: Record<string, unknown>;
  runtime?: any;
  activation?: { active: boolean; invalidate?: () => void };
};

const rehearsalCorpus = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-cutover/corpus.json", import.meta.url), "utf8")) as { schemaVersion: number; cases: RehearsalCase[] };
const migrationCorpus = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-migration/corpus.json", import.meta.url), "utf8")) as { schemaVersion: number; cases: MigrationCorpusCase[] };
const rehearsalAt = "2026-09-17T08:00:00.000Z";
function rehearsalAuthorization(cwd: string, topic: string, disposition: "continue" | "reopen" | "grandfather-read-only") {
  return {
    authorizedBy: "non-production-cutover-rehearsal",
    authorizedAt: rehearsalAt,
    auditHash: inventoryWorkflowMigrations(cwd).audit.hash,
    topicDispositions: { [topic]: disposition },
    rollbackRetentionUntil: "2099-09-17T08:00:00.000Z",
    rationale: "Disposable-checkout cutover rehearsal fixture only.",
  };
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function legacyWorkflowFixture(topic: string, status: string): Record<string, unknown> {
  return {
    version: 1,
    topic,
    revision: 3,
    status,
    goal: `rehearse ${topic}`,
    updatedAt: rehearsalAt,
    tasks: [{
      id: "T1",
      title: "task 1",
      status: status === "complete" ? "complete" : status === "active" ? "active" : status === "blocked" ? "blocked" : "pending",
      dependsOn: [],
      acceptance: ["rehearsal stage is retained"],
      approaches: ["tdd"],
      approachReasons: { tdd: "the rehearsal is deterministic" },
      assessmentStatus: "assessed",
      writeScope: ["src/**"],
      nonGoals: ["no release"],
      verification: [{ command: "node", args: ["--version"] }],
      evidence: [],
    }],
  };
}

function rawGit(cwd: string, ...args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return result.stdout;
}

function snapshotRetainedState(cwd: string): Map<string, string> {
  const roots = [
    ".model-artifacts/initiatives/swe-production-rollout/workflow.json",
    ".model-artifacts/system/logs/pi-swe-migration",
    ".model-artifacts/system/logs/workspaces",
    ".git/pi-swe-intents",
    ".git/pi-swe-runtime-selector",
  ];
  const snapshot = new Map<string, string>();
  let entries = 0;
  const visit = (relative: string): void => {
    const absolute = join(cwd, relative);
    if (!existsSync(absolute)) {
      snapshot.set(relative, "absent");
      return;
    }
    const stat = lstatSync(absolute);
    entries += 1;
    assert.ok(entries <= 2_000, "retained-state snapshot exceeded its entry bound");
    if (stat.isSymbolicLink()) {
      snapshot.set(relative, "symlink");
      return;
    }
    if (stat.isFile()) {
      snapshot.set(relative, `${stat.mode & 0o777}:${digest(readFileSync(absolute))}`);
      return;
    }
    snapshot.set(relative, "directory");
    for (const child of readdirSync(absolute).sort()) visit(`${relative}/${child}`);
  };
  for (const root of roots) visit(root);
  return snapshot;
}

function fakePi(registrations: string[]) {
  return {
    registerCommand: (name: string) => { registrations.push(`command:${name}`); },
    registerTool: (tool: { name: string }) => { registrations.push(`tool:${tool.name}`); },
    on: (name: string) => { registrations.push(`hook:${name}`); },
    getAllTools: () => ["read", "grep", "find", "ls", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
  };
}

function runnerReport(request: AgentRunRequest): StageReport {
  const kind = request.role === "plan-reviewer" ? "plan-review" : request.role === "implementer" ? "implementation" : request.role === "general-reviewer" ? "general-review" : request.role === "concern-reviewer" ? "concern-review" : "final-acceptance";
  const now = new Date().toISOString();
  return {
    kind,
    outcome: request.role === "implementer" ? "completed" : "approved",
    summary: `${request.role} accepted deterministic cutover rehearsal`,
    ...(request.role === "implementer" ? { changedPaths: ["src/rehearsal.ts"] } : {}),
    findings: [],
    provenance: {
      runId: request.runId,
      role: request.role,
      actorId: request.actorId,
      leaseId: request.lease.id,
      leaseFence: request.lease.fence,
      contractHash: request.contractPacket.hash,
      ...(request.snapshotPacket ? { snapshotHash: request.snapshotPacket.hash } : {}),
      startedAt: now,
      completedAt: now,
    },
  };
}

class RehearsalRunner implements OrchestrationRunner {
  readonly requests: AgentRunRequest[] = [];
  async run(request: AgentRunRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    return { ok: true, report: runnerReport(request), effectiveConfig: {} as never, attempts: 1 };
  }
}

class RehearsalWorkspace implements OrchestrationWorkspace {
  readonly cwd: string;
  private sequence = 0;
  constructor(cwd: string) { this.cwd = cwd; }
  createWorkspace(input: { topic: string; taskId: string; writeScope: string[] }): GitWorkspaceReceipt {
    this.sequence += 1;
    return this.receipt(`workspace-${this.sequence}`, input, `sha256:baseline-${this.sequence}`);
  }
  createRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt): GitWorkspaceReceipt {
    return this.receipt(`remediation-${++this.sequence}`, receipt, integrated.postSnapshotHash);
  }
  createDriftRemediationWorkspace(receipt: GitWorkspaceReceipt, integrated: GitIntegrationReceipt): GitWorkspaceReceipt {
    return this.receipt(`drift-${++this.sequence}`, receipt, integrated.postSnapshotHash);
  }
  prepareIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    const snapshotHash = `sha256:snapshot-${this.sequence}`;
    const prepared = { ...receipt, snapshotHash, changedPaths: ["src/rehearsal.ts"], preparedResultCommit: `result-${this.sequence}`, preparedResultRef: `refs/pi-swe/results/${receipt.workspaceId}`, preparedPatchHash: `sha256:patch-${this.sequence}` };
    return { receipt: prepared, patch: Buffer.from(`delta-${this.sequence}`), patchHash: prepared.preparedPatchHash, resultCommit: prepared.preparedResultCommit, resultRef: prepared.preparedResultRef, changedPaths: prepared.changedPaths, patchPaths: prepared.changedPaths, preflight: {} as never };
  }
  resumePreparedIntegration(receipt: GitWorkspaceReceipt): PreparedIntegration {
    return { receipt, patch: Buffer.from("retained-delta"), patchHash: receipt.preparedPatchHash!, resultCommit: receipt.preparedResultCommit!, resultRef: receipt.preparedResultRef!, changedPaths: receipt.changedPaths, patchPaths: receipt.changedPaths, preflight: {} as never };
  }
  integrate(prepared: PreparedIntegration): GitIntegrationReceipt {
    return { version: 1, integrationId: `integration-${this.sequence}`, workspaceId: prepared.receipt.workspaceId, preSnapshotHash: prepared.receipt.baselineHash, postSnapshotHash: prepared.receipt.snapshotHash, patchHash: prepared.patchHash, resultCommit: prepared.resultCommit, resultRef: prepared.resultRef, observedHead: prepared.receipt.realHead, observedIndexHash: prepared.receipt.realIndexHash, changedPaths: prepared.changedPaths, integratedAt: new Date().toISOString() };
  }
  cumulativeDiff(receipt: GitWorkspaceReceipt): Buffer { return Buffer.from(`cumulative-${receipt.workspaceId}`); }
  private receipt(id: string, input: { topic?: string; taskId?: string; writeScope?: string[]; realHead?: string; realIndexHash?: string }, baselineHash: string): GitWorkspaceReceipt {
    return {
      version: 1,
      workspaceId: id,
      root: this.cwd,
      path: join(this.cwd, ".model-artifacts/system/logs/workspaces", id),
      taskId: input.taskId ?? "T1",
      topic: input.topic ?? "rehearsal-lifecycle",
      baselineHash,
      snapshotHash: baselineHash,
      changedPaths: [],
      createdAt: new Date().toISOString(),
      baselineCommit: "candidate",
      baselineRef: `refs/pi-swe/baselines/${id}`,
      worktreeGitDir: join(this.cwd, ".git/worktrees", id),
      ownershipToken: `owner-${id}`,
      intentPath: join(this.cwd, ".git/pi-swe-intents", `${id}.json`),
      workspaceHeadCommit: "candidate",
      realHead: input.realHead ?? "candidate",
      realIndexHash: input.realIndexHash ?? "index",
      realIndexTree: "tree",
      stagedPatchHash: "staged",
      unstagedPatchHash: "unstaged",
      realSourceSnapshotHash: baselineHash,
      includedUntracked: [],
      managedPaths: [],
      writeScope: input.writeScope ?? ["src/**"],
    };
  }
}

class RehearsalSourceInspector {
  inspect(workflow: Workflow): RelevantSourceSnapshot {
    const active = workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : undefined;
    const receipt = active?.integrationReceipt ?? [...workflow.tasks].reverse().find((task) => task.integrationReceipt)?.integrationReceipt;
    return { hash: receipt?.postSnapshotHash ?? "sha256:unintegrated", head: receipt?.observedHead ?? "candidate", branch: "master", changedPaths: receipt?.changedPaths ?? [] };
  }
}

class RehearsalCloseoutInspector {
  private fenced = false;
  readonly snapshot = { hash: "sha256:closeout", head: "candidate", branch: "master", changedPaths: [] as string[], capturedAt: new Date().toISOString() };
  inspect() { return { snapshot: structuredClone(this.snapshot), cumulativeDelta: "deterministic cumulative delta", unresolvedRisks: [] as string[] }; }
  acquireFence(): () => void {
    assert.equal(this.fenced, false);
    this.fenced = true;
    return () => { this.fenced = false; };
  }
}

function temporaryEntrypoint(): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProductionRuntime, qualifyV2Activation, recoverRuntimeWorkflows, registerQualifiedV2Runtime } from "./src/runtime.ts";
export { recoverRuntimeWorkflows };
export const PI_SWE_EXTENSION_ID = "pi-swe";
export const PI_SWE_ACTIVATION = "temporary-v2" as const;
export default function piSwe(pi: ExtensionAPI): void {
  const harness = (globalThis as typeof globalThis & { __PI_SWE_CUTOVER_REHEARSAL__?: any }).__PI_SWE_CUTOVER_REHEARSAL__;
  if (!harness) throw new Error("cutover rehearsal harness is unavailable");
  const runtime = createProductionRuntime({ ...harness.options, pi });
  const qualification = qualifyV2Activation({ requested: true, migrationReady: true, piVersion: "0.84.2", expectedPiVersion: "0.84.2", extensionId: "pi-swe", expectedExtensionId: "pi-swe", repositorySupported: true, requiredTools: ["read", "grep", "find", "ls", "bash"], availableTools: pi.getAllTools().map((tool) => tool.name) });
  harness.runtime = runtime;
  harness.activation = registerQualifiedV2Runtime(pi, qualification, runtime);
}
`;
}

async function submitTaskVerification(runtime: any, parent: ParentExecutionIdentity, topic: string, callId: string): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  const workflow = runtime.mutations.read(topic, false).workflow as Workflow;
  const task = workflow.tasks.find((candidate) => candidate.id === workflow.activeTask)!;
  const authorization = runtime.verificationAuthority.authorize({ workflow, taskId: task.id, toolName: "bash", toolCallId: callId, commandLine: renderVerificationCommand(task.verification[0]!), parent });
  const submission = runtime.verificationAuthority.finish({ authorizationId: authorization.id, workflow, taskId: task.id, toolCallId: callId, exitCode: 0, parent });
  const handoff = await runtime.engine.advance(topic, workflow.revision, { verification: submission });
  assert.equal(handoff.kind, "advanced");
}

async function submitInitiativeVerification(runtime: any, parent: ParentExecutionIdentity, topic: string, callId: string): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
  const workflow = runtime.mutations.read(topic, false).workflow as Workflow;
  const authorization = runtime.closeoutAuthority.authorize({ workflow, toolName: "bash", toolCallId: callId, commandLine: renderVerificationCommand(workflow.initiativeVerification[0]!), parent });
  const submission = runtime.closeoutAuthority.finish({ authorizationId: authorization.id, workflow, toolCallId: callId, exitCode: 0, parent });
  const handoff = await runtime.engine.advance(topic, workflow.revision, { initiativeVerification: submission });
  assert.equal(handoff.kind, "advanced");
}

test("cutover corpus has an exhaustive one-to-one correspondence with the authoritative migration corpus", () => {
  assert.equal(rehearsalCorpus.schemaVersion, 2);
  assert.equal(migrationCorpus.schemaVersion, 1);
  const covered = rehearsalCorpus.cases.flatMap((item) => item.migrationCaseId ? [item.migrationCaseId] : []);
  assert.deepEqual(covered, migrationCorpus.cases.map((item) => item.id));
  assert.equal(new Set(covered).size, migrationCorpus.cases.length);
});

test("disposable candidate checkout rehearses exhaustive migration, production entrypoint activation, durable restart, acceptance, and rollback", async () => {
  const controlRoot = process.cwd();
  const controlHead = git(controlRoot, "rev-parse", "HEAD");
  const controlStatus = git(controlRoot, "status", "--porcelain=v1", "--untracked-files=all");
  const controlRetained = snapshotRetainedState(controlRoot);
  const controlSources = new Map([
    ["extensions/pi-swe/src/cutover.ts", readFileSync(join(controlRoot, "extensions/pi-swe/src/cutover.ts"))],
    ["test/pi-swe-cutover.test.ts", readFileSync(join(controlRoot, "test/pi-swe-cutover.test.ts"))],
    ["test/fixtures/pi-swe-cutover/corpus.json", readFileSync(join(controlRoot, "test/fixtures/pi-swe-cutover/corpus.json"))],
    ["scripts/release-verify.ts", readFileSync(join(controlRoot, "scripts/release-verify.ts"))],
  ]);
  const checkoutParent = mkdtempSync(join(tmpdir(), "pi-swe-cutover-candidate-"));
  const cwd = join(checkoutParent, "checkout");
  const exactFiles = new Map<string, Buffer>();
  const retainedPaths = new Set<string>();
  let temporaryRuntime: any;
  let temporaryActivation: { invalidate?: () => void } | undefined;
  try {
    git(checkoutParent, "clone", "--quiet", "--no-hardlinks", controlRoot, cwd);
    assert.equal(git(cwd, "rev-parse", "HEAD"), controlHead);
    assert.equal(git(cwd, "status", "--porcelain=v1", "--untracked-files=all"), "");
    for (const path of ["extensions/pi-swe/index.ts", "extensions/pi-swe/src/runtime.ts", ".model-artifacts/initiatives/swe-production-rollout/workflow.json"]) {
      assert.deepEqual(readFileSync(join(cwd, path)), rawGit(controlRoot, "show", `${controlHead}:${path}`), path);
    }
    symlinkSync(join(controlRoot, "node_modules"), join(cwd, "node_modules"), "dir");

    for (const fixture of rehearsalCorpus.cases) {
      if (fixture.kind === "historical-contracts") {
        const contractRoot = `.model-artifacts/initiatives/${fixture.id}/plans/revisions/r1`;
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/specs/manifest.json`, { schemaVersion: 2, topic: fixture.id, status: "active", updatedAt: rehearsalAt, activePlan: { revision: 1, path: `${contractRoot}/plan.md`, contractRoot } });
        mkdirSync(join(cwd, contractRoot), { recursive: true });
        writeFileSync(join(cwd, contractRoot, "plan.md"), "# Rehearsal plan\n");
        writeFileSync(join(cwd, contractRoot, "task.md"), "# T1: rehearse\n\n## Acceptance criteria\n\n- remains reversible\n");
        writeJson(cwd, `${contractRoot}/contracts.json`, { contracts: [{ id: "T1", kind: "subphase", status: "pending", path: `${contractRoot}/task.md` }] });
      } else if (fixture.kind === "layout-conflict") {
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/workflow.json`, legacyWorkflowFixture(fixture.id, "paused"));
        writeJson(cwd, `.model-artifacts/plans/${fixture.id}/fixture.json`, { retained: true });
      } else if (fixture.kind === "malformed") {
        const path = `.model-artifacts/initiatives/${fixture.id}/workflow.json`;
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), "{corrupt-json\n");
      } else if (fixture.kind === "unsupported-workflow") {
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/workflow.json`, { version: 99, topic: fixture.id, retained: true });
      } else if (fixture.kind !== "cutover-lifecycle") {
        const status = fixture.id === "active" ? "active" : fixture.id === "blocked" ? "blocked" : fixture.id === "draft" ? "draft" : fixture.kind === "native-v1-complete" ? "complete" : "paused";
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/workflow.json`, legacyWorkflowFixture(fixture.id, status));
      }
    }

    for (const topic of ["rollback-before-selection", "rollback-edited-postimage", "rollback-exact-postimage"]) {
      const acceptedPath = `.model-artifacts/initiatives/${topic}/reports/accepted.txt`;
      const workspacePath = `.model-artifacts/system/logs/workspaces/${topic}.bin`;
      const intentPath = `.git/pi-swe-intents/${topic}.json`;
      mkdirSync(dirname(join(cwd, acceptedPath)), { recursive: true });
      writeFileSync(join(cwd, acceptedPath), `accepted-${topic}\n`);
      mkdirSync(dirname(join(cwd, workspacePath)), { recursive: true });
      writeFileSync(join(cwd, workspacePath), Buffer.from([0, 1, 2, 255]));
      writeJson(cwd, intentPath, { topic, retained: true });
      for (const path of [`.model-artifacts/initiatives/${topic}/workflow.json`, acceptedPath, workspacePath, intentPath]) {
        exactFiles.set(path, readFileSync(join(cwd, path)));
        retainedPaths.add(path);
      }
    }

    const initial = inventoryWorkflowMigrations(cwd);
    for (const fixture of rehearsalCorpus.cases.filter((item) => item.remediation)) {
      const entry = initial.entries.find((candidate) => candidate.topic === fixture.id)!;
      assert.ok(entry, fixture.id);
      const before = entry.sourcePaths.filter((path) => existsSync(join(cwd, path)) && lstatSync(join(cwd, path)).isFile()).map((path) => [path, readFileSync(join(cwd, path))] as const);
      assert.deepEqual([cutoverMigrationRemediation(entry)], [fixture.remediation]);
      for (const [path, bytes] of before) {
        exactFiles.set(path, bytes);
        assert.deepEqual(readFileSync(join(cwd, path)), bytes);
      }
    }

    const ordinary = rehearsalCorpus.cases.filter((item) => item.disposition && !["crash-after-postimage", "concurrent-writer", "rollback-edited-postimage", "rollback-exact-postimage", "rollback-before-selection"].includes(item.id));
    for (const fixture of ordinary) {
      const plan = planWorkflowMigration(cwd, fixture.id, { disposition: fixture.disposition, authorization: rehearsalAuthorization(cwd, fixture.id, fixture.disposition), now: rehearsalAt });
      assert.equal(plan.eligible, true, fixture.id);
      assert.equal((await applyWorkflowMigration(cwd, plan)).status, "applied", fixture.id);
    }

    const crashPlan = planWorkflowMigration(cwd, "crash-after-postimage", { disposition: "continue", authorization: rehearsalAuthorization(cwd, "crash-after-postimage", "continue"), now: rehearsalAt });
    await assert.rejects(() => applyWorkflowMigration(cwd, crashPlan, { fault: (stage) => { if (stage === "workflow-written") throw new Error("rehearsed power loss"); } }), /rehearsed power loss/);
    assert.equal((await recoverWorkflowMigration(cwd, "crash-after-postimage")).status, "recovered");

    const concurrentPath = ".model-artifacts/initiatives/concurrent-writer/workflow.json";
    const concurrentBefore = readFileSync(join(cwd, concurrentPath));
    const concurrentPlan = planWorkflowMigration(cwd, "concurrent-writer", { disposition: "continue", authorization: rehearsalAuthorization(cwd, "concurrent-writer", "continue"), now: rehearsalAt });
    writeJson(cwd, concurrentPath, { ...legacyWorkflowFixture("concurrent-writer", "paused"), revision: 4 });
    await assert.rejects(() => applyWorkflowMigration(cwd, concurrentPlan), /audit hash mismatch/);
    assert.equal(existsSync(join(cwd, workflowMigrationReceiptPath("concurrent-writer"))), false);
    writeFileSync(join(cwd, concurrentPath), concurrentBefore);

    const editedPlan = planWorkflowMigration(cwd, "rollback-edited-postimage", { disposition: "continue", authorization: rehearsalAuthorization(cwd, "rollback-edited-postimage", "continue"), now: rehearsalAt });
    await applyWorkflowMigration(cwd, editedPlan);
    writeFileSync(join(cwd, ".model-artifacts/initiatives/rollback-edited-postimage/workflow.json"), `${editedPlan.postimage} `);
    await assert.rejects(() => rollbackWorkflowMigration(cwd, "rollback-edited-postimage"), /intervening edits/);
    writeFileSync(join(cwd, ".model-artifacts/initiatives/rollback-edited-postimage/workflow.json"), editedPlan.postimage!);
    await rollbackWorkflowMigration(cwd, "rollback-edited-postimage");

    const beforeSelectionPlan = planWorkflowMigration(cwd, "rollback-before-selection", { disposition: "continue", authorization: rehearsalAuthorization(cwd, "rollback-before-selection", "continue"), now: rehearsalAt });
    await applyWorkflowMigration(cwd, beforeSelectionPlan);
    await rollbackWorkflowMigration(cwd, "rollback-before-selection");
    const selectorPath = join(cwd, ".git/pi-swe-runtime-selector");
    const absentPreimage = captureCutoverRuntimeSelector(cwd);
    assert.equal(absentPreimage.existed, false);
    rollbackCutoverRuntime(cwd, absentPreimage);
    assert.equal(existsSync(selectorPath), false);

    writeFileSync(selectorPath, Buffer.from([9, 8, 7, 0, 255]));
    const exactSelectorPreimage = selectCutoverRuntime(cwd);
    rollbackCutoverRuntime(cwd, exactSelectorPreimage);
    assert.deepEqual(readFileSync(selectorPath), Buffer.from([9, 8, 7, 0, 255]));
    rmSync(selectorPath);

    const afterSelectionPlan = planWorkflowMigration(cwd, "rollback-exact-postimage", { disposition: "continue", authorization: rehearsalAuthorization(cwd, "rollback-exact-postimage", "continue"), now: rehearsalAt });
    const afterSelectionReceipt = await applyWorkflowMigration(cwd, afterSelectionPlan);
    assert.equal(afterSelectionReceipt.status, "applied");

    const entrypointPath = join(cwd, "extensions/pi-swe/index.ts");
    const entrypointPreimage = readFileSync(entrypointPath);
    writeFileSync(entrypointPath, temporaryEntrypoint());
    const activationSelectorPreimage = selectCutoverRuntime(cwd);
    assert.equal(activationSelectorPreimage.existed, false);
    assert.equal(readFileSync(selectorPath, "utf8"), "v2-temporary\n");

    const runner = new RehearsalRunner();
    const workspace = new RehearsalWorkspace(cwd);
    const sourceInspector = new RehearsalSourceInspector();
    const closeoutInspector = new RehearsalCloseoutInspector();
    const oldParent: ParentExecutionIdentity = { ownerId: "parent-old", sessionId: "session-old", runtimeId: "runtime-old", cwd: resolve(cwd), branchLength: 0 };
    const registrations: string[] = [];
    const harness: RehearsalHarness = { options: { cwd, parent: oldParent, provider: "deterministic-cutover", model: "deterministic-cutover", qualificationMode: true, overrides: { runner, workspace, sourceInspector, closeoutInspector } } };
    (globalThis as typeof globalThis & { __PI_SWE_CUTOVER_REHEARSAL__?: RehearsalHarness }).__PI_SWE_CUTOVER_REHEARSAL__ = harness;
    const activatedEntrypoint = await import(`${pathToFileURL(entrypointPath).href}?temporary-v2=${Date.now()}`);
    activatedEntrypoint.default(fakePi(registrations) as never);
    temporaryRuntime = harness.runtime;
    temporaryActivation = harness.activation;
    assert.equal(temporaryActivation?.active, true);
    assert.deepEqual(registrations, ["hook:session_start", "hook:tool_call", "hook:tool_result", "hook:before_agent_start", "hook:user_bash", "hook:session_shutdown", "command:swe", "tool:swe_workflow"]);

    const lifecycle = createWorkflow({
      topic: "rehearsal-lifecycle",
      goal: "Prove a complete multi-task cutover lifecycle through the activated production composition",
      plan: "Use deterministic providers and durable restart recovery.",
      now: rehearsalAt,
      tasks: [
        { id: "T1", title: "first lifecycle task", writeScope: ["src/**"], nonGoals: ["no release"], approaches: ["tdd"], approachReasons: { tdd: "the lifecycle is deterministic" }, assessmentStatus: "assessed", verification: [{ command: "node", args: ["--version"] }] },
        { id: "T2", title: "second lifecycle task", dependsOn: ["T1"], writeScope: ["src/**"], nonGoals: ["no release"], approaches: ["tdd"], approachReasons: { tdd: "the lifecycle is deterministic" }, assessmentStatus: "assessed", verification: [{ command: "node", args: ["--version"] }] },
      ],
    });
    await temporaryRuntime.mutations.create(lifecycle);
    const firstRun = await temporaryRuntime.driver.start(lifecycle.topic);
    assert.equal(firstRun.outcome, "handoff");
    assert.equal(firstRun.handoff.kind, "verification-required");
    const verificationCheckpoint = temporaryRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    assert.equal(verificationCheckpoint.orchestration.activeRun, undefined);
    assert.equal(verificationCheckpoint.tasks[0]!.phase, "verification");
    await submitTaskVerification(temporaryRuntime, oldParent, lifecycle.topic, "task-verification-1");
    const readyToComplete = temporaryRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    const completedFirstTask = await temporaryRuntime.engine.advance(lifecycle.topic, readyToComplete.revision);
    assert.equal(completedFirstTask.kind, "advanced");
    const durableCheckpoint = temporaryRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    assert.equal(durableCheckpoint.orchestration.activeRun, undefined);
    assert.equal(durableCheckpoint.activeTask, undefined);
    assert.equal(durableCheckpoint.tasks[0]!.status, "complete");
    const checkpointBytes = readFileSync(join(cwd, ".model-artifacts/initiatives/rehearsal-lifecycle/workflow.json"));

    const discardedRuntime = temporaryRuntime;
    discardedRuntime.shutdown();
    temporaryActivation?.invalidate?.();
    const newParent: ParentExecutionIdentity = { ownerId: "parent-new", sessionId: "session-new", runtimeId: "runtime-new", cwd: resolve(cwd), branchLength: 0 };
    const freshRegistrations: string[] = [];
    const freshHarness: RehearsalHarness = { options: { ...harness.options, parent: newParent } };
    (globalThis as typeof globalThis & { __PI_SWE_CUTOVER_REHEARSAL__?: RehearsalHarness }).__PI_SWE_CUTOVER_REHEARSAL__ = freshHarness;
    activatedEntrypoint.default(fakePi(freshRegistrations) as never);
    const freshRuntime = freshHarness.runtime;
    temporaryRuntime = freshRuntime;
    temporaryActivation = freshHarness.activation;
    const reloaded = freshRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    assert.deepEqual(readFileSync(join(cwd, ".model-artifacts/initiatives/rehearsal-lifecycle/workflow.json")), checkpointBytes);
    assert.equal(reloaded.orchestration.parent?.ownerId, oldParent.ownerId);
    await freshRuntime.mutations.mutate(lifecycle.topic, reloaded.revision, (workflow: Workflow) => reduceWorkflow(workflow, { type: "invalidate-parent", ownerId: oldParent.ownerId, sessionId: oldParent.sessionId, runtimeId: oldParent.runtimeId, reason: "fresh runtime fenced discarded parent authority" }, new Date().toISOString()));
    const fencedState = freshRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    assert.equal(fencedState.orchestration.parent?.valid, false);
    assert.equal(fencedState.status, "paused");
    const staleAttempt = await discardedRuntime.engine.advance(lifecycle.topic, fencedState.revision);
    assert.equal(staleAttempt.kind, "blocked");
    assert.match(staleAttempt.message, /parent|authority/i);
    await freshRuntime.mutations.mutate(lifecycle.topic, fencedState.revision, (workflow: Workflow) => reduceWorkflow(workflow, { type: "recover-parent", authority: { ...newParent, claimedAt: new Date().toISOString(), valid: true }, reason: "resume durable no-child cutover checkpoint", decidedBy: "cutover-rehearsal" }, new Date().toISOString()));

    let resumed = await freshRuntime.driver.resume(lifecycle.topic);
    assert.equal(resumed.handoff.kind, "verification-required");
    assert.equal(resumed.handoff.taskId, "T2");
    await submitTaskVerification(freshRuntime, newParent, lifecycle.topic, "task-verification-2");
    resumed = await freshRuntime.driver.resume(lifecycle.topic);
    assert.equal(resumed.handoff.kind, "verification-required");
    assert.equal(resumed.handoff.stage, "initiative-acceptance");
    await submitInitiativeVerification(freshRuntime, newParent, lifecycle.topic, "initiative-verification-1");
    const completedRun = await freshRuntime.driver.resume(lifecycle.topic);
    assert.equal(completedRun.outcome, "completed");
    const completed = freshRuntime.mutations.read(lifecycle.topic, false).workflow as Workflow;
    assert.equal(completed.status, "complete");
    assert.equal(completed.initiativeAcceptance?.outcome, "approved");
    assert.equal(completed.tasks.every((task) => task.status === "complete" && task.workspaceReceipt && task.integrationReceipt && task.evidence.length === 1), true);
    assert.equal(completed.orchestration.history.some((item) => item.type === "parent-recovered"), true);
    assert.equal(runner.requests.filter((request) => request.role === "implementer").length, 2);
    const acceptedLifecycleBytes = readFileSync(join(cwd, ".model-artifacts/initiatives/rehearsal-lifecycle/workflow.json"));

    await rollbackWorkflowMigration(cwd, "rollback-exact-postimage");
    const rolledBackReceipt = JSON.parse(readFileSync(join(cwd, workflowMigrationReceiptPath("rollback-exact-postimage")), "utf8")) as Record<string, unknown>;
    assert.equal(rolledBackReceipt.state, "rolled-back");
    assert.equal(String(rolledBackReceipt.preimageHash).slice("sha256:".length), digest(exactFiles.get(".model-artifacts/initiatives/rollback-exact-postimage/workflow.json")!));
    for (const path of retainedPaths) assert.deepEqual(readFileSync(join(cwd, path)), exactFiles.get(path), path);

    freshRuntime.shutdown();
    freshHarness.activation?.invalidate?.();
    rollbackCutoverRuntime(cwd, activationSelectorPreimage);
    assert.equal(existsSync(selectorPath), false);
    writeFileSync(entrypointPath, entrypointPreimage);
    assert.deepEqual(readFileSync(entrypointPath), entrypointPreimage);
    assert.deepEqual(readFileSync(join(cwd, ".model-artifacts/initiatives/rehearsal-lifecycle/workflow.json")), acceptedLifecycleBytes);

    const compatibilityRegistrations: string[] = [];
    const compatibilityEntrypoint = await import(`${pathToFileURL(entrypointPath).href}?rollback=${Date.now()}`);
    compatibilityEntrypoint.default(fakePi(compatibilityRegistrations) as never);
    assert.equal(compatibilityEntrypoint.PI_SWE_ACTIVATION, "disabled");
    assert.deepEqual(compatibilityRegistrations, ["command:swe", "tool:swe_workflow"]);

    for (const fixture of rehearsalCorpus.cases.filter((item) => item.remediation)) {
      const entry = inventoryWorkflowMigrations(cwd).entries.find((candidate) => candidate.topic === fixture.id)!;
      assert.deepEqual([cutoverMigrationRemediation(entry)], [fixture.remediation]);
      for (const path of entry.sourcePaths.filter((path) => exactFiles.has(path))) assert.deepEqual(readFileSync(join(cwd, path)), exactFiles.get(path), path);
    }

    assert.equal(git(controlRoot, "rev-parse", "HEAD"), controlHead);
    assert.equal(git(controlRoot, "status", "--porcelain=v1", "--untracked-files=all"), controlStatus);
    assert.deepEqual(snapshotRetainedState(controlRoot), controlRetained);
    for (const [path, bytes] of controlSources) assert.deepEqual(readFileSync(join(controlRoot, path)), bytes, path);
  } finally {
    delete (globalThis as typeof globalThis & { __PI_SWE_CUTOVER_REHEARSAL__?: RehearsalHarness }).__PI_SWE_CUTOVER_REHEARSAL__;
    temporaryRuntime?.shutdown?.();
    temporaryActivation?.invalidate?.();
    rmSync(checkoutParent, { recursive: true, force: true });
  }
});
