import type { GitSnapshot } from "../../../../src/contracts/git-snapshot.ts";
import { MAX_CAPTURE_BYTES } from "../../../../src/services/bounded-process.ts";
import { MAX_ITEMS } from "../app/parse.ts";

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
