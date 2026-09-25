import {
  collectGitSnapshot,
  type GitSnapshot,
  type GitSnapshotCollector,
} from "../../../pi-git/index.ts";
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
}

/** Adapt pi-git's stable snapshot contract to the HUD's presentation state. */
export async function collectGitStatus(
  cwd: string,
  options: GitCollectorOptions = {},
  collector: GitSnapshotCollector = collectGitSnapshot,
): Promise<GitStatus | undefined> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 800;
  let interrupt!: (error: GitCollectionError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const abort = () => {
    interrupt(new GitCollectionError("cancelled", "Git collection cancelled"));
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    interrupt(new GitCollectionError("timeout", `Git collection exceeded ${timeoutMs}ms`));
    controller.abort(new Error("HUD Git collection timed out"));
  }, Math.max(1, timeoutMs));
  timeout.unref?.();

  try {
    let snapshot: GitSnapshot;
    try {
      const collection = Promise.resolve().then(() => collector(cwd, controller.signal));
      snapshot = await Promise.race([collection, interrupted]);
    } catch (error) {
      if (error instanceof GitCollectionError) throw error;
      if (options.signal?.aborted) throw new GitCollectionError("cancelled", "Git collection cancelled");
      throw new GitCollectionError("command-failure", error instanceof Error ? error.message : "Git collection failed");
    }

    if (!snapshot.root) {
      const killed = snapshot.errors.find((error) => error.killed);
      if (killed) {
        throw new GitCollectionError("timeout", killed.message || "Git collection timed out");
      }
      return undefined;
    }
    if (!snapshot.ok) {
      const error = snapshot.errors[0];
      throw new GitCollectionError("command-failure", error?.message || "Git collection failed");
    }
    if (snapshot.truncated.status) {
      throw new GitCollectionError("output-limit", "Git status exceeded provider bounds");
    }

    const stagedCount = snapshot.staged.length + snapshot.conflicts.length;
    const unstagedCount = snapshot.unstaged.length + snapshot.conflicts.length;
    const untrackedCount = snapshot.untracked.length;
    return {
      branch: snapshot.branch ?? "detached",
      dirty: !snapshot.clean,
      stagedCount,
      unstagedCount,
      untrackedCount,
      upstream: snapshot.upstream,
      remoteName: snapshot.upstream?.split("/")[0],
      aheadCount: snapshot.ahead,
      behindCount: snapshot.behind,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
