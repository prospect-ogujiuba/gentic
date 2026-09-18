import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CUTOVER_RELEASE_CHECK_MANIFEST,
  cutoverMigrationRemediation,
  evaluateCutoverReadiness,
  formatCutoverReadiness,
  inspectCutoverReadiness,
  type CutoverInspectionInput,
  type CutoverReadinessObservation,
} from "../extensions/pi-swe/src/cutover.ts";
import { applyWorkflowMigration, inventoryWorkflowMigrations, planWorkflowMigration, rollbackWorkflowMigration, workflowMigrationReceiptPath, type WorkflowMigrationDisposition } from "../extensions/pi-swe/src/migration.ts";
import { qualifyV2Activation, registerQualifiedV2Runtime } from "../extensions/pi-swe/src/runtime.ts";
import { createWorkflow, hashContract, reduceWorkflow, type RepositorySnapshot, type RunnerProvenance, type StageReport, type VerificationEvidence, type Workflow, type WorkspaceReceipt } from "../extensions/pi-swe/src/workflow.ts";

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
  kind: string;
  disposition?: WorkflowMigrationDisposition;
  rollback?: "before-selection" | "after-selection";
  remediation?: string;
};

const rehearsalCorpus = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-cutover/corpus.json", import.meta.url), "utf8")) as { schemaVersion: number; cases: RehearsalCase[] };
const rehearsalAt = "2026-09-17T08:00:00.000Z";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function legacyWorkflowFixture(topic: string, status: string, taskCount = 1): Record<string, unknown> {
  return {
    version: 1,
    topic,
    revision: 3,
    status,
    goal: `rehearse ${topic}`,
    updatedAt: rehearsalAt,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `T${index + 1}`,
      title: `task ${index + 1}`,
      status: status === "complete" ? "complete" : index === 0 && status === "active" ? "active" : index === 0 && status === "blocked" ? "blocked" : "pending",
      dependsOn: index === 0 ? [] : [`T${index}`],
      acceptance: ["rehearsal stage is retained"],
      approaches: ["tdd"],
      approachReasons: { tdd: "the rehearsal is deterministic" },
      assessmentStatus: "assessed",
      writeScope: ["src/**"],
      nonGoals: ["no release"],
      verification: [{ command: "node", args: ["--version"] }],
      evidence: [],
    })),
  };
}

function stageReport(kind: StageReport["kind"], role: RunnerProvenance["role"], runId: string, contractHash: string, snapshotHash = "sha256:rehearsal-snapshot", outcome: StageReport["outcome"] = "approved"): StageReport {
  return {
    kind,
    outcome,
    summary: `${kind} accepted in cutover rehearsal`,
    findings: [],
    provenance: { runId, role, actorId: `${role}:${runId}`, leaseId: `lease-${runId}`, leaseFence: 1, contractHash, snapshotHash, startedAt: rehearsalAt, completedAt: "2026-09-17T08:00:01.000Z" },
  };
}

function workspaceReceipt(cwd: string, workflow: Workflow, taskId: string): WorkspaceReceipt {
  const task = workflow.tasks.find((candidate) => candidate.id === taskId)!;
  return {
    version: 1, workspaceId: `ws-${taskId}`, root: cwd, path: join(cwd, ".model-artifacts/system/logs/workspaces", taskId), taskId, topic: workflow.topic,
    baselineHash: "sha256:baseline", snapshotHash: "sha256:rehearsal-snapshot", changedPaths: [], createdAt: rehearsalAt,
    baselineCommit: "base", baselineRef: `refs/pi-swe/baselines/${taskId}`, worktreeGitDir: join(cwd, ".git/worktrees", taskId), ownershipToken: `owner-${taskId}`,
    intentPath: join(cwd, ".git/pi-swe-intents", `${taskId}.json`), workspaceHeadCommit: "base", preparedResultCommit: `result-${taskId}`, preparedResultRef: `refs/pi-swe/results/${taskId}`,
    preparedPatchHash: "sha256:patch", realHead: "head", realIndexHash: "index", realIndexTree: "tree", stagedPatchHash: "staged", unstagedPatchHash: "unstaged",
    realSourceSnapshotHash: "sha256:baseline", includedUntracked: [], managedPaths: [], writeScope: task.writeScope,
  };
}

function completeRehearsalTask(cwd: string, workflow: Workflow, taskId: string, sequence: number): Workflow {
  const task = workflow.tasks.find((candidate) => candidate.id === taskId)!;
  const receipt = workspaceReceipt(cwd, workflow, taskId);
  const implementation = stageReport("implementation", "implementer", `impl-${sequence}`, task.contract.hash);
  implementation.outcome = "no-change";
  implementation.rationale = "The deterministic rehearsal fixture requires no source mutation.";
  implementation.changedPaths = [];
  let current = reduceWorkflow(workflow, { type: "record-implementation", report: implementation, receipt }, `2026-09-17T08:0${sequence}:02.000Z`).workflow;
  current = reduceWorkflow(current, { type: "record-review", report: stageReport("general-review", "general-reviewer", `review-${sequence}`, task.contract.hash) }, `2026-09-17T08:0${sequence}:03.000Z`).workflow;
  const evidence: VerificationEvidence = {
    command: "node", args: ["--version"], exitCode: 0, at: `2026-09-17T08:0${sequence}:04.000Z`, contractHash: task.contract.hash,
    snapshotHash: receipt.snapshotHash, source: { kind: "bash-tool-result", toolCallId: `task-check-${sequence}`, workflowRevision: current.revision },
  };
  current = reduceWorkflow(current, { type: "record-verification", evidence }, evidence.at).workflow;
  return reduceWorkflow(current, { type: "complete-task" }, `2026-09-17T08:0${sequence}:05.000Z`).workflow;
}

function finishRehearsalLifecycle(cwd: string, workflow: Workflow, parent: { ownerId: string; sessionId: string; runtimeId: string; cwd: string; branchLength: number }): Workflow {
  const snapshot: RepositorySnapshot = { hash: "sha256:rehearsal-snapshot", head: "fixture-head", branch: "main", changedPaths: [], capturedAt: "2026-09-17T08:10:00.000Z" };
  let current = reduceWorkflow(workflow, { type: "begin-initiative-closeout", snapshot, cumulativeDeltaHash: hashContract("rehearsal-delta"), unresolvedRisks: [], branchLength: parent.branchLength }, "2026-09-17T08:10:01.000Z").workflow;
  const check = current.initiativeVerification[0]!;
  const evidence: VerificationEvidence = {
    ...check, exitCode: 0, at: "2026-09-17T08:10:02.000Z", contractHash: current.contract.hash, snapshotHash: snapshot.hash,
    beforeSnapshotHash: snapshot.hash, afterSnapshotHash: snapshot.hash, cwd, head: snapshot.head, branch: snapshot.branch,
    source: { kind: "bash-tool-result", toolName: "bash", toolCallId: "initiative-check", workflowRevision: current.closeout!.checkpoint.revision, ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, branchLength: parent.branchLength },
  };
  current = reduceWorkflow(current, { type: "record-initiative-verification", evidence, observedSnapshot: snapshot }, "2026-09-17T08:10:03.000Z").workflow;
  const acceptance = stageReport("final-acceptance", "final-reviewer", "final-1", current.contract.hash, snapshot.hash);
  acceptance.provenance.startedAt = "2026-09-17T08:10:03.500Z";
  acceptance.provenance.completedAt = "2026-09-17T08:10:04.000Z";
  current = reduceWorkflow(current, { type: "record-initiative-acceptance", report: acceptance }, "2026-09-17T08:10:04.000Z").workflow;
  return reduceWorkflow(current, { type: "complete-initiative", observedSnapshot: snapshot, branchLength: parent.branchLength }, "2026-09-17T08:10:05.000Z").workflow;
}

test("disposable checkout rehearses every migration, temporary v2 activation, restart, acceptance, and reversible rollback", async () => {
  assert.equal(rehearsalCorpus.schemaVersion, 1);
  const controlRoot = process.cwd();
  const controlStatus = git(controlRoot, "status", "--porcelain=v1", "--untracked-files=all");
  const controlWorkflowPath = join(controlRoot, ".model-artifacts/initiatives/swe-production-rollout/workflow.json");
  const controlWorkflow = readFileSync(controlWorkflowPath);
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-cutover-rehearsal-"));
  const exactFiles = new Map<string, Buffer>();
  try {
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
      } else if (fixture.kind === "unsupported-workflow") {
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/workflow.json`, { version: 99, topic: fixture.id, retained: true });
      } else {
        const status = fixture.id === "native-active" ? "active" : fixture.id === "native-blocked" ? "blocked" : fixture.kind === "native-v1-complete" ? "complete" : "paused";
        writeJson(cwd, `.model-artifacts/initiatives/${fixture.id}/workflow.json`, legacyWorkflowFixture(fixture.id, status, fixture.id === "native-lifecycle" ? 2 : 1));
      }
    }
    for (const path of [
      ".model-artifacts/initiatives/layout-conflict/workflow.json",
      ".model-artifacts/plans/layout-conflict/fixture.json",
      ".model-artifacts/initiatives/unsupported-version/workflow.json",
    ]) exactFiles.set(path, readFileSync(join(cwd, path)));
    for (const topic of ["rollback-before-selection", "rollback-after-selection"]) {
      const acceptedPath = `.model-artifacts/initiatives/${topic}/reports/accepted.txt`;
      const workspacePath = `.model-artifacts/system/logs/workspaces/${topic}.bin`;
      mkdirSync(dirname(join(cwd, acceptedPath)), { recursive: true });
      writeFileSync(join(cwd, acceptedPath), `accepted-${topic}\n`);
      mkdirSync(dirname(join(cwd, workspacePath)), { recursive: true });
      writeFileSync(join(cwd, workspacePath), Buffer.from([0, 1, 2, 255]));
      for (const path of [`.model-artifacts/initiatives/${topic}/workflow.json`, acceptedPath, workspacePath]) exactFiles.set(path, readFileSync(join(cwd, path)));
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Cutover Rehearsal");
    git(cwd, "config", "user.email", "cutover@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "rehearsal fixtures");

    const initial = inventoryWorkflowMigrations(cwd);
    for (const fixture of rehearsalCorpus.cases.filter((item) => item.remediation)) {
      const entry = initial.entries.find((candidate) => candidate.topic === fixture.id)!;
      const before = entry.sourcePaths.filter((path) => lstatSync(join(cwd, path)).isFile()).map((path) => [path, readFileSync(join(cwd, path))] as const);
      assert.equal(cutoverMigrationRemediation(entry), fixture.remediation);
      for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(cwd, path)), bytes);
    }

    const migratable = rehearsalCorpus.cases.filter((fixture) => fixture.disposition);
    const appliedReceipts = new Map<string, Record<string, unknown>>();
    for (const fixture of migratable) {
      const plan = planWorkflowMigration(cwd, fixture.id, { disposition: fixture.disposition, decidedBy: "cutover-rehearsal", now: rehearsalAt });
      assert.equal(plan.eligible, true, fixture.id);
      assert.equal((await applyWorkflowMigration(cwd, plan)).status, "applied", fixture.id);
      if (fixture.rollback) appliedReceipts.set(fixture.id, JSON.parse(readFileSync(join(cwd, workflowMigrationReceiptPath(fixture.id)), "utf8")) as Record<string, unknown>);
    }

    await rollbackWorkflowMigration(cwd, "rollback-before-selection");
    assert.equal(existsSync(join(cwd, ".git/pi-swe-runtime-selector")), false);

    const registrations: string[] = [];
    const pi = {
      registerCommand: (name: string) => { registrations.push(`command:${name}`); },
      registerTool: (tool: { name: string }) => { registrations.push(`tool:${tool.name}`); },
      on: (name: string) => { registrations.push(`hook:${name}`); },
      getAllTools: () => ["read", "grep", "find", "ls", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
    };
    const qualification = qualifyV2Activation({ requested: true, migrationReady: true, piVersion: "0.84.2", expectedPiVersion: "0.84.2", extensionId: "pi-swe", expectedExtensionId: "pi-swe", repositorySupported: true, requiredTools: ["read", "grep", "find", "ls", "bash"], availableTools: ["read", "grep", "find", "ls", "bash"] });
    const surface = { registry: { list: () => [], dismiss: () => false, signal: () => false } as never, driver: { start: async () => undefined, resume: async () => undefined, pause: () => false, stop: () => false } as never };
    const activation = registerQualifiedV2Runtime(pi as never, qualification, surface);
    assert.equal(activation.active, true);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    writeFileSync(join(cwd, ".git/pi-swe-runtime-selector"), "v2-temporary\n");
    await rollbackWorkflowMigration(cwd, "rollback-after-selection");
    assert.deepEqual(registrations, ["hook:session_start", "hook:tool_call", "hook:tool_result", "hook:before_agent_start", "hook:user_bash", "hook:session_shutdown", "command:swe", "tool:swe_workflow"]);
    activation.invalidate?.();

    let lifecycle = createWorkflow({
      topic: "rehearsal-lifecycle",
      goal: "Prove a complete multi-task cutover lifecycle",
      now: rehearsalAt,
      tasks: [
        { id: "T1", title: "first lifecycle task", writeScope: ["src/**"], nonGoals: ["no release"], approaches: ["tdd"], approachReasons: { tdd: "the lifecycle is deterministic" }, assessmentStatus: "assessed", verification: [{ command: "node", args: ["--version"] }] },
        { id: "T2", title: "second lifecycle task", dependsOn: ["T1"], writeScope: ["src/**"], nonGoals: ["no release"], approaches: ["tdd"], approachReasons: { tdd: "the lifecycle is deterministic" }, assessmentStatus: "assessed", verification: [{ command: "node", args: ["--version"] }] },
      ],
    });
    const oldParent = { ownerId: "parent-old", sessionId: "session-old", runtimeId: "runtime-old", cwd, branchLength: 0 };
    lifecycle = reduceWorkflow(lifecycle, { type: "record-plan-review", report: stageReport("plan-review", "plan-reviewer", "plan-1", lifecycle.contract.hash) }, "2026-09-17T08:00:01.000Z").workflow;
    lifecycle = reduceWorkflow(lifecycle, { type: "claim-parent", authority: { ...oldParent, claimedAt: "2026-09-17T08:00:02.000Z", valid: true } }, "2026-09-17T08:00:02.000Z").workflow;
    lifecycle = reduceWorkflow(lifecycle, { type: "start" }, "2026-09-17T08:00:03.000Z").workflow;
    assert.equal(lifecycle.status, "active", JSON.stringify({ status: lifecycle.status, activeTask: lifecycle.activeTask, tasks: lifecycle.tasks.map(({ id, status, phase, blockedReason }) => ({ id, status, phase, blockedReason })) }));
    lifecycle = completeRehearsalTask(cwd, lifecycle, "T1", 1);
    const retainedTask = JSON.stringify(lifecycle.tasks[0]);
    lifecycle = reduceWorkflow(lifecycle, { type: "invalidate-parent", ownerId: oldParent.ownerId, sessionId: oldParent.sessionId, runtimeId: oldParent.runtimeId, reason: "rehearsed parent restart" }, "2026-09-17T08:02:00.000Z").workflow;
    const newParent = { ownerId: "parent-new", sessionId: "session-new", runtimeId: "runtime-new", cwd, branchLength: 0 };
    lifecycle = reduceWorkflow(lifecycle, { type: "recover-parent", authority: { ...newParent, claimedAt: "2026-09-17T08:02:01.000Z", valid: true }, reason: "resume after disposable parent restart", decidedBy: "cutover-rehearsal" }, "2026-09-17T08:02:01.000Z").workflow;
    lifecycle = reduceWorkflow(lifecycle, { type: "resume" }, "2026-09-17T08:02:02.000Z").workflow;
    assert.equal(JSON.stringify(lifecycle.tasks[0]), retainedTask);
    lifecycle = completeRehearsalTask(cwd, lifecycle, "T2", 2);
    lifecycle = finishRehearsalLifecycle(cwd, lifecycle, newParent);
    writeJson(cwd, ".model-artifacts/initiatives/rehearsal-lifecycle/workflow.json", lifecycle);
    assert.equal(lifecycle.status, "complete");
    assert.equal(lifecycle.initiativeAcceptance?.outcome, "approved");
    assert.equal(lifecycle.tasks.every((task) => task.workspaceReceipt && task.reports.length >= 2 && task.evidence.length === 1), true);
    assert.equal(lifecycle.orchestration.history.some((item) => item.type === "parent-recovered"), true);

    for (const [path, bytes] of exactFiles) assert.deepEqual(readFileSync(join(cwd, path)), bytes, path);
    for (const topic of ["rollback-before-selection", "rollback-after-selection"]) {
      const receipt = JSON.parse(readFileSync(join(cwd, workflowMigrationReceiptPath(topic)), "utf8")) as Record<string, unknown>;
      const applied = appliedReceipts.get(topic)!;
      const { state: _rolledBackState, rolledBackAt, ...retainedReceipt } = receipt;
      const { state: _appliedState, ...appliedReceipt } = applied;
      assert.equal(receipt.state, "rolled-back");
      assert.equal(typeof rolledBackAt, "string");
      assert.deepEqual(retainedReceipt, appliedReceipt);
      assert.equal(String(receipt.preimageHash).slice("sha256:".length), digest(exactFiles.get(`.model-artifacts/initiatives/${topic}/workflow.json`)!));
    }
    for (const fixture of rehearsalCorpus.cases.filter((item) => item.remediation)) {
      const entry = inventoryWorkflowMigrations(cwd).entries.find((candidate) => candidate.topic === fixture.id)!;
      assert.equal(cutoverMigrationRemediation(entry), fixture.remediation);
    }
    assert.deepEqual(readFileSync(controlWorkflowPath), controlWorkflow);
    assert.equal(git(controlRoot, "status", "--porcelain=v1", "--untracked-files=all"), controlStatus);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
