import { basename } from "node:path";
import { MUTED_WARNING_COLOR } from "../lib/format.ts";
import type { HudSnapshot, Theme } from "../../../types.ts";

function getWorktreeLabel(worktreeId: string): string {
  const home = process.env.HOME?.replace(/\/$/, "");
  return home && (worktreeId === home || worktreeId.startsWith(`${home}/`)) ? `~${worktreeId.slice(home.length)}` : basename(worktreeId);
}

export function renderGitStatus(s: HudSnapshot, theme: Theme): string {
  const cwd = getWorktreeLabel(s.worktreeId);
  if (!s.git) return [theme.fg("text", cwd), theme.fg("dim", "no git repo")].join(` ${theme.fg("dim", "·")} `);

  const parts = [theme.fg("text", cwd), `${theme.fg("text", s.git.branch)}${s.git.dirty ? theme.fg("error", "(*)") : ""}`];
  if (!s.git.upstream) {
    parts.push(theme.fg("dim", "no upstream"));
  } else {
    if (s.git.remoteName) parts.push(theme.fg("text", s.git.remoteName));
    if (s.git.aheadCount === 0 && s.git.behindCount === 0) parts.push(theme.fg("success", "synced"));
    parts.push(`${theme.fg(s.git.behindCount > 0 ? MUTED_WARNING_COLOR : "dim", `↓(${s.git.behindCount})`)}${theme.fg("dim", "|")}${theme.fg(s.git.aheadCount > 0 ? "accent" : "dim", `↑(${s.git.aheadCount})`)}`);
  }
  if (s.git.unstagedCount > 0) parts.push(`${theme.fg(MUTED_WARNING_COLOR, "unstaged")} ${theme.fg(MUTED_WARNING_COLOR, `(${s.git.unstagedCount})`)}`);
  if (s.git.untrackedCount > 0) parts.push(`${theme.fg("muted", "untracked")} ${theme.fg("muted", `(${s.git.untrackedCount})`)}`);
  if (s.git.stagedCount > 0) parts.push(`${theme.fg("success", "staged")} ${theme.fg("success", `(${s.git.stagedCount})`)}`);
  return parts.join(` ${theme.fg("dim", "·")} `);
}
