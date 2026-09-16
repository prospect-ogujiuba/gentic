import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { GitWorkspaceManager, type GitWorkspaceReceipt } from "../extensions/pi-swe/src/workspace.ts";
import { createWorkflow, parseWorkflow, reduceWorkflow, scopeAllowsPath, type RunnerRole, type StageReport } from "../extensions/pi-swe/src/workflow.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-workspace-test-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.txt"), "one\n");
  writeFileSync(join(cwd, "src/b.txt"), "base\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "initial"]);
  return cwd;
}

function create(manager: GitWorkspaceManager, includeUntracked: string[] = []): GitWorkspaceReceipt {
  return manager.createWorkspace({
    topic: "workspace-tests",
    taskId: "T1",
    workspaceId: `ws-${Math.random().toString(16).slice(2)}`,
    writeScope: ["src/**"],
    includeUntracked,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
}

function discard(manager: GitWorkspaceManager, receipt: GitWorkspaceReceipt | undefined): void {
  if (receipt && existsSync(receipt.path)) manager.cleanup(receipt, { authorizeDiscard: true });
}

function stageReport(kind: StageReport["kind"], role: RunnerRole, contractHash: string, runId: string, snapshotHash?: string): StageReport {
  return {
    kind, outcome: kind === "implementation" ? "completed" : "approved", summary: `${kind} passed`, findings: [],
    provenance: { runId, role, actorId: `${role}-actor`, leaseId: `lease-${runId}`, leaseFence: 1, contractHash, snapshotHash, startedAt: "2026-02-01T00:00:00.000Z", completedAt: "2026-02-01T00:00:01.000Z" },
  };
}

test("synthetic baseline preserves dirty bytes while leaving HEAD and index untouched", () => {
  const cwd = repository();
  writeFileSync(join(cwd, "src/a.txt"), "staged\n");
  git(cwd, ["add", "src/a.txt"]);
  writeFileSync(join(cwd, "src/a.txt"), "working\n");
  writeFileSync(join(cwd, "input.txt"), "selected\n");
  writeFileSync(join(cwd, "secret.txt"), "not selected\n");
  mkdirSync(join(cwd, "ignored"));
  writeFileSync(join(cwd, "ignored/cache.bin"), Buffer.alloc(1024 * 32));
  const manager = new GitWorkspaceManager(cwd, { maxBytes: 1024 * 8 });
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const index = git(cwd, ["ls-files", "--stage"]);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager, ["input.txt"]);
    assert.equal(readFileSync(join(receipt.path, "src/a.txt"), "utf8"), "working\n");
    assert.equal(readFileSync(join(receipt.path, "input.txt"), "utf8"), "selected\n");
    assert.equal(existsSync(join(receipt.path, "secret.txt")), false);
    assert.equal(existsSync(join(receipt.path, "ignored/cache.bin")), false);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(git(cwd, ["ls-files", "--stage"]), index);
    assert.equal(receipt.realIndexTree, git(cwd, ["write-tree"]));
    assert.notEqual(receipt.stagedPatchHash, receipt.unstagedPatchHash);
    assert.match(receipt.baselineRef, /^refs\/pi-swe\/baselines\//);
  } finally { discard(manager, receipt); }
});

test("untracked inputs are explicit and authority files cannot enter the baseline", () => {
  const cwd = repository();
  writeFileSync(join(cwd, "input.txt"), "input\n");
  const manager = new GitWorkspaceManager(cwd);
  assert.throws(() => create(manager, ["missing.txt"]), /eligible untracked/);
  mkdirSync(join(cwd, ".model-artifacts/initiatives/topic"), { recursive: true });
  writeFileSync(join(cwd, ".model-artifacts/initiatives/topic/workflow.json"), "{}\n");
  assert.throws(() => create(manager, [".model-artifacts/initiatives/topic/workflow.json"]), /authority/);
  symlinkSync("../../outside", join(cwd, "src/escape"));
  assert.throws(() => create(manager, ["src/escape"]), /baseline contains an escaping symlink/);

  const literal = repository();
  writeFileSync(join(literal, ":(glob)**"), "selected magic-looking name\n");
  writeFileSync(join(literal, "secret.txt"), "must remain unselected\n");
  const secretObject = git(literal, ["hash-object", "secret.txt"]);
  assert.throws(() => git(literal, ["cat-file", "-e", secretObject]));
  const literalManager = new GitWorkspaceManager(literal);
  let literalReceipt: GitWorkspaceReceipt | undefined;
  try {
    literalReceipt = create(literalManager, [":(glob)**"]);
    assert.equal(readFileSync(join(literalReceipt.path, ":(glob)**"), "utf8"), "selected magic-looking name\n");
    assert.equal(existsSync(join(literalReceipt.path, "secret.txt")), false);
    assert.throws(() => git(literal, ["cat-file", "-e", secretObject]));
  } finally { discard(literalManager, literalReceipt); }
});

test("integration applies additions, deletions, renames, modes and symlinks without changing the index", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/new.txt"), "new\n");
    writeFileSync(join(receipt.path, "src/blob.bin"), Buffer.from([0, 255, 1, 254]));
    git(receipt.path, ["mv", "src/b.txt", "src/renamed.txt"]);
    writeFileSync(join(receipt.path, "src/a.txt"), "#!/bin/sh\necho ok\n");
    chmodSync(join(receipt.path, "src/a.txt"), 0o755);
    symlinkSync("a.txt", join(receipt.path, "src/link"));
    symlinkSync("missing", join(receipt.path, "src/dangling"));
    const index = git(cwd, ["ls-files", "--stage"]);
    const prepared = manager.prepareIntegration(receipt);
    assert.deepEqual(prepared.changedPaths, ["src/a.txt", "src/b.txt", "src/blob.bin", "src/dangling", "src/link", "src/new.txt", "src/renamed.txt"]);
    const integrated = manager.integrate(prepared, "2026-02-01T00:00:01.000Z");
    assert.equal(readFileSync(join(cwd, "src/new.txt"), "utf8"), "new\n");
    assert.deepEqual(readFileSync(join(cwd, "src/blob.bin")), Buffer.from([0, 255, 1, 254]));
    assert.equal(existsSync(join(cwd, "src/b.txt")), false);
    assert.equal(readFileSync(join(cwd, "src/renamed.txt"), "utf8"), "base\n");
    assert.equal(git(cwd, ["ls-files", "--stage"]), index);
    assert.equal(git(cwd, ["rev-parse", integrated.resultRef]), integrated.resultCommit);
    assert.equal(integrated.preSnapshotHash, receipt.baselineHash);
    assert.equal(integrated.postSnapshotHash, manager.preflight(integrated.changedPaths).sourceSnapshotHash);
    const workflow = createWorkflow({ topic: "receipt-roundtrip", goal: "persist recovery", tasks: [{ id: "T1", title: "task", writeScope: ["src/**"], nonGoals: ["none"], verification: [{ command: "true", args: [] }] }] });
    const serialized = structuredClone(workflow);
    serialized.tasks[0]!.workspaceReceipt = prepared.receipt;
    serialized.tasks[0]!.integrationReceipt = integrated;
    const parsed = parseWorkflow(serialized);
    assert.equal(parsed.tasks[0]!.workspaceReceipt?.baselineCommit, receipt.baselineCommit);
    assert.equal(parsed.tasks[0]!.workspaceReceipt?.path, receipt.path);
    assert.equal(parsed.tasks[0]!.workspaceReceipt?.realSourceSnapshotHash, receipt.realSourceSnapshotHash);
    assert.equal(parsed.tasks[0]!.workspaceReceipt?.preparedResultCommit, prepared.resultCommit);
    assert.equal(parsed.tasks[0]!.integrationReceipt?.resultRef, integrated.resultRef);

    let reduced = createWorkflow({ topic: "receipt-reducer", goal: "accept real receipts", now: "2026-02-01T00:00:00.000Z", tasks: [{ id: "T1", title: "task", writeScope: ["src/**"], nonGoals: ["none"], verification: [{ command: "true", args: [] }] }] });
    reduced = reduceWorkflow(reduced, { type: "record-plan-review", report: stageReport("plan-review", "plan-reviewer", reduced.contract.hash, "plan") }, "2026-02-01T00:00:02.000Z").workflow;
    reduced = reduceWorkflow(reduced, { type: "start" }, "2026-02-01T00:00:03.000Z").workflow;
    const taskContract = reduced.tasks[0]!.contract.hash;
    reduced = reduceWorkflow(reduced, { type: "record-implementation", report: { ...stageReport("implementation", "implementer", taskContract, "impl", prepared.receipt.snapshotHash), changedPaths: integrated.changedPaths } }, "2026-02-01T00:00:04.000Z").workflow;
    reduced = reduceWorkflow(reduced, { type: "record-review", report: stageReport("general-review", "general-reviewer", taskContract, "review", prepared.receipt.snapshotHash) }, "2026-02-01T00:00:05.000Z").workflow;
    assert.throws(() => reduceWorkflow(reduced, { type: "record-workspace", receipt: { workspaceId: "legacy", baselineHash: "old", snapshotHash: "old", changedPaths: [], createdAt: "2026-02-01T00:00:05.000Z" } }, "2026-02-01T00:00:06.000Z"), /recoverable prepared workspace receipt/);
    reduced = reduceWorkflow(reduced, { type: "record-workspace", receipt: prepared.receipt }, "2026-02-01T00:00:06.000Z").workflow;
    assert.throws(() => reduceWorkflow(reduced, { type: "record-integration", receipt: { ...integrated, patchHash: "sha256:tampered" } }, "2026-02-01T00:00:07.000Z"), /prepared workspace result/);
    reduced = reduceWorkflow(reduced, { type: "record-integration", receipt: integrated }, "2026-02-01T00:00:07.000Z").workflow;
    assert.equal(reduced.tasks[0]!.phase, "verification");
    assert.equal(reduced.tasks[0]!.workspaceReceipt?.baselineCommit, receipt.baselineCommit);
    manager.cleanup(receipt, { finalizedIntegration: integrated });
    assert.throws(() => git(cwd, ["rev-parse", integrated.resultRef]));
    receipt = undefined;
  } finally { discard(manager, receipt); }
});

test("out-of-scope and escaping symlink output is rejected before integration", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "outside.txt"), "bad\n");
    assert.throws(() => manager.prepareIntegration(receipt!), /out-of-scope/);
    writeFileSync(join(receipt.path, "outside.txt"), "");
    git(receipt.path, ["clean", "-f", "outside.txt"]);
    symlinkSync("../../escape", join(receipt.path, "src/escape"));
    assert.throws(() => manager.prepareIntegration(receipt!), /escaping symlink/);
  } finally { discard(manager, receipt); }
});

test("main checkout drift and untracked collisions block integration and retain recovery", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/new.txt"), "workspace\n");
    writeFileSync(join(cwd, "src/new.txt"), "user\n");
    assert.throws(() => manager.prepareIntegration(receipt!), /untracked collision/);
    assert.equal(existsSync(receipt.path), true);
    assert.throws(() => manager.cleanup(receipt!), /explicit authorization/);
  } finally { discard(manager, receipt); }

  const drifted = repository();
  const driftManager = new GitWorkspaceManager(drifted);
  let driftReceipt: GitWorkspaceReceipt | undefined;
  try {
    driftReceipt = create(driftManager);
    writeFileSync(join(driftReceipt.path, "src/a.txt"), "workspace\n");
    writeFileSync(join(drifted, "src/b.txt"), "user drift\n");
    assert.throws(() => driftManager.prepareIntegration(driftReceipt!), /content drifted/);
  } finally { discard(driftManager, driftReceipt); }
});

test("remediation starts from the original baseline plus cumulative integrated delta", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let first: GitWorkspaceReceipt | undefined;
  let remediation: GitWorkspaceReceipt | undefined;
  try {
    first = create(manager);
    writeFileSync(join(first.path, "src/a.txt"), "integrated\n");
    const integrated = manager.integrate(manager.prepareIntegration(first));
    remediation = manager.createRemediationWorkspace(first, integrated, "remediation-1");
    assert.equal(remediation.baselineCommit, first.baselineCommit);
    assert.equal(readFileSync(join(remediation.path, "src/a.txt"), "utf8"), "integrated\n");
    assert.deepEqual(remediation.changedPaths, ["src/a.txt"]);
    writeFileSync(join(remediation.path, "src/a.txt"), "repaired\n");
    const repaired = manager.integrate(manager.prepareIntegration(remediation));
    assert.equal(readFileSync(join(cwd, "src/a.txt"), "utf8"), "repaired\n");
    assert.deepEqual(repaired.changedPaths, ["src/a.txt"]);
    manager.cleanup(remediation, { finalizedIntegration: repaired });
    remediation = undefined;
    manager.cleanup(first, { finalizedIntegration: integrated });
    first = undefined;
  } finally {
    discard(manager, remediation);
    discard(manager, first);
  }
});

test("unsupported repository features and resource limits fail before mutation", () => {
  const cwd = repository();
  writeFileSync(join(cwd, ".gitmodules"), "[submodule \"x\"]\npath=x\nurl=../x\n");
  assert.throws(() => new GitWorkspaceManager(cwd).preflight(), /submodules/);

  const bounded = repository();
  writeFileSync(join(bounded, "src/a.txt"), Buffer.alloc(2048));
  assert.throws(() => new GitWorkspaceManager(bounded, { maxBytes: 64 }).preflight(), /byte limit/);

  const transformed = repository();
  writeFileSync(join(transformed, ".git/info/attributes"), "src/a.txt text eol=crlf\n");
  assert.throws(() => new GitWorkspaceManager(transformed).preflight(), /working-tree transform/);

  const workspaceTransformed = repository();
  const transformManager = new GitWorkspaceManager(workspaceTransformed);
  let transformReceipt: GitWorkspaceReceipt | undefined;
  try {
    transformReceipt = create(transformManager);
    writeFileSync(join(transformReceipt.path, ".gitattributes"), "src/* text eol=crlf\n");
    assert.throws(() => transformManager.prepareIntegration(transformReceipt!), /working-tree transform/);
  } finally { discard(transformManager, transformReceipt); }

  const intent = repository();
  writeFileSync(join(intent, "intent.txt"), "intent\n");
  git(intent, ["add", "-N", "intent.txt"]);
  assert.throws(() => new GitWorkspaceManager(intent).preflight(), /intent-to-add/);

  const assumed = repository();
  git(assumed, ["update-index", "--assume-unchanged", "src/a.txt"]);
  assert.throws(() => new GitWorkspaceManager(assumed).preflight(), /assume-unchanged/);
});

test("failed creation rolls back worktree administration and dangling symlinks remain fingerprinted", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);
  assert.throws(() => manager.createWorkspace({ topic: "rollback", taskId: "T1", writeScope: ["../bad"] }), /unsafe write scope/);
  assert.equal(git(cwd, ["worktree", "list", "--porcelain"]), worktrees);

  symlinkSync("missing-target", join(cwd, "src/dangling"));
  git(cwd, ["add", "src/dangling"]);
  git(cwd, ["commit", "-qm", "dangling link"]);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/a.txt"), "changed\n");
    const integrated = manager.integrate(manager.prepareIntegration(receipt));
    assert.equal(readFileSync(join(cwd, "src/a.txt"), "utf8"), "changed\n");
    manager.cleanup(receipt, { finalizedIntegration: integrated });
    receipt = undefined;
  } finally { discard(manager, receipt); }
});

test("patch, file-count, and byte work is bounded before Git ingestion", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd, { maxPatchBytes: 32 });
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/a.txt"), "x".repeat(1024));
    assert.throws(() => manager.prepareIntegration(receipt!), /patch exceeds/);
  } finally { discard(manager, receipt); }
  assert.throws(() => new GitWorkspaceManager(cwd, { maxFiles: 1 }).preflight(), /file limit/);

  const oversized = repository();
  const bounded = new GitWorkspaceManager(oversized, { maxBytes: 128 });
  let boundedReceipt: GitWorkspaceReceipt | undefined;
  try {
    boundedReceipt = create(bounded);
    writeFileSync(join(boundedReceipt.path, "src/huge.bin"), Buffer.alloc(1024, 37));
    const object = git(boundedReceipt.path, ["hash-object", "src/huge.bin"]);
    assert.throws(() => git(oversized, ["cat-file", "-e", object]));
    assert.throws(() => bounded.prepareIntegration(boundedReceipt!), /before Git ingestion/);
    assert.throws(() => git(oversized, ["cat-file", "-e", object]));
  } finally { discard(bounded, boundedReceipt); }
});

test("workspace creation intent recovers crashes before ref/worktree receipt persistence", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = manager.createWorkspace({ topic: "creation-recovery", taskId: "T1", workspaceId: "recover-create", writeScope: ["src/**"] });
    const intent = JSON.parse(readFileSync(receipt.intentPath, "utf8"));
    delete intent.receipt;
    const intentPath = receipt.intentPath;
    manager.cleanup(receipt, { authorizeDiscard: true });
    writeFileSync(intentPath, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    receipt = manager.recoverWorkspace("recover-create");
    assert.equal(readFileSync(join(receipt.path, "src/a.txt"), "utf8"), "one\n");
    assert.equal(manager.recoverWorkspace("recover-create").ownershipToken, receipt.ownershipToken);
  } finally { discard(manager, receipt); }
});

test("integration resumes from an exact post-image after an apply/persist crash", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/a.txt"), "applied before crash\n");
    const prepared = manager.prepareIntegration(receipt);
    receipt = prepared.receipt;
    execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd, input: prepared.patch });
    const carrier = createWorkflow({ topic: "crash-recovery", goal: "resume", tasks: [{ id: "T1", title: "task", writeScope: ["src/**"], nonGoals: ["none"], verification: [{ command: "true", args: [] }] }] });
    carrier.tasks[0]!.workspaceReceipt = prepared.receipt;
    const persisted = parseWorkflow(structuredClone(carrier)).tasks[0]!.workspaceReceipt as GitWorkspaceReceipt;
    const recovered = manager.integrate(manager.resumePreparedIntegration(persisted), "2026-02-01T00:00:09.000Z");
    assert.equal(readFileSync(join(cwd, "src/a.txt"), "utf8"), "applied before crash\n");
    assert.equal(recovered.postSnapshotHash, prepared.receipt.snapshotHash);
    manager.cleanup(receipt, { finalizedIntegration: recovered });
    receipt = undefined;
  } finally { discard(manager, receipt); }
});

test("cleanup is idempotent after interrupted worktree removal and rejects receipt ownership drift", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/a.txt"), "done\n");
    const prepared = manager.prepareIntegration(receipt);
    receipt = prepared.receipt;
    const integrated = manager.integrate(prepared);
    git(cwd, ["worktree", "remove", "--force", receipt.path]);
    manager.cleanup(receipt, { finalizedIntegration: integrated });
    manager.cleanup(receipt, { finalizedIntegration: integrated });
    assert.throws(() => git(cwd, ["rev-parse", receipt!.baselineRef]));
    receipt = undefined;
  } finally { discard(manager, receipt); }

  const owned = create(manager);
  try {
    const tampered = { ...owned, path: cwd };
    assert.throws(() => manager.cleanup(tampered, { authorizeDiscard: true }), /registered to another|administration directory/);
  } finally { discard(manager, owned); }
});

test("retention refs use collision checks and compare-and-delete ownership", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = manager.createWorkspace({ topic: "ref-ownership", taskId: "T1", workspaceId: "fixed-id", writeScope: ["src/**"] });
    const baseline = git(cwd, ["rev-parse", receipt.baselineRef]);
    assert.throws(() => manager.createWorkspace({ topic: "ref-ownership", taskId: "T2", workspaceId: "fixed-id", writeScope: ["src/**"] }), /retention ref already exists/);
    assert.equal(git(cwd, ["rev-parse", receipt.baselineRef]), baseline);
    git(cwd, ["update-ref", receipt.baselineRef, git(cwd, ["rev-parse", "HEAD"])]);
    assert.throws(() => manager.cleanup(receipt!, { authorizeDiscard: true }), /reassigned/);
    git(cwd, ["update-ref", receipt.baselineRef, receipt.baselineCommit]);
  } finally { discard(manager, receipt); }

  const staleRef = "refs/pi-swe/results/stale-id";
  git(cwd, ["update-ref", staleRef, git(cwd, ["rev-parse", "HEAD"])]);
  assert.throws(() => manager.createWorkspace({ topic: "ref-ownership", taskId: "T3", workspaceId: "stale-id", writeScope: ["src/**"] }), /retention ref already exists/);
  git(cwd, ["update-ref", "-d", staleRef]);

  let retry: GitWorkspaceReceipt | undefined;
  try {
    retry = create(manager);
    writeFileSync(join(retry.path, "src/a.txt"), "prepared\n");
    const first = manager.prepareIntegration(retry);
    const afterCrash = manager.prepareIntegration(retry);
    assert.equal(afterCrash.resultCommit, first.resultCommit);
    retry = afterCrash.receipt;
  } finally { discard(manager, retry); }
});

test("prepared integration metadata is immutable and write-scope glob semantics are shared", () => {
  const cwd = repository();
  const manager = new GitWorkspaceManager(cwd);
  let receipt: GitWorkspaceReceipt | undefined;
  try {
    receipt = create(manager);
    writeFileSync(join(receipt.path, "src/a.txt"), "changed\n");
    const prepared = manager.prepareIntegration(receipt);
    receipt = prepared.receipt;
    prepared.patch = Buffer.from("tampered");
    assert.throws(() => manager.integrate(prepared), /patch was modified/);
  } finally { discard(manager, receipt); }
  assert.equal(scopeAllowsPath("test/pi-swe*.test.ts", "test/pi-swe-workspace.test.ts"), true);
  assert.equal(scopeAllowsPath("src/**", "src/deep/file.ts"), true);
  assert.equal(scopeAllowsPath("src/*.ts", "src/deep/file.ts"), false);
});
