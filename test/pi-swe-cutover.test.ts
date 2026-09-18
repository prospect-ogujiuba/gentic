import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CUTOVER_RELEASE_CHECK_MANIFEST,
  evaluateCutoverReadiness,
  formatCutoverReadiness,
  inspectCutoverReadiness,
  type CutoverInspectionInput,
  type CutoverReadinessObservation,
} from "../extensions/pi-swe/src/cutover.ts";
import { createWorkflow } from "../extensions/pi-swe/src/workflow.ts";

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
