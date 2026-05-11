import { execFileSync } from "node:child_process";
import type { GitStatus } from "./types.ts";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 700 }).trim();
  } catch {
    return undefined;
  }
}

export function getGitStatus(cwd: string): GitStatus | undefined {
  if (!git(cwd, ["rev-parse", "--show-toplevel"])) return undefined;

  const branch = git(cwd, ["branch", "--show-current"]) || git(cwd, ["rev-parse", "--short", "HEAD"]) || "detached";
  const porcelain = git(cwd, ["status", "--porcelain=v1"]) || "";
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

  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const [ahead = "0", behind = "0"] = upstream
    ? (git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])?.split(/\s+/) ?? [])
    : [];

  return {
    branch,
    dirty: stagedCount + unstagedCount + untrackedCount > 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    upstream,
    remoteName: upstream?.split("/")[0],
    aheadCount: Number(ahead),
    behindCount: Number(behind),
  };
}
