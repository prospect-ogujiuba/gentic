import type { GitStatus } from "../../types.ts";

export interface GitStatusInput {
  branch: string;
  porcelain: string;
  upstream?: string;
  aheadBehind?: string;
}

function countPorcelain(porcelain: string): Pick<GitStatus, "stagedCount" | "unstagedCount" | "untrackedCount"> {
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const line of porcelain.split("\n").filter(Boolean)) {
    if (line.startsWith("??")) {
      untrackedCount += 1;
      continue;
    }
    if (line[0] !== " ") stagedCount += 1;
    if (line[1] !== " ") unstagedCount += 1;
  }

  return { stagedCount, unstagedCount, untrackedCount };
}

export function normalizeGitStatus(input: GitStatusInput): GitStatus {
  const { stagedCount, unstagedCount, untrackedCount } = countPorcelain(input.porcelain);
  const [ahead = "0", behind = "0"] = input.aheadBehind?.split(/\s+/) ?? [];

  return {
    branch: input.branch,
    dirty: stagedCount + unstagedCount + untrackedCount > 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    upstream: input.upstream,
    remoteName: input.upstream?.split("/")[0],
    aheadCount: Number(ahead),
    behindCount: Number(behind),
  };
}
