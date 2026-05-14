import { execFileSync } from "node:child_process";
import { normalizeGitStatus } from "../domain/git-status.ts";
import type { GitStatus } from "../../types.ts";

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
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const aheadBehind = upstream ? git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]) : undefined;

  return normalizeGitStatus({ branch, porcelain, upstream, aheadBehind });
}
