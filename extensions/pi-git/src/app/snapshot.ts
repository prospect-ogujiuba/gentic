import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GitFailure, GitPath, GitRemote, GitSnapshot } from "../../../../src/contracts/git-snapshot.ts";
import {
  execBounded,
  MAX_CAPTURE_BYTES,
  type BoundedProcessResult,
} from "../../../../src/services/bounded-process.ts";
import {
  emptyGitSnapshot,
  gitFailure,
  gitSucceeded,
  parseGitRemotes,
  parseGitStatus,
  parseRepositoryRoot,
} from "./parse.ts";

export { execBounded, MAX_CAPTURE_BYTES } from "../../../../src/services/bounded-process.ts";
export type ExecResult = BoundedProcessResult;
export type { GitFailure, GitPath, GitRemote, GitSnapshot } from "../../../../src/contracts/git-snapshot.ts";

/** Legacy private runner shape retained for characterization and current internal consumers. */
export type GitRunner = (args: string[], ctx: ExtensionContext, signal?: AbortSignal) => Promise<BoundedProcessResult>;
export type GitCommandRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<BoundedProcessResult>;

const defaultGitRunner: GitCommandRunner = (args, cwd, signal) => execBounded("git", args, cwd, signal);

/** Registration-free Git collection service exported by the pi-git public entrypoint. */
export function collectGitSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshot>;
export function collectGitSnapshot(cwd: string, signal: AbortSignal | undefined, runner: GitCommandRunner): Promise<GitSnapshot>;
export async function collectGitSnapshot(
  cwd: string,
  signal?: AbortSignal,
  runner: GitCommandRunner = defaultGitRunner,
): Promise<GitSnapshot> {
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const rootResult = await runner(rootArgs, cwd, signal);
  const repository = parseRepositoryRoot(rootResult);
  if (repository.error) return emptyGitSnapshot(repository.error);
  const root = repository.root as string;

  const statusArgs = ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"];
  const remoteArgs = ["remote", "-v"];
  const [statusResult, remoteResult] = await Promise.all([
    runner(statusArgs, cwd, signal),
    runner(remoteArgs, cwd, signal),
  ]);
  const errors: GitFailure[] = [];
  if (!gitSucceeded(statusResult)) errors.push(gitFailure(statusArgs, statusResult));
  if (!gitSucceeded(remoteResult)) errors.push(gitFailure(remoteArgs, remoteResult));
  const status = gitSucceeded(statusResult)
    ? parseGitStatus(statusResult.stdout || "", statusResult.stdoutTruncated === true)
    : { branch: undefined, detached: false, upstream: undefined, ahead: 0, behind: 0, clean: false, staged: [] as GitPath[], unstaged: [] as GitPath[], untracked: [] as string[], conflicts: [] as GitPath[], truncated: statusResult.stdoutTruncated === true };
  const remote = gitSucceeded(remoteResult)
    ? parseGitRemotes(remoteResult.stdout || "", remoteResult.stdoutTruncated === true)
    : { remotes: [] as GitRemote[], truncated: remoteResult.stdoutTruncated === true };
  return {
    ok: errors.length === 0,
    root,
    ...status,
    remotes: remote.remotes,
    truncated: { status: status.truncated, remotes: remote.truncated },
    errors,
  };
}

/** Compatibility adapter for the original Pi-context-shaped private API. */
export async function snapshot(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  runner?: GitRunner,
): Promise<GitSnapshot> {
  return collectGitSnapshot(
    ctx.cwd,
    signal,
    runner ? (args, _cwd, runSignal) => runner(args, ctx, runSignal) : defaultGitRunner,
  );
}
