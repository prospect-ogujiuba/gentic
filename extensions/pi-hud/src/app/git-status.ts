import { execBounded, type ExecResult } from "../../../pi-git/src/app/snapshot.ts";
import { normalizeGitStatus } from "../domain/git-status.ts";
import type { GitStatus } from "../../types.ts";

export type GitCollectionErrorCode = "cancelled" | "timeout" | "output-limit" | "command-failure";

export class GitCollectionError extends Error {
  readonly code: GitCollectionErrorCode;

  constructor(code: GitCollectionErrorCode, message: string) {
    super(message.slice(0, 200));
    this.name = "GitCollectionError";
    this.code = code;
  }
}

export interface GitCollectorOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  gitPath?: string;
}

function commandDetail(args: string[], stderr: string): string {
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 120);
  return detail ? `git ${args[0]} failed: ${detail}` : `git ${args[0]} failed`;
}

export async function collectGitStatus(cwd: string, options: GitCollectorOptions = {}): Promise<GitStatus | undefined> {
  const timeoutMs = options.timeoutMs ?? 800;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const controller = new AbortController();
  let timedOut = false;
  let remainingBytes = Math.max(1, maxOutputBytes);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("git collection timed out"));
  }, Math.max(1, timeoutMs));
  timeout.unref?.();

  const run = async (args: string[], allowExitFailure = false): Promise<string | undefined> => {
    let result: ExecResult;
    try {
      result = await execBounded(options.gitPath ?? "git", args, cwd, controller.signal, timeoutMs + 1_000, remainingBytes);
    } catch {
      if (timedOut) throw new GitCollectionError("timeout", `Git collection exceeded ${timeoutMs}ms`);
      if (options.signal?.aborted) throw new GitCollectionError("cancelled", "Git collection cancelled");
      throw new GitCollectionError("command-failure", `git ${args[0]} failed`);
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    remainingBytes = Math.max(0, remainingBytes - outputBytes);

    if (timedOut) throw new GitCollectionError("timeout", `Git collection exceeded ${timeoutMs}ms`);
    if (options.signal?.aborted) throw new GitCollectionError("cancelled", "Git collection cancelled");
    if (result.stdoutTruncated || result.stderrTruncated || remainingBytes === 0 && outputBytes > 0) {
      throw new GitCollectionError("output-limit", `Git output exceeded ${maxOutputBytes} bytes`);
    }
    if (result.code !== 0 || result.killed) {
      if (allowExitFailure) return undefined;
      throw new GitCollectionError("command-failure", commandDetail(args, stderr));
    }
    return stdout;
  };

  try {
    const root = (await run(["rev-parse", "--show-toplevel"], true))?.trim();
    if (!root) return undefined;

    const branch = (await run(["branch", "--show-current"], true))?.trim()
      || (await run(["rev-parse", "--short", "HEAD"], true))?.trim()
      || "detached";
    const porcelain = (await run(["status", "--porcelain=v1"]))?.trimEnd() ?? "";
    const upstream = (await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true))?.trim() || undefined;
    const aheadBehind = upstream ? (await run(["rev-list", "--left-right", "--count", "HEAD...@{u}"]))?.trim() : undefined;

    return normalizeGitStatus({ branch, porcelain, upstream, aheadBehind });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
