import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ExecResult = { stdout?: string; stderr?: string; code?: number; killed?: boolean };

const COMMIT_REQUEST_RE = /^\s*commit\s+(your|the|da|dirty)?\s*work(tree)?\s*(and\s+push)?\s*$/i;
const PUSH_REQUEST_RE = /^\s*(can you\s+)?push\s+(the\s+)?work\s*$/i;

async function git(pi: ExtensionAPI, args: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<ExecResult> {
  return pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 10_000 }) as Promise<ExecResult>;
}

function text(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

async function snapshot(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
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

function render(data: Record<string, unknown>): string {
  const lines = [
    `root: ${data.root || "not a git repo"}`,
    `branch: ${data.branch || "detached/unknown"}`,
    "",
    String(data.status || "clean"),
  ];
  return lines.join("\n").trim();
}

export default function piGit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "git_snapshot",
    label: "Git Snapshot",
    description: "Collect deterministic git status, branch, staged, unstaged, untracked, and remote information for commit/push work.",
    promptSnippet: "Collect a deterministic git snapshot before staging, committing, pushing, or judging worktree scope.",
    promptGuidelines: [
      "Use git_snapshot before committing or pushing so you know the branch, scope, staged changes, unstaged changes, untracked files, and remotes.",
      "When committing for the user, stage only files in the current task scope and write a concise lowercase one-line commit message with a work-type prefix.",
      "Never commit .gitignore, generated plans, or unrelated user changes unless the user explicitly asks.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const data = await snapshot(pi, ctx, signal);
      return { content: [{ type: "text", text: render(data) }], details: data };
    },
  });

  pi.registerCommand("pi-git", {
    description: "Show deterministic git scope for commit/push handoff",
    handler: async (_args, ctx) => {
      const data = await snapshot(pi, ctx, ctx.signal);
      ctx.ui.notify(render(data), "info");
    },
  });

  pi.on("input", (event) => {
    if (COMMIT_REQUEST_RE.test(event.text)) {
      const push = /push/i.test(event.text);
      return { action: "transform", text: `/git-commit${push ? " and push" : ""}` };
    }
    if (PUSH_REQUEST_RE.test(event.text)) return { action: "transform", text: "/git-push" };
  });
}
