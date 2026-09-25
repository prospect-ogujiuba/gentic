import assert from "node:assert/strict";
import test from "node:test";

import piGit, { collectGitSnapshot, type GitSnapshot } from "../extensions/pi-git/index.ts";
import { snapshot, type ExecResult } from "../extensions/pi-git/src/app/snapshot.ts";
import { registerPiGit } from "../extensions/pi-git/src/pi/register.ts";
import { renderSnapshot } from "../extensions/pi-git/src/ui/render.ts";
import { execBounded, MAX_CAPTURE_BYTES } from "../src/services/bounded-process.ts";

function fixture(results: Record<string, ExecResult>) {
  const calls: string[] = [];
  const pi = {} as any;
  const ctx = { cwd: "/repo" } as any;
  const run = async (args: string[], _ctx: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const key = args.join(" ");
    calls.push(key);
    return results[key] ?? { code: 1, stderr: `missing fixture: ${key}` };
  };
  return { pi, ctx, calls, run };
}

test("git snapshot returns a typed non-repository failure", async () => {
  const { pi, ctx, calls, run } = fixture({ "rev-parse --show-toplevel": { code: 128, stderr: "fatal: not a git repository" } });
  const result = await snapshot(pi, ctx, undefined, run);
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
  const { pi, ctx, calls, run } = fixture({
    "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
    "status --porcelain=v1 --branch -z --untracked-files=all": { code: 0, stdout: status },
    "remote -v": { code: 0, stdout: "origin\thttps://example.test/repo.git (fetch)\norigin\thttps://example.test/repo.git (push)\n" },
  });
  const result = await snapshot(pi, ctx, undefined, run);
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
  const { pi, ctx, run } = fixture({
    "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
    "status --porcelain=v1 --branch -z --untracked-files=all": { code: 0, stdout: "## HEAD (no branch)\0" },
    "remote -v": { code: 143, stderr: "timed out", killed: true },
  });
  const result = await snapshot(pi, ctx, undefined, run);
  assert.equal(result.ok, false);
  assert.equal(result.detached, true);
  assert.equal(result.upstream, undefined);
  assert.equal(result.errors[0]?.killed, true);
  assert.equal(result.errors[0]?.command, "git remote -v");
  assert.equal(result.errors[0]?.code, 143);
  assert.equal(result.remotes.length, 0);
  assert.match(renderSnapshot(result), /git remote -v code=143 killed=true: timed out/);
});

test("git snapshot propagates cancellation before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const { pi, ctx, run } = fixture({});
  await assert.rejects(() => snapshot(pi, ctx, controller.signal, run), /abort/i);
});

test("bounded process capture retains only the configured byte prefix", async () => {
  const result = await execBounded(process.execPath, ["-e", `process.stdout.write("x".repeat(${MAX_CAPTURE_BYTES + 8_192})); process.stderr.write("y".repeat(${MAX_CAPTURE_BYTES + 4_096}))`], process.cwd());
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout ?? "", "utf8"), MAX_CAPTURE_BYTES);
  assert.equal(Buffer.byteLength(result.stderr ?? "", "utf8"), MAX_CAPTURE_BYTES);

  const missing = await execBounded("gentic-command-that-does-not-exist", [], process.cwd());
  assert.equal(missing.code, 1);
  assert.match(missing.stderr ?? "", /ENOENT/);
});

test("bounded process capture preserves cancellation and timeout semantics", async () => {
  const controller = new AbortController();
  const cancelled = execBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], process.cwd(), controller.signal);
  controller.abort(new Error("cancel git collection"));
  await assert.rejects(cancelled, /cancel git collection|abort/i);

  const timedOut = await execBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], process.cwd(), undefined, 20);
  assert.equal(timedOut.killed, true);
  assert.notEqual(timedOut.code, 0);

  const started = performance.now();
  const resistant = await execBounded(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000)"],
    process.cwd(),
    undefined,
    200,
  );
  assert.equal(resistant.killed, true);
  assert.ok(performance.now() - started < 1_000, "timeout must escalate when a child ignores SIGTERM");
});

test("snapshot bounds public fields and observes byte truncation without emitting partial renames", async () => {
  const complete = `## main...origin/main\0R  renamed.ts\0original.ts\0`;
  const partial = `R  cut.ts\0${"x".repeat(5_000)}`;
  const { pi, ctx, run } = fixture({
    "rev-parse --show-toplevel": { code: 0, stdout: "/repo\n" },
    "status --porcelain=v1 --branch -z --untracked-files=all": { code: 0, stdout: complete + partial, stdoutTruncated: true },
    "remote -v": { code: 0, stdout: `origin\thttps://example.test/${"u".repeat(5_000)} (fetch)\n`, stdoutTruncated: true },
  });
  const result = await snapshot(pi, ctx, undefined, run);
  assert.equal(result.root, "/repo");
  assert.equal(result.staged.length, 1);
  assert.equal(result.staged[0]?.path, "renamed.ts");
  assert.equal(result.staged[0]?.originalPath, "original.ts");
  assert.equal(result.remotes[0]?.url.length, 4_096);
  assert.equal(result.truncated.status, true);
  assert.equal(result.truncated.remotes, true);

  const failed = fixture({ "rev-parse --show-toplevel": { code: 1, stderr: `bad\n${"e".repeat(20_000)}` } });
  const failure = await snapshot(failed.pi, failed.ctx, undefined, failed.run);
  assert.ok((failure.errors[0]?.message.length ?? 0) <= 8_192);
  assert.doesNotMatch(failure.errors[0]?.message ?? "", /[\r\n]/);

  const oversizedRoot = fixture({ "rev-parse --show-toplevel": { code: 0, stdout: `/${"r".repeat(5_000)}\n` } });
  const rejectedRoot = await snapshot(oversizedRoot.pi, oversizedRoot.ctx, undefined, oversizedRoot.run);
  assert.equal(rejectedRoot.ok, false);
  assert.equal(rejectedRoot.root, undefined);
  assert.match(rejectedRoot.errors[0]?.message ?? "", /output bound/);
});

test("supported service and contract imports have no Pi registration side effects", async () => {
  let registrations = 0;
  const pi = {
    registerTool() { registrations += 1; },
    registerCommand() { registrations += 1; },
  } as any;
  assert.equal(registrations, 0);
  assert.equal(typeof collectGitSnapshot, "function");
  const typed: GitSnapshot = await collectGitSnapshot(process.cwd());
  assert.equal(typeof typed.ok, "boolean");
  assert.equal(registrations, 0);

  piGit(pi);
  assert.equal(registrations, 2, "registration remains explicit through the default adapter");
});

test("git_snapshot and /pi-git preserve the same rendered adapter contract", async () => {
  let registeredTool: any;
  let registeredCommand: any;
  const pi = {
    registerTool(tool: unknown) { registeredTool = tool; },
    registerCommand(name: string, command: unknown) {
      assert.equal(name, "pi-git");
      registeredCommand = command;
    },
  } as any;
  registerPiGit(pi);
  assert.equal(registeredTool.name, "git_snapshot");
  assert.deepEqual(registeredTool.parameters, { type: "object", properties: {} });

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: process.cwd(),
    signal: undefined,
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
  } as any;
  const toolResult = await registeredTool.execute("call-1", {}, undefined, () => undefined, ctx);
  assert.equal(toolResult.content.length, 1);
  assert.equal(toolResult.content[0].type, "text");
  assert.equal(toolResult.content[0].text, renderSnapshot(toolResult.details));
  assert.equal(typeof toolResult.details.ok, "boolean");
  assert.ok(Array.isArray(toolResult.details.errors));

  await registeredCommand.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.equal(notifications[0]?.message, toolResult.content[0].text);
});

test("git_snapshot and /pi-git propagate pre-execution cancellation", async () => {
  let registeredTool: any;
  let registeredCommand: any;
  const pi = {
    registerTool(tool: unknown) { registeredTool = tool; },
    registerCommand(_name: string, command: unknown) { registeredCommand = command; },
  } as any;
  registerPiGit(pi);
  const controller = new AbortController();
  controller.abort(new Error("cancel adapter snapshot"));
  const ctx = { cwd: process.cwd(), signal: controller.signal, ui: { notify() {} } } as any;

  await assert.rejects(
    registeredTool.execute("call-1", {}, controller.signal, () => undefined, ctx),
    /cancel adapter snapshot|abort/i,
  );
  await assert.rejects(registeredCommand.handler("", ctx), /cancel adapter snapshot|abort/i);
});
