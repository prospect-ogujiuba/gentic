import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ExecResult = { stdout?: string; stderr?: string; code?: number; killed?: boolean };

async function git(pi: ExtensionAPI, args: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<ExecResult> {
  return pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 10_000 }) as Promise<ExecResult>;
}

function text(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

export async function snapshot(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const [root, branch, status, staged, unstaged, untracked, remotes] = await Promise.all([
    git(pi, ["rev-parse", "--show-toplevel"], ctx, signal),
    git(pi, ["branch", "--show-current"], ctx, signal),
    git(pi, ["status", "--short", "--branch"], ctx, signal),
    git(pi, ["diff", "--cached", "--name-status"], ctx, signal),
    git(pi, ["diff", "--name-status"], ctx, signal),
    git(pi, ["ls-files", "--others", "--exclude-standard"], ctx, signal),
    git(pi, ["remote", "-v"], ctx, signal),
  ]);

  return {
    root: text(root),
    branch: text(branch),
    status: text(status),
    staged: text(staged).split("\n").filter(Boolean),
    unstaged: text(unstaged).split("\n").filter(Boolean),
    untracked: text(untracked).split("\n").filter(Boolean),
    remotes: text(remotes).split("\n").filter(Boolean),
  };
}

export function renderSnapshot(data: Record<string, unknown>): string {
  const lines = [
    `root: ${data.root || "not a git repo"}`,
    `branch: ${data.branch || "detached/unknown"}`,
    "",
    String(data.status || "clean"),
  ];
  return lines.join("\n").trim();
}
