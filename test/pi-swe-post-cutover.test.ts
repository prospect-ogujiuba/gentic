import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { assertPostCutoverDependencyTree, assertPostCutoverReviewBounds, MAX_POST_CUTOVER_CHANGED_PATHS, MAX_POST_CUTOVER_DELTA_BYTES, postCutoverDependencyFingerprint, PostCutoverAdoptionCoordinator, PostCutoverCheckAuthority } from "../extensions/pi-swe/src/post-cutover.ts";
import { GitPostCutoverRepositoryInspector, unauthorizedPostCutoverRepairPaths, WorkflowMutationService } from "../extensions/pi-swe/src/service.ts";
import { saveWorkflow } from "../extensions/pi-swe/src/store.ts";
import { BOOTSTRAP_PLAN_ANCHOR, POST_CUTOVER_HISTORICAL_HEAD, POST_CUTOVER_HISTORICAL_PATHS, POST_CUTOVER_REPAIR_PATHS, createWorkflow } from "../extensions/pi-swe/src/workflow.ts";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
test("invalid recovery authority is rejected before inspection, install, reviews, or checks", async () => {
  let touched = false;
  const service = { inspectPostCutoverCandidate: async () => { touched = true; throw new Error("must not inspect"); } };
  const engine = { assertPostCutoverPreparationEligibility: () => { throw new Error("invalid parent authority"); }, preparePostCutoverReviews: async () => { touched = true; throw new Error("must not review"); } };
  const coordinator = new PostCutoverAdoptionCoordinator(process.cwd(), service as never, engine as never);
  const invalid = createWorkflow({ topic: "swe-production-rollout", goal: "invalid paused authority", now: "2026-02-01T00:00:00.000Z", tasks: [{ id: "only", title: "only", writeScope: ["src/**"], nonGoals: [], approaches: [], verification: [] }] });
  await assert.rejects(coordinator.prepare({ ...invalid, status: "paused", orchestration: { ...invalid.orchestration, mode: "multi-agent", phase: "plan-review" } }), /invalid parent authority/i);
  assert.equal(touched, false);
});

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-test-"));
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
  git(cwd, "add", "source.ts"); git(cwd, "commit", "-qm", "anchor");
  mkdirSync(join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout"), { recursive: true });
  writeFileSync(join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "{}\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "candidate");
  return cwd;
}

test("canonical repository inspection separates historical Session 9 from bounded authority repair and fails closed on dirt", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-canonical-"));
  const cwd = join(parent, "checkout");
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
    const authority = ".model-artifacts/initiatives/swe-production-rollout/workflow.json";
    writeFileSync(join(cwd, authority), readFileSync(join(process.cwd(), authority)));
    const report = new GitPostCutoverRepositoryInspector(cwd).inspect(BOOTSTRAP_PLAN_ANCHOR);
    assert.equal(report.historicalHead, POST_CUTOVER_HISTORICAL_HEAD);
    assert.equal(report.repairBase, POST_CUTOVER_HISTORICAL_HEAD);
    assert.equal(report.descendantHead, git(cwd, "rev-parse", "HEAD"));
    assert.equal(report.historicalTree, git(cwd, "rev-parse", `${POST_CUTOVER_HISTORICAL_HEAD}^{tree}`));
    assert.deepEqual(report.historicalChangedPaths, [...POST_CUTOVER_HISTORICAL_PATHS]);
    const completeRepairInventory = git(cwd, "diff", "--name-only", "-z", POST_CUTOVER_HISTORICAL_HEAD, report.descendantHead, "--").split("\0").filter((path) => path && !path.startsWith(".model-artifacts/")).sort();
    assert.deepEqual(report.repairChangedPaths, completeRepairInventory, "inspection must return the entire repair changed-path set");
    assert.ok(report.repairChangedPaths.includes("test/pi-swe-orchestration.test.ts"), "the production profile test is explicit repair evidence");
    assert.deepEqual(unauthorizedPostCutoverRepairPaths(report.repairChangedPaths), []);
    assert.deepEqual(unauthorizedPostCutoverRepairPaths(["outside/z.ts", ...report.repairChangedPaths, "outside/a.ts", "outside/z.ts"]), ["outside/a.ts", "outside/z.ts"], "all unauthorized paths must be enumerated, sorted, and deduplicated");
    assert.deepEqual(report.snapshot.changedPaths, [...new Set([...report.historicalChangedPaths, ...report.repairChangedPaths])].sort());
    writeFileSync(join(cwd, "CHANGELOG.md"), "dirty\n");
    assert.throws(() => new GitPostCutoverRepositoryInspector(cwd).inspect(BOOTSTRAP_PLAN_ANCHOR), /only the exact unstaged workflow authority modification/);
    git(cwd, "checkout", "--", "CHANGELOG.md");
    git(cwd, "add", authority);
    assert.throws(() => new GitPostCutoverRepositoryInspector(cwd).inspect(BOOTSTRAP_PLAN_ANCHOR), /only the exact unstaged workflow authority modification/);
    git(cwd, "reset", "-q", "--", authority);
    git(cwd, "mv", "CHANGELOG.md", "RENAMED.md");
    assert.throws(() => new GitPostCutoverRepositoryInspector(cwd).inspect(BOOTSTRAP_PLAN_ANCHOR), /only the exact unstaged workflow authority modification/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("post-cutover service rejects retained evidence through symlinked ancestors without mutation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-evidence-"));
  try {
    const workflow = createWorkflow({ topic: "evidence", goal: "evidence", tasks: [{ id: "T1", title: "noop", writeScope: ["**"], nonGoals: ["no mutation"], verification: [{ command: "node", args: ["--version"] }] }] });
    const path = join(cwd, saveWorkflow(cwd, workflow));
    const before = readFileSync(path, "utf8");
    const outside = mkdtempSync(join(tmpdir(), "pi-swe-evidence-outside-"));
    writeFileSync(join(outside, "report.md"), "outside\n");
    mkdirSync(join(cwd, "evidence")); symlinkSync(outside, join(cwd, "evidence", "linked"), "dir");
    const inspection = { anchorCommit: "a".repeat(40), descendantHead: "b".repeat(40), candidateTree: "c".repeat(40), snapshot: { hash: `sha256:${"d".repeat(64)}`, head: "b".repeat(40), branch: "master", changedPaths: [], capturedAt: "2026-09-21T00:00:00.000Z" } };
    const service = new WorkflowMutationService(cwd, { inspect: () => { throw new Error("unused"); } }, { inspect: () => inspection });
    service.inspectPostCutoverCandidate();
    await assert.rejects(service.adoptPostCutover(workflow.topic, workflow.revision, { ...inspection, retainedEvidence: [{ path: "evidence/linked/report.md", sha256: `sha256:${"e".repeat(64)}`, commit: "f".repeat(40) }] } as never), /symlinked ancestor/);
    assert.equal(readFileSync(path, "utf8"), before);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("post-cutover protected check grants bind exact command, parent, snapshot, and one-shot consumption", () => {
  const cwd = repository();
  try {
    const task = createWorkflow({ topic: "grant", goal: "grant", tasks: [{ id: "T1", title: "check", writeScope: ["**"], nonGoals: ["no change"], verification: [{ command: "node", args: ["--version"] }] }] }).tasks[0]!;
    const parent = { ownerId: "owner", sessionId: "session", runtimeId: "runtime", cwd: "/control", claimedAt: "2026-09-21T00:00:00.000Z", valid: true };
    const inspection = { anchorCommit: git(cwd, "rev-parse", "HEAD~1"), descendantHead: git(cwd, "rev-parse", "HEAD"), candidateTree: git(cwd, "rev-parse", "HEAD^{tree}"), snapshot: { hash: `sha256:${"a".repeat(64)}`, head: git(cwd, "rev-parse", "HEAD"), branch: "master", changedPaths: [], capturedAt: "2026-09-21T00:00:00.000Z" } };
    writeFileSync(join(cwd, ".git", "info", "exclude"), "node_modules/\n");
    mkdirSync(join(cwd, "node_modules")); writeFileSync(join(cwd, "node_modules", "fixture.js"), "stable\n");
    let tick = 0;
    const authority = new PostCutoverCheckAuthority(cwd, inspection, parent, () => `2026-09-21T00:00:0${++tick}.000Z`);
    const grant = authority.authorize(task, task.verification[0]!);
    assert.throws(() => authority.execute({ ...grant }, parent), /forged, stale, or already consumed/);
    const fresh = authority.authorize(task, task.verification[0]!);
    assert.throws(() => authority.execute(fresh, { ...parent, runtimeId: "replaced" }), /parent authority changed/);
    const final = authority.authorize(task, task.verification[0]!);
    const receipt = authority.execute(final, parent);
    assert.equal(receipt.authorizationId, final.id);
    assert.equal(receipt.executor, "post-cutover-protected-executor");
    assert.equal(receipt.snapshotHash, inspection.snapshot.hash);
    assert.throws(() => authority.execute(final, parent), /forged, stale, or already consumed/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("post-cutover review packet rejects over-bound binary deltas and path inventories", () => {
  assert.doesNotThrow(() => assertPostCutoverReviewBounds(815_679, Array.from({ length: 45 }, (_, index) => `src/${index}.ts`)));
  assert.throws(() => assertPostCutoverReviewBounds(MAX_POST_CUTOVER_DELTA_BYTES + 1, []), /binary delta exceeds/);
  assert.throws(() => assertPostCutoverReviewBounds(1, Array.from({ length: MAX_POST_CUTOVER_CHANGED_PATHS + 1 }, (_, index) => `src/${index}.ts`)), /path inventory exceeds/);
});

test("representative installed dependency fingerprint stays within the preparation budget", { timeout: 35_000 }, () => {
  const started = performance.now();
  assert.match(postCutoverDependencyFingerprint(process.cwd()), /^sha256:[a-f0-9]{64}$/);
  assert.ok(performance.now() - started < 30_000, "representative dependency fingerprint must complete within 30 seconds");
});

test("post-cutover dependency identity rejects symlinked dependency trees", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-post-cutover-deps-"));
  try {
    const real = join(cwd, "real"); mkdirSync(real);
    const linked = join(cwd, "node_modules"); symlinkSync(real, linked, "dir");
    assert.throws(() => assertPostCutoverDependencyTree(linked), /real directory/);
    rmSync(linked); mkdirSync(linked);
    assert.doesNotThrow(() => assertPostCutoverDependencyTree(linked));
    writeFileSync(join(linked, "dependency.js"), "one\n");
    const before = postCutoverDependencyFingerprint(cwd);
    writeFileSync(join(linked, "dependency.js"), "two\n");
    assert.notEqual(postCutoverDependencyFingerprint(cwd), before);
    writeFileSync(join(cwd, "outside.js"), "outside\n"); symlinkSync(join(cwd, "outside.js"), join(linked, "escape.js"));
    assert.throws(() => postCutoverDependencyFingerprint(cwd), /escapes the isolated dependency tree/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
