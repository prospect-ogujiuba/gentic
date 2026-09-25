import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitSnapshot } from "../extensions/pi-git/index.ts";
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

function providerSnapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    ok: true,
    root: "/repo",
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    remotes: [],
    truncated: { status: false, remotes: false },
    errors: [],
    ...overrides,
  };
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

test("snapshot service forwards the bounded HUD response deadline", async () => {
  let observedTimeout: number | undefined;
  const service = new GitSnapshotService({
    debounceMs: 0,
    timeoutMs: 17,
    collector: async (_cwd, options) => {
      observedTimeout = options.timeoutMs;
      return undefined;
    },
  });

  await service.requestRefresh("/repo");
  assert.equal(observedTimeout, 17);
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

test("unavailable and error results use bounded retry cooldowns that reset by generation", async () => {
  let now = 1_000;
  let calls = 0;
  let fail = false;
  const service = new GitSnapshotService({
    debounceMs: 0,
    retryCooldownMs: 1_000,
    now: () => now,
    collector: async () => {
      calls += 1;
      if (fail) throw new Error("broken");
      return undefined;
    },
  });

  assert.equal((await service.requestRefresh("/repo")).status, "unavailable");
  now = 1_999;
  assert.equal((await service.requestRefresh("/repo")).status, "unavailable");
  assert.equal(calls, 1);
  now = 2_000;
  fail = true;
  assert.equal((await service.requestRefresh("/repo")).status, "error");
  now = 2_999;
  assert.equal((await service.requestRefresh("/repo")).status, "error");
  assert.equal(calls, 2);

  service.reset("/other");
  assert.equal((await service.requestRefresh("/other")).status, "error");
  assert.equal(calls, 3, "explicit reset must bypass the previous generation's negative cache");
  service.dispose();
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

test("Git adapter projects the stable provider snapshot without running Git itself", async () => {
  const controller = new AbortController();
  let observedCwd: string | undefined;
  let observedSignal: AbortSignal | undefined;
  const status = await collectGitStatus("/repo", { signal: controller.signal }, async (cwd, signal) => {
    observedCwd = cwd;
    observedSignal = signal;
    return providerSnapshot({
      branch: "feature/provider",
      upstream: "origin/feature/provider",
      ahead: 2,
      behind: 1,
      clean: false,
      staged: [{ code: "M ", path: "staged.ts" }],
      unstaged: [{ code: " M", path: "unstaged.ts" }],
      untracked: ["new.ts"],
      conflicts: [{ code: "UU", path: "conflict.ts" }],
    });
  });

  assert.equal(observedCwd, "/repo");
  assert.ok(observedSignal);
  assert.notStrictEqual(observedSignal, controller.signal, "HUD deadline uses a derived provider signal");
  assert.equal(observedSignal.aborted, false);
  assert.deepEqual(status, {
    branch: "feature/provider",
    dirty: true,
    stagedCount: 2,
    unstagedCount: 2,
    untrackedCount: 1,
    upstream: "origin/feature/provider",
    remoteName: "origin",
    aheadCount: 2,
    behindCount: 1,
  });
});

test("Git adapter settles its deadline while cancelling an uncooperative provider", async () => {
  let observedAbort = false;
  const pending = collectGitStatus("/repo", { timeoutMs: 10 }, (_cwd, signal) => new Promise(() => {
    signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
  }));
  const bounded = Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("deadline did not settle")), 100)),
  ]);

  await assert.rejects(
    bounded,
    (error: unknown) => error instanceof GitCollectionError && error.code === "timeout",
  );
  assert.equal(observedAbort, true);
});

test("Git adapter maps unavailable, failed, truncated, timed out, and cancelled provider results", async () => {
  const unavailable = async () => providerSnapshot({
    ok: false,
    root: undefined,
    errors: [{ command: "git rev-parse --show-toplevel", code: 128, message: "not a repository", killed: false }],
  });
  assert.equal(await collectGitStatus("/not-a-repo", {}, unavailable), undefined);

  const timedOut = async () => providerSnapshot({
    ok: false,
    root: undefined,
    errors: [{ command: "git rev-parse --show-toplevel", code: 143, message: "root timed out", killed: true }],
  });
  await assert.rejects(
    collectGitStatus("/repo", {}, timedOut),
    (error: unknown) => error instanceof GitCollectionError && error.code === "timeout",
  );

  const failed = async () => providerSnapshot({
    ok: false,
    errors: [{ command: "git status", code: 2, message: "status failed", killed: false }],
  });
  await assert.rejects(
    collectGitStatus("/repo", {}, failed),
    (error: unknown) => error instanceof GitCollectionError && error.code === "command-failure" && error.message === "status failed",
  );
  await assert.rejects(
    collectGitStatus("/repo", {}, async () => providerSnapshot({ truncated: { status: true, remotes: false } })),
    (error: unknown) => error instanceof GitCollectionError && error.code === "output-limit",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectGitStatus("/repo", { signal: controller.signal }, async () => { throw new Error("aborted"); }),
    (error: unknown) => error instanceof GitCollectionError && error.code === "cancelled",
  );
});
