import { posix } from "node:path";

import { contractFingerprint, type Initiative, type VerificationEvidence } from "../domain/initiative.ts";

export type PreparedCompletionCommit = {
  workId: string;
  message: string;
  paths: string[];
  command: string;
};

export type CompletionCommitPreparation = {
  completionCommit?: PreparedCompletionCommit;
  completionCommitError?: string;
};

export function prepareCompletionCommit(initiative: Initiative, workId: string): CompletionCommitPreparation {
  if (!initiative.policies?.commitOnWorkCompletion) return {};
  const work = initiative.work.find((item) => item.id === workId && item.kind !== "phase");
  if (!work) return { completionCommitError: `Opt-in work-item commit was not prepared: unknown executable work ${workId}.` };

  const fingerprint = contractFingerprint(initiative);
  const attributablePaths = initiative.evidence
    .filter((item) => item.workId === workId && item.outcome === "passed" && item.contractFingerprint === fingerprint)
    .flatMap(evidencePaths)
    .filter(isSafeCommitPath);
  const scopedPaths = [...new Set(attributablePaths)].sort();
  if (!scopedPaths.length) {
    return {
      completionCommitError: `Opt-in work-item commit was not prepared for ${workId}: current passing verification evidence has no safe attributable paths. The work item remains complete; verify with relevantPaths and commit manually if appropriate.`,
    };
  }

  const authorityPath = posix.join(".model-artifacts", "initiatives", initiative.id, "workflow.json");
  const paths = [...scopedPaths.filter((path) => path !== authorityPath), authorityPath];
  const message = completionCommitMessage(work.title, workId);
  return {
    completionCommit: {
      workId,
      message,
      paths,
      command: completionCommitCommand(workId, message, paths),
    },
  };
}

export function completionCommitMessage(title: string, workId: string): string {
  const fallback = `complete ${workId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "work item"}`;
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || fallback;
  return `feat: ${normalized.slice(0, 114).trimEnd()}`;
}

export function completionCommitCommand(workId: string, message: string, paths: string[]): string {
  const pathWords = paths.map(shellWord).join(" ");
  return [
    "set -euo pipefail",
    "export GIT_LITERAL_PATHSPECS=1",
    "git rev-parse --is-inside-work-tree >/dev/null",
    `paths=(${pathWords})`,
    'index="$(mktemp "${TMPDIR:-/tmp}/pi-swe-index.XXXXXX")"',
    'rm -f "$index"',
    'cleanup() { rm -f "$index"; }',
    "trap cleanup EXIT",
    'if git rev-parse --verify HEAD >/dev/null 2>&1; then GIT_INDEX_FILE="$index" git read-tree HEAD; else GIT_INDEX_FILE="$index" git read-tree --empty; fi',
    'GIT_INDEX_FILE="$index" git add -A -- "${paths[@]}"',
    `if GIT_INDEX_FILE="$index" git diff --cached --quiet; then printf '%s\\n' ${shellWord(`pi-swe: no scoped changes to commit for ${workId}; the work item remains complete`)} >&2; exit 42; fi`,
    `GIT_INDEX_FILE="$index" git commit -m ${shellWord(message)}`,
    'commit_hash="$(git rev-parse --short HEAD)"',
    `if ! git reset --quiet HEAD -- "\${paths[@]}"; then printf '%s\\n' ${shellWord("pi-swe: commit succeeded, but scoped index cleanup failed; inspect git status before continuing")} >&2; fi`,
    `printf '%s\\n' ${shellWord(`pi-swe: committed ${workId}`)} "$commit_hash"`,
  ].join("\n");
}

function evidencePaths(evidence: VerificationEvidence): string[] {
  return evidence.kind === "machine-command" ? evidence.source.after.paths : evidence.source.paths;
}

function isSafeCommitPath(value: string): boolean {
  return value.length > 0
    && value.length <= 1_024
    && !value.startsWith("/")
    && !value.includes("\\")
    && value === posix.normalize(value)
    && value !== "."
    && value !== ".."
    && !value.startsWith("../")
    && value !== ".gitignore"
    && value !== ".git"
    && !value.startsWith(".git/")
    && !/(^|\/)logs(?:\/|$)/.test(value)
    && !/[*?\[]/.test(value)
    && !value.startsWith(":");
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
