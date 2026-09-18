import { existsSync, lstatSync, opendirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { inventoryWorkflowMigrations } from "./migration.ts";
import { listWorkflowTopics, loadWorkflow } from "./store.ts";

const CONTROLLING_TOPIC = "swe-production-rollout";
const REQUIRED_NODE_SUPPORT = ">=22.19.0";
const MAX_RELEASE_CHECKS = 16;
const MAX_ACTIVE_TOPICS = 100;
const MAX_SCAN_ENTRIES = 1_000;
const MAX_SCAN_DEPTH = 8;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_GIT_PATH_BYTES = 4 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const CANONICAL_WORKFLOW_CONTRACT = { revision: 6, hash: "sha256:3894b64f481fc360ba799bba914eeb08f88e1f85b18fad6d33b5e2e25c47f78f" } as const;
const CANONICAL_PREREQUISITE_CONTRACTS = {
  "migration-qualification": { revision: 6, hash: "sha256:8b28d01b0ca3feb60e0a139cad5256e8301f0c69c5c6f8f9791ed6c659abe134" },
  "activation-qualification": { revision: 6, hash: "sha256:e6efba1a17d67dc23e60ffc9bac8095fa148fc84315b586bdc7540243cfb9efb" },
} as const;

export const CUTOVER_RELEASE_CHECK_MANIFEST = [
  { name: "npm run typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "npm run check", command: "npm", args: ["run", "check"] },
  { name: "npm run check:commands", command: "npm", args: ["run", "check:commands"] },
  { name: "npm run check:performance", command: "npm", args: ["run", "check:performance"] },
  { name: "npm test", command: "npm", args: ["test"] },
] as const;

export type CutoverReleaseCheck = { name: string; passed: boolean };
export type CutoverReadinessObservation = {
  migrationContractComplete: boolean;
  activationContractComplete: boolean;
  migrationAuditClean: boolean;
  gitClean: boolean;
  nodeSupported: boolean;
  piSupported: boolean;
  activeWorkflowTopics: string[];
  controllingTopic: string;
  activeTodoCount: number;
  recoveryClean: boolean;
  releaseChecks: CutoverReleaseCheck[];
};
export type CutoverGateStatus = "passed" | "failed" | "required";
export type CutoverReadinessGate = {
  id: string;
  status: CutoverGateStatus;
  summary: string;
};
export type CutoverReadinessCategory = {
  id: "code" | "repository-migration" | "runtime-activation" | "external-release-authorization";
  status: "ready" | "blocked" | "pending";
  gates: CutoverReadinessGate[];
};
export type CutoverReadinessReport = {
  schemaVersion: 1;
  ready: boolean;
  activatesRuntime: false;
  categories: CutoverReadinessCategory[];
  nextAction: string;
};
export type CutoverInspectionInput = {
  activeTodoCount: number;
  nodeVersion: string;
  nodeSupport: string;
  piVersions: string[];
  expectedPiVersion: string;
  releaseChecks: CutoverReleaseCheck[];
};

type TechnicalGate = CutoverReadinessGate & { nextAction: string };

/** Evaluate a bounded observation. This function never changes workflow or runtime state. */
export function evaluateCutoverReadiness(observation: CutoverReadinessObservation): CutoverReadinessReport {
  if (!validObservation(observation)) return invalidReport();
  const otherActiveWorkflows = observation.activeWorkflowTopics.filter((topic) => topic !== CONTROLLING_TOPIC);
  const releaseChecksPassed = exactReleaseChecksPassed(observation.releaseChecks);
  const technical: Record<"code" | "repository-migration" | "runtime-activation", TechnicalGate[]> = {
    code: [
      gate("clean-git", observation.gitClean, "The Git worktree, index, and untracked set are clean.", "Restore a clean Git state containing only the reviewed candidate commit, then repeat release verification."),
      gate("supported-node", observation.nodeSupported, "Node runtime is supported.", "Use a Node runtime supported by package.json before repeating release verification."),
      gate("supported-pi", observation.piSupported, "All Pi packages match the supported contract.", "Restore the exact supported Pi package pins before repeating release verification."),
      gate("release-checks", releaseChecksPassed, "All required release checks passed.", "Fix the first failed release check, then rerun the complete release verification."),
    ],
    "repository-migration": [
      gate("migration-contract", observation.migrationContractComplete, "The migration qualification contract is complete.", "Complete and retain evidence for the migration-qualification contract."),
      gate("migration-audit", observation.migrationAuditClean, "The repository migration audit is clean.", "Resolve the migration audit and rerun it without applying a migration."),
      gate("exclusive-workflow-authority", otherActiveWorkflows.length === 0, "No workflow other than the controlling rollout is active.", "Pause or complete the other active workflow before repeating readiness."),
    ],
    "runtime-activation": [
      gate("activation-contract", observation.activationContractComplete, "The activation qualification contract is complete.", "Complete and retain evidence for the activation-qualification contract."),
      gate("exclusive-todo-authority", observation.activeTodoCount === 0, "No independent todo is active.", "Finish or block the active todo before repeating readiness."),
      gate("recovery-state", observation.recoveryClean, "No unfinished run, workspace, or migration recovery state remains.", "Resolve retained recovery state before repeating readiness; do not discard it implicitly."),
    ],
  };
  const categories: CutoverReadinessCategory[] = [
    category("code", technical.code),
    category("repository-migration", technical["repository-migration"]),
    category("runtime-activation", technical["runtime-activation"]),
    {
      id: "external-release-authorization",
      status: "pending",
      gates: [{ id: "operator-cutover-decision", status: "required", summary: "A separate recorded operator decision is required to change the production default." }],
    },
  ];
  const failed = [...technical.code, ...technical["repository-migration"], ...technical["runtime-activation"]].find((item) => item.status === "failed");
  return {
    schemaVersion: 1,
    ready: !failed,
    activatesRuntime: false,
    categories,
    nextAction: failed?.nextAction ?? "Record a separate operator cutover decision using this readiness report as evidence; this check does not activate the runtime.",
  };
}

/** Inspect repository authorities and recovery markers without writing any bytes. */
export function inspectCutoverReadiness(cwd: string, input: CutoverInspectionInput): CutoverReadinessReport {
  try {
    const root = realpathSync(resolve(cwd));
    const git = inspectGit(root);
    const located = loadWorkflow(root, CONTROLLING_TOPIC, false);
    if (!located || located.kind !== "native" || located.storedVersion !== 2) return invalidReport();
    const rawAuthority = JSON.parse(readFileSync(resolve(root, located.path), "utf8")) as unknown;
    if (!hasCanonicalPrerequisiteAuthority(rawAuthority, located.workflow)) return invalidReport();
    const topics = listWorkflowTopics(root);
    const workflows = topics.map((topic) => ({ topic, workflow: loadWorkflow(root, topic, false)?.workflow }));
    if (workflows.some((item) => !item.workflow)) return invalidReport();
    const activeWorkflowTopics = workflows
      .filter((item) => item.workflow?.status === "active" && item.workflow.activeTask)
      .map((item) => item.topic);
    const taskComplete = (id: keyof typeof CANONICAL_PREREQUISITE_CONTRACTS): boolean => {
      const expected = CANONICAL_PREREQUISITE_CONTRACTS[id];
      return located.workflow.tasks.some((task) => task.id === id && task.status === "complete" && exactContract(task.contract, expected));
    };
    const migrationAuditClean = inventoryWorkflowMigrations(root).complete;
    const recoveryClean = workflows.every((item) => !item.workflow?.orchestration.activeRun) && !hasRecoveryMarkers(root, git.commonDirectory);
    return evaluateCutoverReadiness({
      migrationContractComplete: taskComplete("migration-qualification"),
      activationContractComplete: taskComplete("activation-qualification"),
      migrationAuditClean,
      gitClean: git.clean,
      nodeSupported: supportedNode(input.nodeVersion, input.nodeSupport),
      piSupported: supportedPi(input.piVersions, input.expectedPiVersion),
      activeWorkflowTopics,
      controllingTopic: CONTROLLING_TOPIC,
      activeTodoCount: input.activeTodoCount,
      recoveryClean,
      releaseChecks: input.releaseChecks,
    });
  } catch {
    return invalidReport();
  }
}

/** A stable, bounded rendering suitable for release reports and failure output. */
export function formatCutoverReadiness(report: CutoverReadinessReport): string {
  const lines = [
    `Cutover readiness: ${report.ready ? "READY" : "BLOCKED"}`,
    ...report.categories.map((item) => `${item.id}: ${item.status} (${item.gates.map((gate) => `${gate.id}=${gate.status}`).join(", ")})`),
    "Evidence only; runtime activation remains unchanged.",
    `Next action: ${report.nextAction}`,
  ];
  return lines.join("\n").slice(0, 4096);
}

function gate(id: string, passed: boolean, summary: string, nextAction: string): TechnicalGate {
  return { id, status: passed ? "passed" : "failed", summary, nextAction };
}

function category(id: CutoverReadinessCategory["id"], gates: TechnicalGate[]): CutoverReadinessCategory {
  return { id, status: gates.every((item) => item.status === "passed") ? "ready" : "blocked", gates: gates.map(({ nextAction: _nextAction, ...item }) => item) };
}

function invalidReport(): CutoverReadinessReport {
  const failed = gate("bounded-readiness-input", false, "Readiness authorities could not be inspected safely.", "Repair or supply the bounded readiness authorities, then rerun the read-only check.");
  return {
    schemaVersion: 1,
    ready: false,
    activatesRuntime: false,
    categories: [
      category("code", [failed]),
      { id: "repository-migration", status: "blocked", gates: [] },
      { id: "runtime-activation", status: "blocked", gates: [] },
      { id: "external-release-authorization", status: "pending", gates: [{ id: "operator-cutover-decision", status: "required", summary: "A separate recorded operator decision is required to change the production default." }] },
    ],
    nextAction: failed.nextAction,
  };
}

function hasCanonicalPrerequisiteAuthority(raw: unknown, workflow: { contract: { revision: number; hash: string }; tasks: Array<{ id: string; status: string; contract: { revision: number; hash: string } }> }): boolean {
  if (!record(raw) || !exactContract(raw.contract, CANONICAL_WORKFLOW_CONTRACT) || !exactContract(workflow.contract, CANONICAL_WORKFLOW_CONTRACT)) return false;
  const rawTasks = raw.tasks;
  if (!Array.isArray(rawTasks)) return false;
  return Object.entries(CANONICAL_PREREQUISITE_CONTRACTS).every(([id, expected]) => {
    const rawMatches = rawTasks.filter((task) => record(task) && task.id === id);
    const parsedMatches = workflow.tasks.filter((task) => task.id === id);
    return rawMatches.length === 1
      && parsedMatches.length === 1
      && rawMatches[0]!.status === "complete"
      && exactContract(rawMatches[0]!.contract, expected)
      && parsedMatches[0]!.status === "complete"
      && exactContract(parsedMatches[0]!.contract, expected);
  });
}

function exactContract(value: unknown, expected: { revision: number; hash: string }): boolean {
  return record(value) && value.revision === expected.revision && value.hash === expected.hash;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validObservation(value: CutoverReadinessObservation): boolean {
  return typeof value === "object"
    && [value.migrationContractComplete, value.activationContractComplete, value.migrationAuditClean, value.gitClean, value.nodeSupported, value.piSupported, value.recoveryClean].every((item) => typeof item === "boolean")
    && value.controllingTopic === CONTROLLING_TOPIC
    && Array.isArray(value.activeWorkflowTopics) && value.activeWorkflowTopics.length <= MAX_ACTIVE_TOPICS && value.activeWorkflowTopics.every((item) => typeof item === "string" && item.length <= 256)
    && Number.isSafeInteger(value.activeTodoCount) && value.activeTodoCount >= 0 && value.activeTodoCount <= 1_000
    && Array.isArray(value.releaseChecks) && value.releaseChecks.length <= MAX_RELEASE_CHECKS
    && value.releaseChecks.every((item) => typeof item?.name === "string" && item.name.length > 0 && item.name.length <= 128 && !/[\r\n\0]/.test(item.name) && typeof item.passed === "boolean");
}

function exactReleaseChecksPassed(checks: CutoverReleaseCheck[]): boolean {
  return checks.length === CUTOVER_RELEASE_CHECK_MANIFEST.length
    && checks.every((check, index) => check.name === CUTOVER_RELEASE_CHECK_MANIFEST[index]!.name && check.passed);
}

function supportedNode(version: string, support: string): boolean {
  if (support !== REQUIRED_NODE_SUPPORT) return false;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 22 || major === 22 && (minor > 19 || minor === 19 && patch >= 0);
}

function supportedPi(versions: string[], expected: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(expected) && versions.length === 3 && versions.every((version) => version === expected);
}

function inspectGit(root: string): { clean: boolean; commonDirectory: string } {
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], MAX_GIT_OUTPUT_BYTES);
  const commonOutput = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], MAX_GIT_PATH_BYTES);
  if (!commonOutput.endsWith("\n") || /[\r\n]/.test(commonOutput.slice(0, -1))) throw new Error("invalid Git common directory output");
  const commonPath = commonOutput.slice(0, -1);
  if (!isAbsolute(commonPath)) throw new Error("Git common directory is not absolute");
  const commonDirectory = realpathSync(commonPath);
  if (!lstatSync(commonDirectory).isDirectory()) throw new Error("Git common directory is not a directory");
  return { clean: status.length === 0, commonDirectory };
}

function runGit(root: string, args: string[], maxBuffer: number): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") throw new Error("Git inspection failed");
  return result.stdout;
}

function hasRecoveryMarkers(root: string, gitCommonDirectory: string): boolean {
  const sweMigration = resolve(root, ".model-artifacts/system/logs/pi-swe-migration");
  if (containsEntry(sweMigration, (entry) => entry === "journal.json")) return true;
  const artifactMigration = resolve(root, ".model-artifacts/system/logs/model-artifact-migration");
  if (containsEntry(artifactMigration, (entry) => entry === "active.claim.json" || entry.endsWith("journal.json") || entry.endsWith("-transaction"))) return true;
  if (containsEntry(resolve(gitCommonDirectory, "pi-swe-intents"), (entry) => entry.endsWith(".json"))) return true;
  return false;
}

function containsEntry(root: string, matches: (name: string) => boolean): boolean {
  if (!existsSync(root)) return false;
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error("unsafe recovery root");
  let count = 0;
  const visit = (directory: string, depth: number): boolean => {
    if (depth > MAX_SCAN_DEPTH) throw new Error("recovery scan depth exceeded");
    const entries = readDirectory(directory);
    for (const entry of entries) {
      count += 1;
      if (count > MAX_SCAN_ENTRIES) throw new Error("recovery scan entry bound exceeded");
      if (entry.isSymbolicLink()) throw new Error("symlinked recovery state rejected");
      if (matches(entry.name)) return true;
      if (entry.isDirectory() && visit(resolve(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return visit(root, 0);
}

function readDirectory(directory: string): Dirent[] {
  const handle = opendirSync(directory);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
      if (entries.length > MAX_SCAN_ENTRIES) throw new Error("recovery directory bound exceeded");
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
