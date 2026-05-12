import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderSnapshot, snapshot } from "../app/snapshot.ts";

export function registerPiGit(pi: ExtensionAPI): void {
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
      return { content: [{ type: "text", text: renderSnapshot(data) }], details: data };
    },
  });

  pi.registerCommand("pi-git", {
    description: "Show deterministic git scope for commit/push handoff",
    handler: async (_args, ctx) => {
      const data = await snapshot(pi, ctx, ctx.signal);
      ctx.ui.notify(renderSnapshot(data), "info");
    },
  });
}
