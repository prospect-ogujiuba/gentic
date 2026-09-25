export type GitFailure = {
  command: string;
  code: number | null;
  message: string;
  killed: boolean;
};

export type GitPath = {
  code: string;
  path: string;
  originalPath?: string;
};

export type GitRemote = {
  name: string;
  url: string;
  direction: "fetch" | "push" | "unknown";
};

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

/** Supported registration-free Git snapshot service contract. */
export type GitSnapshotCollector = (cwd: string, signal?: AbortSignal) => Promise<GitSnapshot>;
