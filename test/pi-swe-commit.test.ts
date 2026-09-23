import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { completionCommitCommand, completionCommitMessage, prepareCompletionCommit } from "../extensions/pi-swe/src/app/completion-commit.ts";
import { contractFingerprint, parseInitiative } from "../extensions/pi-swe/src/domain/initiative.ts";

const source = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-commit-"));
  const authority = ".model-artifacts/initiatives/scoped-commit/workflow.json";
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(dirname(join(root, authority)), { recursive: true });
  writeFileSync(join(root, "src/task.ts"), "export const value = 1;\n");
  writeFileSync(join(root, authority), "revision 1\n");
  writeFileSync(join(root, "unrelated.txt"), "baseline\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Pi SWE Test");
  git(root, "config", "user.email", "pi-swe@example.invalid");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "chore: baseline");
  return { root, authority };
}

test("completion commit uses an isolated index, preserves unrelated staged changes, and never pushes", () => {
  const { root, authority } = repositoryFixture();
  try {
    writeFileSync(join(root, "src/task.ts"), "export const value = 2;\n");
    writeFileSync(join(root, authority), "revision 2\n");
    writeFileSync(join(root, "unrelated.txt"), "user change\n");
    git(root, "add", "unrelated.txt");

    const command = completionCommitCommand("W-1", "feat: commit completed work item", ["src/task.ts", authority]);
    assert.doesNotMatch(command, /git push/);
    execFileSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" });

    assert.equal(git(root, "log", "-1", "--pretty=%s"), "feat: commit completed work item");
    assert.deepEqual(git(root, "show", "--pretty=format:", "--name-only", "HEAD").split("\n").filter(Boolean).sort(), [authority, "src/task.ts"].sort());
    assert.equal(git(root, "show", "HEAD:unrelated.txt"), "baseline");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "unrelated.txt");
    assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "user change\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion commit reports empty scope and hook failure without changing HEAD", () => {
  const { root, authority } = repositoryFixture();
  try {
    const command = completionCommitCommand("W-1", "fix: preserve completion state", ["src/task.ts", authority]);
    const empty = spawnSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" });
    assert.equal(empty.status, 42);
    assert.match(empty.stderr, /no scoped changes.*work item remains complete/i);

    writeFileSync(join(root, "src/task.ts"), "export const value = 3;\n");
    writeFileSync(join(root, authority), "revision 2\n");
    const before = git(root, "rev-parse", "HEAD");
    const hook = join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho intentional hook failure >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const failed = spawnSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /intentional hook failure/i);
    assert.equal(git(root, "rev-parse", "HEAD"), before);
    assert.match(git(root, "status", "--short"), /src\/task\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion commit derives deterministic safe paths and a message from current passing evidence", () => {
  const base = parseInitiative({ ...structuredClone(source), evidence: [] });
  assert.deepEqual(prepareCompletionCommit(base, "W-1"), {});
  assert.deepEqual(prepareCompletionCommit(parseInitiative({ ...base, policies: { commitOnWorkCompletion: false } }), "W-1"), {});

  const enabled = parseInitiative({ ...base, policies: { commitOnWorkCompletion: true } });
  const work = enabled.work.find((item) => item.id === "W-1")!;
  const review = {
    id: "E-commit-paths", kind: "model-review", workId: "W-1", obligationIds: [work.obligationIds![0]], outcome: "passed",
    reviewedAt: "2026-09-23T19:00:00.000Z", contractFingerprint: contractFingerprint(enabled),
    source: { kind: "bounded-paths", paths: ["test/task.test.ts", "src/task.ts", "src/task.ts", ".gitignore", ".model-artifacts/initiatives/example/logs/run.md", "src/*.ts"], hash: `sha256:${"0".repeat(64)}` },
    dimensions: ["correctness"], summary: "Reviewed completion commit attribution.",
    provenance: { kind: "pi-model-self-review", sessionId: "test-session" },
  };
  const prepared = prepareCompletionCommit(parseInitiative({ ...enabled, evidence: [review] }), "W-1").completionCommit;
  assert.deepEqual(prepared?.paths, ["src/task.ts", "test/task.test.ts", ".model-artifacts/initiatives/pi-swe-foundation/workflow.json"]);
  assert.equal(prepared?.message, "feat: characterize and repair dangling post deletion integration");
  assert.match(prepared?.command ?? "", /GIT_INDEX_FILE=.*git commit -m 'feat: characterize and repair dangling post deletion integration'/);
  assert.equal(completionCommitMessage("!!!", "W-1"), "feat: complete w 1");
  assert.ok(completionCommitMessage("A".repeat(200), "W-1").length <= 120);

  const unsafeOnly = { ...review, id: "E-unsafe-only", source: { ...review.source, paths: [".gitignore", "src/*.ts"] } };
  const blocked = prepareCompletionCommit(parseInitiative({ ...enabled, evidence: [unsafeOnly] }), "W-1");
  assert.match(blocked.completionCommitError ?? "", /no safe attributable paths.*remains complete/i);
});
