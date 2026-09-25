import type { GitFailure, GitPath, GitRemote, GitSnapshot } from "../../../../src/contracts/git-snapshot.ts";
import type { BoundedProcessResult } from "../../../../src/services/bounded-process.ts";

export const MAX_ITEMS = 200;
const MAX_TEXT = 8_192;
const MAX_PATH = 4_096;
const MAX_REF = 512;
const MAX_REMOTE_NAME = 256;

function publicLine(value: string, maximum: number): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function publicPath(value: string): { value: string; truncated: boolean } {
  return { value: value.slice(0, MAX_PATH), truncated: value.length > MAX_PATH };
}

function count(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function gitSucceeded(result: BoundedProcessResult): boolean {
  return result.code === 0 && !result.killed;
}

export function gitFailure(args: string[], result: BoundedProcessResult): GitFailure {
  const raw = result.stderr || result.stdout || "git command failed";
  const suffix = result.stderrTruncated || result.stdoutTruncated ? " [output truncated]" : "";
  return {
    command: `git ${args.join(" ")}`,
    code: typeof result.code === "number" ? result.code : null,
    message: `${publicLine(raw, MAX_TEXT - suffix.length)}${suffix}`,
    killed: result.killed === true,
  };
}

export function parseGitStatus(output: string, captureTruncated: boolean): Omit<GitSnapshot, "ok" | "root" | "remotes" | "truncated" | "errors"> & { truncated: boolean } {
  const complete = captureTruncated ? output.slice(0, Math.max(0, output.lastIndexOf("\0") + 1)) : output;
  const records = complete.split("\0");
  const rawHeader = records.shift() || "";
  const header = rawHeader.slice(0, MAX_REF * 2);
  let truncated = captureTruncated || rawHeader.length > header.length;
  const branchText = header.replace(/^##\s*/, "").trim();
  const detached = branchText.startsWith("HEAD ") || branchText === "HEAD" || branchText.includes("no branch");
  const rawBranch = detached ? undefined : branchText.split("...")[0]?.trim() || undefined;
  const rawUpstream = branchText.includes("...") ? branchText.split("...")[1]?.split(" ")[0] : undefined;
  const branch = rawBranch ? publicLine(rawBranch, MAX_REF) : undefined;
  const upstream = rawUpstream ? publicLine(rawUpstream, MAX_REF) : undefined;
  truncated ||= (rawBranch?.length ?? 0) > MAX_REF || (rawUpstream?.length ?? 0) > MAX_REF;
  const ahead = count(branchText.match(/ahead (\d+)/)?.[1]);
  const behind = count(branchText.match(/behind (\d+)/)?.[1]);
  const staged: GitPath[] = [];
  const unstaged: GitPath[] = [];
  const untracked: string[] = [];
  const conflicts: GitPath[] = [];
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  let dirty = false;
  const push = <T>(values: T[], item: T) => {
    dirty = true;
    if (values.length < MAX_ITEMS) values.push(item);
    else truncated = true;
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const boundedPath = publicPath(record.slice(3));
    truncated ||= boundedPath.truncated;
    if (code === "??") { push(untracked, boundedPath.value); continue; }
    if (code === "!!") continue;
    let originalPath: string | undefined;
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      const original = records[index + 1];
      if (!original) { truncated = true; break; }
      index += 1;
      const boundedOriginal = publicPath(original);
      originalPath = boundedOriginal.value;
      truncated ||= boundedOriginal.truncated;
    }
    const item = { code: publicLine(code, 2), path: boundedPath.value, originalPath };
    if (conflictCodes.has(code)) push(conflicts, item);
    else {
      if (code[0] !== " ") push(staged, item);
      if (code[1] !== " ") push(unstaged, item);
    }
  }
  return { branch, detached, upstream, ahead, behind, clean: !dirty, staged, unstaged, untracked, conflicts, truncated };
}

export function parseGitRemotes(output: string, captureTruncated: boolean): { remotes: GitRemote[]; truncated: boolean } {
  const complete = captureTruncated ? output.slice(0, Math.max(0, output.lastIndexOf("\n") + 1)) : output;
  const remotes: GitRemote[] = [];
  let truncated = captureTruncated;
  for (const line of complete.split("\n")) {
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    const rawName = match?.[1] ?? "unknown";
    const rawUrl = match?.[2] ?? line;
    const name = publicLine(rawName, MAX_REMOTE_NAME);
    const url = publicLine(rawUrl, MAX_PATH);
    truncated ||= rawName.length > MAX_REMOTE_NAME || rawUrl.length > MAX_PATH;
    if (remotes.length < MAX_ITEMS) remotes.push({ name, url, direction: match ? match[3] as "fetch" | "push" : "unknown" });
    else truncated = true;
  }
  return { remotes, truncated };
}

export function emptyGitSnapshot(error: GitFailure): GitSnapshot {
  return { ok: false, detached: false, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], remotes: [], truncated: { status: false, remotes: false }, errors: [error] };
}

export function parseRepositoryRoot(result: BoundedProcessResult): { root?: string; error?: GitFailure } {
  const args = ["rev-parse", "--show-toplevel"];
  if (!gitSucceeded(result)) return { error: gitFailure(args, result) };
  const rawRoot = (result.stdout || "").trim();
  if (!rawRoot) return { error: { command: "git rev-parse --show-toplevel", code: 0, message: "git returned an empty repository root", killed: false } };
  if (result.stdoutTruncated || rawRoot.length > MAX_PATH) {
    return { error: { command: "git rev-parse --show-toplevel", code: 0, message: "git repository root exceeded the public output bound", killed: false } };
  }
  return { root: publicLine(rawRoot, MAX_PATH) };
}
