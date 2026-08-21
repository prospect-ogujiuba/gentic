import assert from "node:assert/strict";
import test from "node:test";

import { renderSnapshot, snapshot, type ExecResult } from "../extensions/pi-git/src/app/snapshot.ts";

function fixture(results: Record<string, ExecResult>) {
  const calls: string[] = [];
  const pi = {
    async exec(command: string, args: string[], options: { signal?: AbortSignal }) {
      assert.equal(command, "git");
      options.signal?.throwIfAborted();
      const key = args.join(" ");
      calls.push(key);
      return results[key] ?? { code: 1, stderr: `missing fixture: ${key}` };
    },
  } as any;
  const ctx = { cwd: "/repo" } as any;
  return { pi, ctx, calls };
}

test("git snapshot returns a typed non-repository failure", async () => {
  const { pi, ctx, calls } = fixture({ "rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" } });
  const result = await snapshot(pi, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.root, undefined);
  assert.equal(result.errors[0]?.code, 128);
  assert.deepEqual(calls, ["rev-parse --show-toplevel"]);
  assert.match(renderSnapshot(result), /git snapshot: error/);
});

test("git snapshot renders full bounded scope including unusual filenames", async () => {
  const status = [
    "## main...origin/main [ahead 2, behind 1]",
    "M  staged.ts",
    " M unstaged.ts",
    "?? odd\nname.txt",
    "UU conflict.ts",
    "",
  ].join("\0");
  const { pi, ctx, calls } = fixture({
    "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
    "status --porcelain=v1 --branch -z --untracked-files=all": { code: 0, stdout: status },
    "remote -v": { code: 0, stdout: "origin\thttps://example.test/repo.git (fetch)\norigin\thttps://example.test/repo.git (push)\n" },
  });
  const result = await snapshot(pi, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.branch, "main");
  assert.equal(result.upstream, "origin/main");
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.equal(result.staged[0]?.path, "staged.ts");
  assert.equal(result.unstaged[0]?.path, "unstaged.ts");
  assert.equal(result.untracked[0], "odd\nname.txt");
  assert.equal(result.conflicts[0]?.path, "conflict.ts");
  const rendered = renderSnapshot(result);
  for (const field of ["staged (1)", "unstaged (1)", "untracked (1)", "conflicts (1)", "remotes (2)"]) assert.match(rendered, new RegExp(field.replace(/[()]/g, "\\$&")));
  assert.equal(calls.length, 3);
});

test("git snapshot distinguishes detached no-upstream state and typed command timeout", async () => {
  const { pi, ctx } = fixture({
    "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
    "status --porcelain=v1 --branch -z --untracked-files=all": { code: 0, stdout: "## HEAD (no branch)\0" },
    "remote -v": { code: 143, stderr: "timed out", killed: true },
  });
  const result = await snapshot(pi, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.detached, true);
  assert.equal(result.upstream, undefined);
  assert.equal(result.errors[0]?.killed, true);
  assert.equal(result.remotes.length, 0);
});

test("git snapshot propagates cancellation before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const { pi, ctx } = fixture({});
  await assert.rejects(() => snapshot(pi, ctx, controller.signal), /abort/i);
});
