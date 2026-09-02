import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import type { MarathonConfig, RunRecord, TaskRecord, WorkspaceRecord } from "./types.js";
import { runProgram } from "./process.js";
import { ensureDir, errorMessage, truncate } from "./util.js";
import { workspaceBasePath } from "./paths.js";

interface GitContext { root: string; relativeCwd: string; head: string; clean: boolean; status: string }
async function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  const result = await runProgram("git", args, { cwd, timeoutMs });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
async function gitContext(cwd: string): Promise<GitContext | null> {
  try {
    const root = await git(["rev-parse", "--show-toplevel"], cwd, 15_000);
    const head = await git(["rev-parse", "HEAD"], root, 15_000);
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], root, 30_000);
    const relativeCwd = path.relative(root, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) return null;
    return { root, relativeCwd, head, clean: !status, status };
  } catch { return null; }
}
async function branchExists(root: string, branch: string): Promise<boolean> { return (await runProgram("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root, timeoutMs: 15_000 })).code === 0; }
async function validWorktree(root: string): Promise<boolean> { try { await git(["rev-parse", "--is-inside-work-tree"], root, 10_000); return true; } catch { return false; } }
const branchSuffix = (id: string): string => id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(-48);

async function prepareWorktree(run: RunRecord, stateDir: string, context: GitContext, config: MarathonConfig): Promise<WorkspaceRecord> {
  if (config.workspace.requireCleanGit && !context.clean) throw new Error(`Source repository has uncommitted changes. Commit/stash them or disable workspace.requireCleanGit.\n${truncate(context.status, 8000)}`);
  const root = path.join(workspaceBasePath(stateDir), run.id);
  const branch = `${config.git.branchPrefix}${branchSuffix(run.id)}`;
  await ensureDir(path.dirname(root));
  if (!(await validWorktree(root))) {
    await rm(root, { recursive: true, force: true });
    await runProgram("git", ["worktree", "prune"], { cwd: context.root, timeoutMs: 30_000 });
    if (await branchExists(context.root, branch)) await git(["worktree", "add", "--force", root, branch], context.root);
    else await git(["worktree", "add", "-b", branch, root, context.head], context.root);
  }
  return { kind: "worktree", root, cwd: path.join(root, context.relativeCwd), branch, baseRef: context.head, repositoryRoot: context.root };
}

async function initializeSnapshotRepository(root: string, branch: string): Promise<{ branch: string; head: string } | null> {
  try {
    await git(["init"], root, 30_000);
    await git(["checkout", "-b", branch], root, 30_000);
    await git(["add", "-A"], root, 120_000);
    await git(["-c", "user.name=Pi Marathon", "-c", "user.email=pi-marathon@local", "commit", "--allow-empty", "--no-gpg-sign", "-m", "marathon: initial workspace snapshot"], root, 120_000);
    return { branch, head: await git(["rev-parse", "HEAD"], root, 15_000) };
  } catch {
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    return null;
  }
}

async function prepareCopy(run: RunRecord, stateDir: string, cwd: string, context: GitContext | null, config: MarathonConfig): Promise<WorkspaceRecord> {
  const source = context?.root ?? cwd; const relativeCwd = context?.relativeCwd ?? "";
  const root = path.join(workspaceBasePath(stateDir), run.id);
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true, mode: 0o700 });
  const ignored = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage"]);
  await cp(source, root, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: (item) => item === source || !ignored.has(path.basename(item)) });
  const branch = `${config.git.branchPrefix}${branchSuffix(run.id)}`;
  const snapshot = await initializeSnapshotRepository(root, branch);
  return {
    kind: "copy", root, cwd: path.join(root, relativeCwd),
    ...(snapshot ? { branch: snapshot.branch, baseRef: snapshot.head, repositoryRoot: root } : { baseRef: context?.head }),
  };
}

export async function prepareWorkspace(run: RunRecord, stateDir: string, config: MarathonConfig): Promise<WorkspaceRecord> {
  const context = await gitContext(run.projectCwd); const mode = config.workspace.mode;
  if (mode === "direct") return { kind: "direct", root: context?.root ?? run.projectCwd, cwd: run.projectCwd, baseRef: context?.head, repositoryRoot: context?.root };
  if (mode === "worktree") { if (!context) throw new Error("workspace.mode=worktree requires a Git repository"); return prepareWorktree(run, stateDir, context, config); }
  if (mode === "copy") return prepareCopy(run, stateDir, run.projectCwd, context, config);
  return context ? prepareWorktree(run, stateDir, context, config) : prepareCopy(run, stateDir, run.projectCwd, null, config);
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256"); let count = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++count > 100_000) throw new Error("Workspace exceeds 100,000 entries");
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) { hash.update(`D\0${relative}\0`); await walk(absolute); }
      else {
        const stat = await lstat(absolute);
        if (entry.isSymbolicLink()) hash.update(`L\0${relative}\0${await readlink(absolute)}\0`);
        else if (entry.isFile()) {
          hash.update(`F\0${relative}\0${stat.size}\0`);
          for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
          hash.update("\0");
        } else {
          // Device nodes, sockets, and other special entries are represented by metadata only.
          hash.update(`S\0${relative}\0${stat.mode}\0${stat.size}\0`);
        }
      }
    }
  };
  await walk(root); return hash.digest("hex");
}

export async function checkpointWorkspace(workspace: WorkspaceRecord, task: TaskRecord | null, config: MarathonConfig): Promise<{ ref: string | null; metadata: Record<string, unknown> }> {
  if (workspace.repositoryRoot) {
    const root = workspace.kind === "direct" ? workspace.repositoryRoot : workspace.root;
    const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], root, 30_000);
    if (status && config.git.commitPassedTasks) {
      await git(["add", "-A"], root, 60_000);
      const title = task ? `${task.key}: ${task.title}` : "final verified state";
      await git(["-c", "user.name=Pi Marathon", "-c", "user.email=pi-marathon@local", "commit", "--no-gpg-sign", "-m", `marathon: ${title}`.slice(0, 220)], root);
    }
    return { ref: await git(["rev-parse", "HEAD"], root, 15_000), metadata: { kind: workspace.kind, statusBeforeCheckpoint: status } };
  }
  const digest = await hashTree(workspace.root); return { ref: `sha256:${digest}`, metadata: { kind: workspace.kind, digest } };
}

export async function describeWorkspace(workspace: WorkspaceRecord): Promise<string> {
  try {
    if (workspace.repositoryRoot) {
      const root = workspace.kind === "direct" ? workspace.repositoryRoot : workspace.root;
      const status = await git(["status", "--short", "--branch"], root, 30_000);
      const base = workspace.baseRef ?? "HEAD";
      const stat = await git(["diff", "--stat", `${base}..HEAD`], root, 30_000).catch(() => "");
      const names = await git(["diff", "--name-status", `${base}..HEAD`], root, 30_000).catch(() => "");
      return truncate([`Kind: ${workspace.kind}`, `Root: ${root}`, `Branch: ${workspace.branch ?? "current"}`, status, stat, names].filter(Boolean).join("\n"), 30_000);
    }
    return `Kind: ${workspace.kind}\nRoot: ${workspace.root}\nManifest digest: ${await hashTree(workspace.root)}`;
  } catch (error) { return `Workspace description failed: ${errorMessage(error)}`; }
}
export async function cleanupWorkspace(workspace: WorkspaceRecord, keep: boolean): Promise<void> {
  if (keep || workspace.kind === "direct") return;
  if (workspace.kind === "worktree" && workspace.repositoryRoot) { await git(["worktree", "remove", "--force", workspace.root], workspace.repositoryRoot).catch(() => undefined); return; }
  await rm(workspace.root, { recursive: true, force: true });
}
export async function inspectGit(cwd: string): Promise<{ available: boolean; version?: string; repository?: string }> {
  try { const version = await git(["--version"], cwd, 10_000); const context = await gitContext(cwd); return { available: true, version, repository: context?.root }; } catch { return { available: false }; }
}
