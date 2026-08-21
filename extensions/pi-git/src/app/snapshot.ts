import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ExecResult = { stdout?: string; stderr?: string; code?: number; killed?: boolean };
export type GitFailure = { command: string; code: number | null; message: string; killed: boolean };
export type GitPath = { code: string; path: string; originalPath?: string };
export type GitRemote = { name: string; url: string; direction: "fetch" | "push" | "unknown" };
export type GitSnapshot = {
  ok: boolean;
  root?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: GitPath[];
  unstaged: GitPath[];
  untracked: string[];
  conflicts: GitPath[];
  remotes: GitRemote[];
  truncated: { status: boolean; remotes: boolean };
  errors: GitFailure[];
};

const MAX_ITEMS = 200;
const MAX_TEXT = 8192;

async function git(pi: ExtensionAPI, args: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<ExecResult> {
  signal?.throwIfAborted();
  return pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 10_000 }) as Promise<ExecResult>;
}

function failure(args: string[], result: ExecResult): GitFailure {
  return {
    command: `git ${args.join(" ")}`,
    code: typeof result.code === "number" ? result.code : null,
    message: (result.stderr || result.stdout || "git command failed").trim().slice(0, MAX_TEXT),
    killed: result.killed === true,
  };
}

function succeeded(result: ExecResult): boolean { return result.code === 0 && !result.killed; }

function bounded<T>(items: T[]): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS };
}

function parseStatus(output: string): Omit<GitSnapshot, "ok" | "root" | "remotes" | "truncated" | "errors"> & { truncated: boolean } {
  const records = output.split("\0");
  const header = records.shift() || "";
  const branchText = header.replace(/^##\s*/, "").trim();
  const detached = branchText.startsWith("HEAD ") || branchText === "HEAD" || branchText.includes("no branch");
  const branch = detached ? undefined : branchText.split("...")[0]?.trim() || undefined;
  const upstream = branchText.includes("...") ? branchText.split("...")[1]?.split(" ")[0] : undefined;
  const ahead = Number(branchText.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(branchText.match(/behind (\d+)/)?.[1] || 0);
  const staged: GitPath[] = [];
  const unstaged: GitPath[] = [];
  const untracked: string[] = [];
  const conflicts: GitPath[] = [];
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code === "??") { untracked.push(path); continue; }
    if (code === "!!") continue;
    let originalPath: string | undefined;
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") originalPath = records[++index] || undefined;
    const item = { code, path, originalPath };
    if (conflictCodes.has(code)) conflicts.push(item);
    else {
      if (code[0] !== " ") staged.push(item);
      if (code[1] !== " ") unstaged.push(item);
    }
  }
  const all = [staged.length, unstaged.length, untracked.length, conflicts.length];
  return {
    branch,
    detached,
    upstream,
    ahead,
    behind,
    clean: all.every((count) => count === 0),
    staged: bounded(staged).items,
    unstaged: bounded(unstaged).items,
    untracked: bounded(untracked).items,
    conflicts: bounded(conflicts).items,
    truncated: all.some((count) => count > MAX_ITEMS),
  };
}

function parseRemotes(output: string): { remotes: GitRemote[]; truncated: boolean } {
  const values = output.split("\n").filter(Boolean).map((line): GitRemote => {
    const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    return match ? { name: match[1]!, url: match[2]!, direction: match[3] as "fetch" | "push" } : { name: "unknown", url: line, direction: "unknown" };
  });
  const result = bounded(values);
  return { remotes: result.items, truncated: result.truncated };
}

export async function snapshot(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<GitSnapshot> {
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const rootResult = await git(pi, rootArgs, ctx, signal);
  if (!succeeded(rootResult)) {
    return { ok: false, detached: false, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], remotes: [], truncated: { status: false, remotes: false }, errors: [failure(rootArgs, rootResult)] };
  }
  const root = (rootResult.stdout || "").trim();
  if (!root) {
    return { ok: false, detached: false, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], remotes: [], truncated: { status: false, remotes: false }, errors: [{ command: "git rev-parse --show-toplevel", code: 0, message: "git returned an empty repository root", killed: false }] };
  }

  const statusArgs = ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"];
  const remoteArgs = ["remote", "-v"];
  const [statusResult, remoteResult] = await Promise.all([git(pi, statusArgs, ctx, signal), git(pi, remoteArgs, ctx, signal)]);
  const errors: GitFailure[] = [];
  if (!succeeded(statusResult)) errors.push(failure(statusArgs, statusResult));
  if (!succeeded(remoteResult)) errors.push(failure(remoteArgs, remoteResult));
  const status = succeeded(statusResult) ? parseStatus(statusResult.stdout || "") : { branch: undefined, detached: false, upstream: undefined, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], truncated: false };
  const remote = succeeded(remoteResult) ? parseRemotes(remoteResult.stdout || "") : { remotes: [], truncated: false };
  return { ok: errors.length === 0, root, ...status, remotes: remote.remotes, truncated: { status: status.truncated, remotes: remote.truncated }, errors };
}

function section<T>(label: string, values: T[], render: (value: T) => string): string[] {
  return [
    `${label} (${values.length}):`,
    ...(values.length ? values.map((value) => `  ${render(value)}`) : ["  (none)"]),
  ];
}

export function renderSnapshot(data: GitSnapshot): string {
  const lines = [
    `git snapshot: ${data.ok ? "ok" : "error"}`,
    `root: ${data.root ?? "unavailable"}`,
    `branch: ${data.detached ? "(detached HEAD)" : data.branch ?? "unavailable"}`,
    `upstream: ${data.upstream ?? "(none)"}`,
    `ahead/behind: ${data.ahead}/${data.behind}`,
    `worktree: ${data.clean ? "clean" : "dirty"}`,
    ...section("staged", data.staged, (item) => `${item.code} ${JSON.stringify(item.path)}${item.originalPath ? ` <- ${JSON.stringify(item.originalPath)}` : ""}`),
    ...section("unstaged", data.unstaged, (item) => `${item.code} ${JSON.stringify(item.path)}${item.originalPath ? ` <- ${JSON.stringify(item.originalPath)}` : ""}`),
    ...section("untracked", data.untracked, (path) => JSON.stringify(path)),
    ...section("conflicts", data.conflicts, (item) => `${item.code} ${JSON.stringify(item.path)}`),
    ...section("remotes", data.remotes, (remote) => `${remote.name} ${remote.direction} ${JSON.stringify(remote.url)}`),
  ];
  if (data.truncated.status || data.truncated.remotes) lines.push(`truncated: status=${data.truncated.status} remotes=${data.truncated.remotes} (max ${MAX_ITEMS} entries per group)`);
  if (data.errors.length) lines.push(...section("errors", data.errors, (error) => `${error.command} code=${error.code ?? "unknown"} killed=${error.killed}: ${error.message}`));
  return lines.join("\n");
}
