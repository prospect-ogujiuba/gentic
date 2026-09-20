import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { inventoryWorkflowMigrations, type WorkflowMigrationInventoryEntry } from "./migration.ts";
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
const MAX_SELECTOR_BYTES = 16 * 1024;
const MAX_SELECTOR_LOCK_BYTES = 1_024;
const SELECTOR_LOCK_RETRIES = 20;
const SELECTOR_LOCK_RETRY_MS = 25;
const MAX_AUTHORIZATION_AGE_MS = 60 * 60_000;
const MAX_ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const REVIEWED_READINESS_EVIDENCE_HASH = "sha256:c20d05e239978d456801410ac986c22ef21c7f78bb6e3cad485a00181fabfadc" as const;
export const REVIEWED_MIGRATION_EVIDENCE_HASH = "sha256:0b40a9d1b4352408d0b22ba3814cd0858ebd13e7c04728e563adf294ccd5f157" as const;
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

export type CutoverRuntimeSelectorPreimage = {
  existed: boolean;
  bytes?: Buffer;
};
export type ManagedRuntime = "compatibility" | "v2";
export type Gate2Decision = {
  decisionId: string;
  authorizedBy: string;
  authorizedAt: string;
  readinessEvidenceHash: string;
  migrationEvidenceHash: string;
  targetRuntime: "v2";
  rollbackSelector: "compatibility";
  rollbackWindowEnd: string;
  rationale: string;
};
export type RuntimeSelectionRecord = {
  schemaVersion: 1;
  generation: number;
  selectedRuntime: ManagedRuntime;
  controllingTopic: typeof CONTROLLING_TOPIC;
  decision: Gate2Decision;
  handoff: {
    id: string;
    from: ManagedRuntime;
    to: ManagedRuntime;
    preparedWorkflowRevision: number;
    preparedAt: string;
    selectedAt: string;
    parent: { ownerId: string; sessionId: string; runtimeId: string };
  };
};
export type RuntimeSelectionState =
  | { status: "selected"; runtime: ManagedRuntime; generation: number; preimageHash: string; record?: RuntimeSelectionRecord }
  | { status: "blocked"; runtime: null; generation: null; preimageHash: null; reason: string };
export type NoChildCheckpoint = { topic: string; workflowRevision: number; checkedAt: string };
export type Gate2EvidencePaths = { readiness: string; migration: string };

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

/** Return one deterministic operator action for a migration blocker. */
export function cutoverMigrationRemediation(entry: WorkflowMigrationInventoryEntry): string {
  if (entry.action === "run-pi-artifacts-migration" || entry.blocker === "canonical-and-kind-first-layouts") {
    return "Run pi-artifacts audit and migrate the kind-first layout, then rerun the SWE migration inventory.";
  }
  if (entry.blocker === "canonical-workflow-and-historical-manifest") {
    return "Resolve the canonical workflow and historical manifest conflict, then rerun the SWE migration inventory.";
  }
  if (entry.blocker === "unsupported-workflow-version" || entry.blocker === "unsupported-manifest-version") {
    return "Replace or archive the unsupported workflow authority, then rerun the SWE migration inventory.";
  }
  if (entry.blocker === "invalid-topic") {
    return "Rename the topic to a supported canonical topic, then rerun the SWE migration inventory.";
  }
  return "Repair the malformed workflow authority, then rerun the SWE migration inventory.";
}

/** Parse the human Gate 2 decision. Model-authored placeholders and stale decisions fail closed. */
export function parseGate2Decision(value: unknown, now = new Date()): Gate2Decision {
  if (!record(value)) throw new Error("Gate 2 decision must be an object");
  exactKeys(value, ["decisionId", "authorizedBy", "authorizedAt", "readinessEvidenceHash", "migrationEvidenceHash", "targetRuntime", "rollbackSelector", "rollbackWindowEnd", "rationale"], "Gate 2 decision");
  const decision: Gate2Decision = {
    decisionId: decisionText(value.decisionId, "decision id", 128),
    authorizedBy: decisionText(value.authorizedBy, "authorized actor", 128),
    authorizedAt: decisionTimestamp(value.authorizedAt, "authorization timestamp"),
    readinessEvidenceHash: String(value.readinessEvidenceHash ?? ""),
    migrationEvidenceHash: String(value.migrationEvidenceHash ?? ""),
    targetRuntime: value.targetRuntime as "v2",
    rollbackSelector: value.rollbackSelector as "compatibility",
    rollbackWindowEnd: decisionTimestamp(value.rollbackWindowEnd, "rollback deadline"),
    rationale: decisionText(value.rationale, "authorization rationale", 2048),
  };
  if (/^<.*>$/.test(decision.decisionId) || /^<.*>$/.test(decision.authorizedBy) || /^<.*>$/.test(decision.rationale)) throw new Error("Gate 2 decision contains a placeholder");
  if (decision.readinessEvidenceHash !== REVIEWED_READINESS_EVIDENCE_HASH || decision.migrationEvidenceHash !== REVIEWED_MIGRATION_EVIDENCE_HASH) throw new Error("Gate 2 evidence hash differs from the reviewed reports");
  if (decision.targetRuntime !== "v2" || decision.rollbackSelector !== "compatibility") throw new Error("Gate 2 runtime or rollback selector is ambiguous");
  const authorizedAt = Date.parse(decision.authorizedAt);
  const rollbackEnd = Date.parse(decision.rollbackWindowEnd);
  if (authorizedAt > now.getTime() + 60_000 || now.getTime() - authorizedAt > MAX_AUTHORIZATION_AGE_MS) throw new Error("Gate 2 authorization is stale or future-dated");
  if (rollbackEnd <= now.getTime() || rollbackEnd <= authorizedAt || rollbackEnd - authorizedAt > MAX_ROLLBACK_WINDOW_MS) throw new Error("Gate 2 rollback deadline is invalid");
  return decision;
}

/** Resolve the sole checkout-local runtime selector. Absence means compatibility; malformed state blocks. */
export function readRuntimeSelection(cwd: string): RuntimeSelectionState {
  try {
    const path = cutoverRuntimeSelectorPath(cwd);
    if (!existsSync(path)) return { status: "selected", runtime: "compatibility", generation: 0, preimageHash: hashSelector(Buffer.alloc(0)) };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > MAX_SELECTOR_BYTES || (stat.mode & 0o777) !== 0o600) throw new Error("runtime selector must be a mode 0600 regular bounded file");
    const bytes = readFileSync(path);
    const record = parseRuntimeSelectionRecord(JSON.parse(bytes.toString("utf8")));
    return { status: "selected", runtime: record.selectedRuntime, generation: record.generation, preimageHash: hashSelector(bytes), record };
  } catch (error) {
    return { status: "blocked", runtime: null, generation: null, preimageHash: null, reason: message(error) };
  }
}

export type SelectorPersistenceBoundary = "lock-acquired" | "temporary-fsynced" | "selector-renamed" | "directory-fsynced";

/** Persist one selector generation with compare-and-swap and an atomic mode-0600 rename. */
export function writeRuntimeSelection(cwd: string, record: RuntimeSelectionRecord, expectedGeneration: number, expectedPreimageHash: string, boundary?: (stage: SelectorPersistenceBoundary) => void): RuntimeSelectionRecord {
  const parsed = parseRuntimeSelectionRecord(record);
  if (parsed.generation !== expectedGeneration + 1) throw new Error("runtime selector generation must advance exactly once");
  const path = cutoverRuntimeSelectorPath(cwd);
  const lockPath = `${path}.lock`;
  const ownership = acquireSelectorLock(lockPath);
  try {
    boundary?.("lock-acquired");
    const current = readRuntimeSelection(cwd);
    if (current.status === "blocked") throw new Error(`runtime selector is ambiguous: ${current.reason}`);
    if (current.generation !== expectedGeneration || current.preimageHash !== expectedPreimageHash) throw new Error(`runtime selector preimage changed before generation ${expectedGeneration + 1}`);
    const temporary = `${path}.tmp-${ownership.pid}-${ownership.token}`;
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
    if (bytes.length > MAX_SELECTOR_BYTES) throw new Error("runtime selector exceeds bounded size");
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    boundary?.("temporary-fsynced");
    try {
      renameSync(temporary, path);
      boundary?.("selector-renamed");
      fsyncDirectory(dirname(path));
      boundary?.("directory-fsynced");
    } finally { rmSync(temporary, { force: true }); }
    return parsed;
  } finally {
    releaseSelectorLock(lockPath, ownership);
  }
}

/** Verify the exact reviewed reports and their explicitly human-scoped Gate 2 eligibility. */
export function validateGate2Evidence(cwd: string, paths: Gate2EvidencePaths): void {
  const root = realpathSync(resolve(cwd));
  const reports = [
    { path: paths.readiness, hash: REVIEWED_READINESS_EVIDENCE_HASH, kind: "swe-gate2-preparation-readiness" },
    { path: paths.migration, hash: REVIEWED_MIGRATION_EVIDENCE_HASH, kind: "swe-gate2-post-migration" },
  ] as const;
  for (const expected of reports) {
    if (!isAbsolute(expected.path) || !existsSync(expected.path)) throw new Error("Gate 2 evidence file is missing");
    const stat = lstatSync(expected.path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > 256 * 1024) throw new Error("Gate 2 evidence must be a mode 0600 bounded regular file");
    const bytes = readFileSync(expected.path);
    if (hashSelector(bytes) !== expected.hash) throw new Error("Gate 2 evidence hash differs from the reviewed report");
    const report = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!record(report) || report.schemaVersion !== 1 || report.reportKind !== expected.kind || report.candidateHead !== "aaebcc66ec78d9a019421d08a79669a51bdad775") throw new Error("Gate 2 evidence identity is invalid");
    if (expected.kind === "swe-gate2-preparation-readiness") {
      const human = report.humanScopedPreparation;
      if (!record(human) || human.eligibleForGate2Decision !== true || human.authorizesActivation !== false || !Array.isArray(human.remainingUnwaivedBlockers) || human.remainingUnwaivedBlockers.length) throw new Error("readiness report is not eligible for a human Gate 2 decision");
    }
  }
  const base = "aaebcc66ec78d9a019421d08a79669a51bdad775";
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { cwd: root, stdio: "ignore", timeout: GIT_TIMEOUT_MS });
  if (ancestor.status !== 0) throw new Error("repository no longer descends from the reviewed Gate 2 candidate");
  const allowed = new Set([".model-artifacts/initiatives/swe-production-rollout/workflow.json", "extensions/pi-swe/index.ts", "extensions/pi-swe/src/command.ts", "extensions/pi-swe/src/cutover.ts", "extensions/pi-swe/src/integrity.ts", "extensions/pi-swe/src/runtime.ts", "extensions/pi-swe/src/service.ts", "extensions/pi-swe/src/tool.ts", "extensions/pi-swe/src/workflow.ts", "extensions/pi-swe/workflow.schema.json", "extensions/pi-swe/runtime.schema.json", "test/pi-swe.test.ts", "test/pi-swe-cutover.test.ts", "test/pi-swe-integrity.test.ts", "test/pi-swe-runtime.test.ts"]);
  const changed = [
    ...runGit(root, ["diff", "--name-only", "-z", `${base}..HEAD`, "--"], MAX_GIT_OUTPUT_BYTES).split("\0").filter(Boolean),
    ...runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], MAX_GIT_OUTPUT_BYTES).split("\0").filter(Boolean).map((entry) => entry.slice(3)),
  ];
  if (changed.some((path) => !allowed.has(path))) throw new Error("repository changed outside the authorized Session 7 writeScope");
}

/** Require a durable repository checkpoint with no child, lease, claim, journal, or recovery temp file. */
export function requireNoChildCheckpoint(cwd: string, topic = CONTROLLING_TOPIC, now = new Date().toISOString()): NoChildCheckpoint {
  const root = realpathSync(resolve(cwd));
  if (!supportedNode(process.version, REQUIRED_NODE_SUPPORT)) throw new Error(`runtime handoff requires Node ${REQUIRED_NODE_SUPPORT}`);
  const git = inspectGit(root);
  if (!git.clean && !onlyControllingWorkflowChanged(root, topic)) throw new Error("runtime handoff requires a clean repository checkout except for its durable controlling authority");
  for (const workflowTopic of listWorkflowTopics(root)) {
    const located = loadWorkflow(root, workflowTopic, false);
    if (!located) throw new Error(`workflow ${workflowTopic} is unreadable`);
    if (located.workflow.orchestration.activeRun) throw new Error(`live child or lease exists for ${workflowTopic}`);
    if (workflowTopic !== topic && located.workflow.status === "active" && located.workflow.activeTask) throw new Error(`live workflow ownership exists for ${workflowTopic}`);
  }
  if (!inventoryWorkflowMigrations(root).complete) throw new Error("repository migration inventory is not clean");
  if (hasRecoveryMarkers(root, git.commonDirectory) || hasTemporaryRecoveryFiles(root, git.commonDirectory)) throw new Error("claim, recovery journal, or temporary recovery file exists");
  const controlling = loadWorkflow(root, topic, false);
  if (!controlling) throw new Error(`controlling workflow ${topic} was not found`);
  decisionTimestamp(now, "checkpoint timestamp");
  return { topic, workflowRevision: controlling.workflow.revision, checkedAt: now };
}

export function runtimeSelectionStatus(cwd: string): string {
  const state = readRuntimeSelection(cwd);
  return state.status === "blocked" ? `runtime: blocked; ${state.reason}` : `runtime: ${state.runtime}; selector generation ${state.generation}`;
}

/** Capture the exact checkout-local selector preimage used by a disposable rehearsal. */
export function captureCutoverRuntimeSelector(cwd: string): CutoverRuntimeSelectorPreimage {
  const path = cutoverRuntimeSelectorPath(cwd);
  if (!existsSync(path)) return { existed: false };
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("runtime selector must be a regular file");
  return { existed: true, bytes: readFileSync(path) };
}

/** Select v2 only inside the supplied checkout and return the exact prior bytes. */
export function selectCutoverRuntime(cwd: string, bytes = Buffer.from("v2-temporary\n")): CutoverRuntimeSelectorPreimage {
  if (!bytes.length || bytes.length > 4_096) throw new Error("runtime selector is outside rehearsal bounds");
  const preimage = captureCutoverRuntimeSelector(cwd);
  const path = cutoverRuntimeSelectorPath(cwd);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return preimage;
}

/** Restore exact prior selector bytes, including exact prior absence. */
export function rollbackCutoverRuntime(cwd: string, preimage: CutoverRuntimeSelectorPreimage): void {
  const path = cutoverRuntimeSelectorPath(cwd);
  if (!preimage.existed) {
    rmSync(path, { force: true });
    return;
  }
  if (!preimage.bytes) throw new Error("runtime selector preimage bytes are missing");
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, preimage.bytes, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
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

function parseRuntimeSelectionRecord(value: unknown): RuntimeSelectionRecord {
  if (!record(value)) throw new Error("runtime selector must be an object");
  exactKeys(value, ["schemaVersion", "generation", "selectedRuntime", "controllingTopic", "decision", "handoff"], "runtime selector");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) throw new Error("unsupported runtime selector schema or generation");
  if (value.selectedRuntime !== "v2" && value.selectedRuntime !== "compatibility") throw new Error("runtime selector is ambiguous");
  if (value.controllingTopic !== CONTROLLING_TOPIC || !record(value.handoff)) throw new Error("runtime selector has invalid controlling handoff");
  exactKeys(value.handoff, ["id", "from", "to", "preparedWorkflowRevision", "preparedAt", "selectedAt", "parent"], "runtime handoff receipt");
  if ((value.handoff.from !== "v2" && value.handoff.from !== "compatibility") || value.handoff.to !== value.selectedRuntime) throw new Error("runtime handoff direction is invalid");
  if (!Number.isSafeInteger(value.handoff.preparedWorkflowRevision) || (value.handoff.preparedWorkflowRevision as number) < 1 || !record(value.handoff.parent)) throw new Error("runtime handoff revision or parent is invalid");
  exactKeys(value.handoff.parent, ["ownerId", "sessionId", "runtimeId"], "runtime handoff parent");
  const decision = parseStoredGate2Decision(value.decision);
  if (value.selectedRuntime === "v2" && decision.targetRuntime !== "v2") throw new Error("runtime selector contradicts Gate 2 target");
  return {
    schemaVersion: 1,
    generation: value.generation as number,
    selectedRuntime: value.selectedRuntime,
    controllingTopic: CONTROLLING_TOPIC,
    decision,
    handoff: {
      id: decisionText(value.handoff.id, "handoff id", 128),
      from: value.handoff.from as ManagedRuntime,
      to: value.handoff.to as ManagedRuntime,
      preparedWorkflowRevision: value.handoff.preparedWorkflowRevision as number,
      preparedAt: decisionTimestamp(value.handoff.preparedAt, "handoff prepared timestamp"),
      selectedAt: decisionTimestamp(value.handoff.selectedAt, "handoff selected timestamp"),
      parent: {
        ownerId: decisionText(value.handoff.parent.ownerId, "handoff parent owner", 128),
        sessionId: decisionText(value.handoff.parent.sessionId, "handoff parent session", 128),
        runtimeId: decisionText(value.handoff.parent.runtimeId, "handoff parent runtime", 128),
      },
    },
  };
}

export function parseStoredGate2Decision(value: unknown): Gate2Decision {
  if (!record(value)) throw new Error("stored Gate 2 decision is invalid");
  exactKeys(value, ["decisionId", "authorizedBy", "authorizedAt", "readinessEvidenceHash", "migrationEvidenceHash", "targetRuntime", "rollbackSelector", "rollbackWindowEnd", "rationale"], "stored Gate 2 decision");
  const decision: Gate2Decision = {
    decisionId: decisionText(value.decisionId, "decision id", 128), authorizedBy: decisionText(value.authorizedBy, "authorized actor", 128),
    authorizedAt: decisionTimestamp(value.authorizedAt, "authorization timestamp"), readinessEvidenceHash: String(value.readinessEvidenceHash ?? ""), migrationEvidenceHash: String(value.migrationEvidenceHash ?? ""),
    targetRuntime: value.targetRuntime as "v2", rollbackSelector: value.rollbackSelector as "compatibility", rollbackWindowEnd: decisionTimestamp(value.rollbackWindowEnd, "rollback deadline"), rationale: decisionText(value.rationale, "authorization rationale", 2048),
  };
  if (decision.readinessEvidenceHash !== REVIEWED_READINESS_EVIDENCE_HASH || decision.migrationEvidenceHash !== REVIEWED_MIGRATION_EVIDENCE_HASH || decision.targetRuntime !== "v2" || decision.rollbackSelector !== "compatibility") throw new Error("stored Gate 2 decision does not match reviewed activation evidence");
  return decision;
}

function decisionText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} is missing`);
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text) || /^<.*>$/.test(text)) throw new Error(`${name} is invalid or contains a placeholder`);
  return text;
}

function decisionTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

function exactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${name} has missing or unknown fields`);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

type SelectorLockOwnership = { schemaVersion: 2; token: string; pid: number; processStartIdentity: string; createdAt: string };
type StoredSelectorLockOwnership = SelectorLockOwnership | { schemaVersion: 1; token: string; pid: number; createdAt: string };

function acquireSelectorLock(lockPath: string): SelectorLockOwnership {
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (!processStartIdentity) throw new Error("runtime selector cannot establish writer process-start identity");
  const ownership: SelectorLockOwnership = { schemaVersion: 2, token: randomUUID(), pid: process.pid, processStartIdentity, createdAt: new Date().toISOString() };
  const bytes = Buffer.from(`${JSON.stringify(ownership)}\n`);
  for (let attempt = 0; attempt <= SELECTOR_LOCK_RETRIES; attempt += 1) {
    const ownerPath = `${lockPath}.owner-${process.pid}-${ownership.token}`;
    let fd: number | undefined;
    try {
      fd = openSync(ownerPath, "wx", 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(ownerPath, lockPath);
      fsyncDirectory(dirname(lockPath));
      rmSync(ownerPath, { force: true });
      fsyncDirectory(dirname(lockPath));
      return ownership;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(ownerPath, { force: true });
      if (!isAlreadyExists(error)) throw error;
      if (reclaimStaleSelectorLock(lockPath)) continue;
      if (attempt === SELECTOR_LOCK_RETRIES) throw new Error("runtime selector is locked by a live writer");
      sleepSync(SELECTOR_LOCK_RETRY_MS);
    }
  }
  throw new Error("runtime selector lock acquisition exhausted");
}

function reclaimStaleSelectorLock(lockPath: string): boolean {
  let before;
  let bytes: Buffer;
  try {
    before = lstatSync(lockPath);
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > MAX_SELECTOR_LOCK_BYTES) return false;
    bytes = readFileSync(lockPath);
  } catch { return false; }
  let owner: StoredSelectorLockOwnership;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<Omit<SelectorLockOwnership, "schemaVersion">> & { schemaVersion?: 1 | 2 };
    if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid! < 1 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
    if (value.schemaVersion === 2 && (typeof value.processStartIdentity !== "string" || !/^[A-Za-z0-9:._-]{1,256}$/.test(value.processStartIdentity))) return false;
    owner = value as StoredSelectorLockOwnership;
  } catch { return false; }
  if (processIsAlive(owner.pid)) {
    if (owner.schemaVersion === 1) return false;
    const currentIdentity = readProcessStartIdentity(owner.pid);
    if (!currentIdentity || currentIdentity === owner.processStartIdentity) return false;
  }
  try {
    const current = lstatSync(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino || !readFileSync(lockPath).equals(bytes)) return false;
    rmSync(lockPath);
    rmSync(`${lockPath.slice(0, -".lock".length)}.tmp-${owner.pid}-${owner.token}`, { force: true });
    fsyncDirectory(dirname(lockPath));
    return true;
  } catch { return false; }
}

function releaseSelectorLock(lockPath: string, ownership: SelectorLockOwnership): void {
  try {
    const bytes = readFileSync(lockPath);
    const current = JSON.parse(bytes.toString("utf8")) as Partial<SelectorLockOwnership>;
    if (current.schemaVersion !== 2 || current.token !== ownership.token || current.pid !== ownership.pid || current.processStartIdentity !== ownership.processStartIdentity) throw new Error("runtime selector lock ownership changed before release");
    rmSync(lockPath);
    fsyncDirectory(dirname(lockPath));
  } catch (error) {
    if (!existsSync(lockPath)) return;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function readProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // field 22; the suffix begins at field 3
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!startTicks || !/^\d+$/.test(startTicks) || !/^[0-9a-f-]{36}$/i.test(bootId)) return undefined;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    const inspected = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096, env: { ...process.env, LC_ALL: "C" } });
    const started = typeof inspected.stdout === "string" ? inspected.stdout.trim() : "";
    if (inspected.status !== 0 || !started || /[\r\n\0]/.test(started)) return undefined;
    return `ps:${createHash("sha256").update(started).digest("hex")}`;
  }
}
function isAlreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "EEXIST"; }
function sleepSync(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

function hasTemporaryRecoveryFiles(root: string, gitCommonDirectory: string): boolean {
  const matches = (name: string) => /(?:\.tmp(?:-|$)|\.journal$|\.lock$|active\.claim\.json$)/.test(name);
  return [
    resolve(root, ".model-artifacts/system/logs/pi-swe-migration"),
    resolve(root, ".model-artifacts/system/logs/model-artifact-migration"),
    resolve(gitCommonDirectory, "pi-swe-intents"),
  ].some((path) => containsEntry(path, matches));
}

function hashSelector(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function cutoverRuntimeSelectorPath(cwd: string): string {
  const root = realpathSync(resolve(cwd));
  const output = runGit(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"], MAX_GIT_PATH_BYTES);
  if (!output.endsWith("\n") || /[\r\n]/.test(output.slice(0, -1))) throw new Error("invalid Git directory output");
  const gitDirectory = output.slice(0, -1);
  if (!isAbsolute(gitDirectory) || !lstatSync(gitDirectory).isDirectory()) throw new Error("Git directory is invalid");
  return resolve(realpathSync(gitDirectory), "pi-swe-runtime-selector");
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

function onlyControllingWorkflowChanged(root: string, topic: string): boolean {
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], MAX_GIT_OUTPUT_BYTES).split("\0").filter(Boolean);
  const expected = `.model-artifacts/initiatives/${topic}/workflow.json`;
  return status.length > 0 && status.every((entry) => entry.slice(3) === expected);
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
