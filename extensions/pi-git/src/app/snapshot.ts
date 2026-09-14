import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ExecResult = {
  stdout?: string;
  stderr?: string;
  code?: number;
  killed?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
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
export type GitRunner = (args: string[], ctx: ExtensionContext, signal?: AbortSignal) => Promise<ExecResult>;

const MAX_ITEMS = 200;
const MAX_TEXT = 8_192;
const MAX_PATH = 4_096;
const MAX_REF = 512;
const MAX_REMOTE_NAME = 256;
export const MAX_CAPTURE_BYTES = 256 * 1024;

/** Spawn a process while retaining at most limit bytes from each output stream. */
export async function execBounded(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 10_000,
  limit = MAX_CAPTURE_BYTES,
): Promise<ExecResult> {
  signal?.throwIfAborted();
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;

    const collect = (chunks: Buffer[], chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, limit - used);
      if (value.length > remaining) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += Math.min(value.length, remaining);
      else stderrBytes += Math.min(value.length, remaining);
    };
    child.stdout?.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk, "stderr"));

    const cleanup = () => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        code: code ?? (timedOut ? 143 : 1),
        killed: timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    };
    const terminate = () => {
      const pid = child.pid;
      try {
        if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* The process group already exited. */ }
      escalationTimer = setTimeout(() => {
        try {
          if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* The process group already exited. */ }
      }, 100);
      escalationTimer.unref?.();
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("error", (error) => {
      if (settled) return;
      if (aborted) finish(null);
      else {
        collect(stderr, error.message, "stderr");
        finish(1);
      }
    });
    child.once("close", finish);
  });
}

const defaultGitRunner: GitRunner = (args, ctx, signal) => execBounded("git", args, ctx.cwd, signal);

function failure(args: string[], result: ExecResult): GitFailure {
  const raw = result.stderr || result.stdout || "git command failed";
  const suffix = result.stderrTruncated || result.stdoutTruncated ? " [output truncated]" : "";
  return {
    command: `git ${args.join(" ")}`,
    code: typeof result.code === "number" ? result.code : null,
    message: `${publicLine(raw, MAX_TEXT - suffix.length)}${suffix}`,
    killed: result.killed === true,
  };
}

function succeeded(result: ExecResult): boolean { return result.code === 0 && !result.killed; }
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

function parseStatus(output: string, captureTruncated: boolean): Omit<GitSnapshot, "ok" | "root" | "remotes" | "truncated" | "errors"> & { truncated: boolean } {
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

function parseRemotes(output: string, captureTruncated: boolean): { remotes: GitRemote[]; truncated: boolean } {
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

function emptySnapshot(error: GitFailure): GitSnapshot {
  return { ok: false, detached: false, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], remotes: [], truncated: { status: false, remotes: false }, errors: [error] };
}

export async function snapshot(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  runner: GitRunner = defaultGitRunner,
): Promise<GitSnapshot> {
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const rootResult = await runner(rootArgs, ctx, signal);
  if (!succeeded(rootResult)) return emptySnapshot(failure(rootArgs, rootResult));
  const rawRoot = (rootResult.stdout || "").trim();
  if (!rawRoot) return emptySnapshot({ command: "git rev-parse --show-toplevel", code: 0, message: "git returned an empty repository root", killed: false });
  if (rootResult.stdoutTruncated || rawRoot.length > MAX_PATH) {
    return emptySnapshot({ command: "git rev-parse --show-toplevel", code: 0, message: "git repository root exceeded the public output bound", killed: false });
  }
  const root = publicLine(rawRoot, MAX_PATH);

  const statusArgs = ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"];
  const remoteArgs = ["remote", "-v"];
  const [statusResult, remoteResult] = await Promise.all([runner(statusArgs, ctx, signal), runner(remoteArgs, ctx, signal)]);
  const errors: GitFailure[] = [];
  if (!succeeded(statusResult)) errors.push(failure(statusArgs, statusResult));
  if (!succeeded(remoteResult)) errors.push(failure(remoteArgs, remoteResult));
  const status = succeeded(statusResult)
    ? parseStatus(statusResult.stdout || "", statusResult.stdoutTruncated === true)
    : { branch: undefined, detached: false, upstream: undefined, ahead: 0, behind: 0, clean: false, staged: [], unstaged: [], untracked: [], conflicts: [], truncated: statusResult.stdoutTruncated === true };
  const remote = succeeded(remoteResult)
    ? parseRemotes(remoteResult.stdout || "", remoteResult.stdoutTruncated === true)
    : { remotes: [], truncated: remoteResult.stdoutTruncated === true };
  return { ok: errors.length === 0, root, ...status, remotes: remote.remotes, truncated: { status: status.truncated, remotes: remote.truncated }, errors };
}

function section<T>(label: string, values: T[], render: (value: T) => string): string[] {
  return [`${label} (${values.length}):`, ...(values.length ? values.map((value) => `  ${render(value)}`) : ["  (none)"])];
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
  if (data.truncated.status || data.truncated.remotes) lines.push(`truncated: status=${data.truncated.status} remotes=${data.truncated.remotes} (max ${MAX_ITEMS} entries per group; capture max ${MAX_CAPTURE_BYTES} bytes per stream)`);
  if (data.errors.length) lines.push(...section("errors", data.errors, (error) => `${error.command} code=${error.code ?? "unknown"} killed=${error.killed}: ${error.message}`));
  return lines.join("\n");
}
