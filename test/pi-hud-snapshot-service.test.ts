import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitCollectionError, collectGitStatus } from "../extensions/pi-hud/src/app/git-status.ts";
import { GitSnapshotService } from "../extensions/pi-hud/src/app/git-snapshot-service.ts";
import type { GitStatus } from "../extensions/pi-hud/types.ts";

const cleanStatus: GitStatus = {
  branch: "main",
  dirty: false,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  aheadCount: 0,
  behindCount: 0,
};

async function fakeGit(source: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hud-git-"));
  const path = join(directory, "git");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("snapshot service debounces and coalesces one refresh per generation", async () => {
  let calls = 0;
  const service = new GitSnapshotService({
    debounceMs: 10,
    collector: async () => { calls += 1; return cleanStatus; },
  });
  service.reset("/repo");

  const first = service.requestRefresh("/repo");
  const second = service.requestRefresh("/repo");
  assert.strictEqual(first, second);
  assert.equal(service.getState().status, "loading");
  assert.equal(calls, 0);

  const result = await first;
  assert.equal(calls, 1);
  assert.equal(result.status, "fresh");
  assert.equal(result.snapshot?.branch, "main");
  service.dispose();
});

test("snapshot service exposes stale state and preserves last good value on error", async () => {
  let now = 100;
  let calls = 0;
  const service = new GitSnapshotService({
    debounceMs: 0,
    freshnessMs: 10,
    now: () => now,
    collector: async () => {
      calls += 1;
      if (calls === 1) return cleanStatus;
      throw new GitCollectionError("command-failure", "status failed");
    },
  });

  assert.equal((await service.requestRefresh("/repo")).status, "fresh");
  now += 11;
  assert.equal(service.getState().status, "stale");
  const failed = await service.requestRefresh("/repo");
  assert.equal(failed.status, "stale");
  assert.equal(failed.snapshot?.branch, "main");
  assert.equal(failed.error?.code, "command-failure");
  service.dispose();
});

test("snapshot service distinguishes unavailable and error without valid Git fields", async () => {
  const unavailableService = new GitSnapshotService({ debounceMs: 0, collector: async () => undefined });
  const unavailable = await unavailableService.requestRefresh("/not-a-repo");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.snapshot, undefined);
  unavailableService.dispose();

  const errorService = new GitSnapshotService({ debounceMs: 0, collector: async () => { throw new Error("broken"); } });
  const failed = await errorService.requestRefresh("/repo");
  assert.equal(failed.status, "error");
  assert.equal(failed.snapshot, undefined);
  assert.equal(failed.error?.message, "broken");
  errorService.dispose();
});

test("snapshot reset aborts work and rejects a late generation result", async () => {
  let complete!: (status: GitStatus) => void;
  let observedAbort = false;
  const service = new GitSnapshotService({
    debounceMs: 0,
    collector: (_cwd, options) => new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      complete = resolve;
    }),
  });
  service.reset("/old");
  const oldRefresh = service.requestRefresh("/old");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const oldGeneration = service.currentGeneration();

  service.reset("/new");
  complete({ ...cleanStatus, branch: "old-branch" });
  await oldRefresh;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(observedAbort, true);
  assert.equal(service.currentGeneration(), oldGeneration + 1);
  assert.equal(service.getState("/new").status, "unavailable");
  assert.equal(service.getState("/new").snapshot, undefined);
  service.dispose();
});

test("snapshot disposal clears debounce work without launching a collector", async () => {
  let calls = 0;
  const service = new GitSnapshotService({ debounceMs: 1_000, collector: async () => { calls += 1; return cleanStatus; } });
  const pending = service.requestRefresh("/repo");
  service.dispose();
  await pending;

  assert.equal(calls, 0);
  assert.equal(service.hasPendingWork(), false);
});

test("async Git collector leaves timers responsive for a slow repository", async () => {
  const executable = await fakeGit(`
const args = process.argv.slice(2).join(" ");
setTimeout(() => {
  if (args === "rev-parse --show-toplevel") console.log("/repo");
  else if (args === "branch --show-current") console.log("main");
  else if (args === "status --porcelain=v1") console.log(" M file.ts");
  else process.exit(1);
}, 20);
`);
  try {
    let timerFired = false;
    const pending = collectGitStatus(process.cwd(), { gitPath: executable.path, timeoutMs: 2_000, maxOutputBytes: 4_096 });
    await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 0));
    assert.equal(timerFired, true);
    assert.equal((await pending)?.unstagedCount, 1);
  } finally {
    await executable.cleanup();
  }
});

test("async Git collector bounds timeout, output, non-repo, command failure, and cancellation", async () => {
  const timeoutGit = await fakeGit(`setTimeout(() => console.log("/repo"), 200);`);
  const outputGit = await fakeGit(`
const args = process.argv.slice(2).join(" ");
if (args === "rev-parse --show-toplevel") console.log("/repo");
else if (args === "branch --show-current") console.log("x".repeat(2000));
else console.log("");
`);
  const failureGit = await fakeGit(`
const args = process.argv.slice(2).join(" ");
if (args === "rev-parse --show-toplevel") console.log("/repo");
else if (args === "branch --show-current") console.log("main");
else if (args === "status --porcelain=v1") { console.error("status exploded with bounded detail"); process.exit(2); }
else process.exit(1);
`);
  const nonRepoGit = await fakeGit(`process.exit(1);`);

  try {
    await assert.rejects(collectGitStatus(process.cwd(), { gitPath: timeoutGit.path, timeoutMs: 20 }), (error: unknown) => error instanceof GitCollectionError && error.code === "timeout");
    await assert.rejects(collectGitStatus(process.cwd(), { gitPath: outputGit.path, maxOutputBytes: 128 }), (error: unknown) => error instanceof GitCollectionError && error.code === "output-limit");
    await assert.rejects(collectGitStatus(process.cwd(), { gitPath: failureGit.path }), (error: unknown) => error instanceof GitCollectionError && error.code === "command-failure" && error.message.length <= 200);
    assert.equal(await collectGitStatus(process.cwd(), { gitPath: nonRepoGit.path }), undefined);

    const controller = new AbortController();
    const cancelled = collectGitStatus(process.cwd(), { gitPath: timeoutGit.path, timeoutMs: 500, signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => error instanceof GitCollectionError && error.code === "cancelled");
  } finally {
    await Promise.all([timeoutGit.cleanup(), outputGit.cleanup(), failureGit.cleanup(), nonRepoGit.cleanup()]);
  }
});
