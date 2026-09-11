import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isValidTopic } from "../domain/initiative.ts";
import {
  PI_SWE_RUNNER_STATE_VERSION,
  type PiSweRunnerRecord,
} from "../domain/runner.ts";

export const PI_SWE_RUNNER_STATE_MAX_BYTES = 64 * 1024;

export type PiSweRunnerSnapshot = {
  readonly version: typeof PI_SWE_RUNNER_STATE_VERSION;
  readonly topic: string;
  readonly ownerToken: string;
  readonly runner: PiSweRunnerRecord;
};

export type PiSweRunnerRecovery = "evaluate" | "uncertain-dispatch" | "await-checkpoint" | "inactive";

export type PiSweRunnerPersistenceDiagnosticCode =
  | "future_version"
  | "invalid_state"
  | "state_too_large"
  | "state_read_error"
  | "state_write_error"
  | "owner_mismatch";

export type PiSweRunnerPersistenceDiagnostic = {
  readonly code: PiSweRunnerPersistenceDiagnosticCode;
  readonly message: string;
  readonly path: string;
};

export type ReadPiSweRunnerStateResult = {
  readonly snapshot?: PiSweRunnerSnapshot;
  readonly recovery?: PiSweRunnerRecovery;
  readonly diagnostics: PiSweRunnerPersistenceDiagnostic[];
};

export function runnerStatePath(topic: string): string {
  return `.model-artifacts/system/logs/pi-swe/${topic}/runner.json`;
}

export function runnerLockPath(topic: string): string {
  return `.model-artifacts/system/logs/pi-swe/${topic}/runner.lock`;
}

export function persistPiSweRunnerState(
  cwd: string,
  value: Omit<PiSweRunnerSnapshot, "version">,
): PiSweRunnerPersistenceDiagnostic[] {
  const statePath = runnerStatePath(value.topic);
  if (!validTopic(value.topic) || !validOwnerToken(value.ownerToken) || !validRunner(value.runner, value.topic)) {
    return [diagnostic("invalid_state", "runner lease is malformed or mismatched", statePath)];
  }
  const snapshot: PiSweRunnerSnapshot = { version: PI_SWE_RUNNER_STATE_VERSION, ...value };
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > PI_SWE_RUNNER_STATE_MAX_BYTES) {
    return [diagnostic("state_too_large", `runner state exceeds ${PI_SWE_RUNNER_STATE_MAX_BYTES} bytes`, statePath)];
  }

  const repositoryRoot = resolve(cwd);
  const logsRoot = resolve(repositoryRoot, ".model-artifacts/system/logs/pi-swe");
  const absolutePath = resolve(repositoryRoot, statePath);
  if (!isWithin(logsRoot, absolutePath) || hasSymlinkedSegment(repositoryRoot, dirname(absolutePath))) {
    return [diagnostic("invalid_state", "runner state path escapes the repository or traverses a symlink", statePath)];
  }
  const lock = acquireWriteLock(repositoryRoot, value.topic, value.ownerToken);
  if (lock.diagnostic) return [lock.diagnostic];
  try {
    if (existsSync(absolutePath)) {
      const existing = readPiSweRunnerState(cwd, value.topic);
      if (existing.diagnostics.length) return existing.diagnostics;
      if (!existing.snapshot) return [diagnostic("invalid_state", "existing runner lease is unreadable", statePath)];
      if (existing.snapshot.ownerToken !== value.ownerToken) {
        return [diagnostic("owner_mismatch", `runner is owned by ${existing.snapshot.ownerToken}`, statePath)];
      }
    }

    const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, absolutePath);
      fsyncDirectory(dirname(absolutePath));
      return [];
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* best effort */ }
      }
      try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
      return [diagnostic("state_write_error", `could not atomically persist runner state: ${errorMessage(error)}`, statePath)];
    }
  } finally {
    releaseWriteLock(lock.path);
  }
}

export function readPiSweRunnerState(cwd: string, topic: string, ownerToken?: string): ReadPiSweRunnerStateResult {
  const statePath = runnerStatePath(topic);
  if (!validTopic(topic) || (ownerToken !== undefined && !validOwnerToken(ownerToken))) {
    return { diagnostics: [diagnostic("invalid_state", "runner topic or owner token is invalid", statePath)] };
  }
  const repositoryRoot = resolve(cwd);
  const logsRoot = resolve(repositoryRoot, ".model-artifacts/system/logs/pi-swe");
  const absolutePath = resolve(repositoryRoot, statePath);
  if (!isWithin(logsRoot, absolutePath) || hasSymlinkedSegment(repositoryRoot, absolutePath)) {
    return { diagnostics: [diagnostic("state_read_error", "runner state path traverses a symlink", statePath)] };
  }
  if (!existsSync(absolutePath)) return { diagnostics: [] };
  try {
    if (statSync(absolutePath).size > PI_SWE_RUNNER_STATE_MAX_BYTES) {
      return { diagnostics: [diagnostic("state_too_large", `runner state exceeds ${PI_SWE_RUNNER_STATE_MAX_BYTES} bytes`, statePath)] };
    }
    const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
    if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > PI_SWE_RUNNER_STATE_VERSION) {
      return { diagnostics: [diagnostic("future_version", `unsupported future runner state version ${parsed.version}`, statePath)] };
    }
    if (!isSnapshot(parsed, topic)) {
      return { diagnostics: [diagnostic("invalid_state", "runner state is malformed or mismatched", statePath)] };
    }
    if (ownerToken !== undefined && parsed.ownerToken !== ownerToken) {
      return { diagnostics: [diagnostic("owner_mismatch", `runner is owned by ${parsed.ownerToken}`, statePath)] };
    }
    return { snapshot: parsed, recovery: classifyRecovery(parsed.runner), diagnostics: [] };
  } catch (error) {
    return { diagnostics: [diagnostic("state_read_error", `could not read runner state: ${errorMessage(error)}`, statePath)] };
  }
}

export function markPiSweRunnerDispatchSent(
  cwd: string,
  topic: string,
  ownerToken: string,
  dispatchToken: string,
): PiSweRunnerPersistenceDiagnostic[] {
  return updateRunner(cwd, topic, ownerToken, (runner, statePath) => {
    const pending = runner.pendingDispatch;
    if (!pending || pending.token !== dispatchToken) {
      return { diagnostics: [diagnostic("invalid_state", "dispatch token does not match the pending dispatch", statePath)] };
    }
    if (pending.deliveryStatus === "sent") return { runner };
    return { runner: { ...runner, pendingDispatch: { ...pending, deliveryStatus: "sent" } } };
  });
}

export function pausePersistedPiSweRunner(cwd: string, topic: string, ownerToken: string): PiSweRunnerPersistenceDiagnostic[] {
  return updateRunner(cwd, topic, ownerToken, (runner) => ({
    runner: runner.status !== "running"
      ? runner
      : { ...runner, status: "paused", terminalReason: "operator-paused" },
  }));
}

export function stopPersistedPiSweRunner(cwd: string, topic: string, ownerToken: string): PiSweRunnerPersistenceDiagnostic[] {
  return updateRunner(cwd, topic, ownerToken, (runner) => ({
    runner: runner.status === "stopped" || runner.status === "complete"
      ? runner
      : { ...runner, status: "stopped", terminalReason: "operator-stopped" },
  }));
}

type RunnerUpdate = { runner?: PiSweRunnerRecord; diagnostics?: PiSweRunnerPersistenceDiagnostic[] };

function updateRunner(
  cwd: string,
  topic: string,
  ownerToken: string,
  update: (runner: PiSweRunnerRecord, statePath: string) => RunnerUpdate,
): PiSweRunnerPersistenceDiagnostic[] {
  const current = readPiSweRunnerState(cwd, topic, ownerToken);
  if (current.diagnostics.length) return current.diagnostics;
  if (!current.snapshot) return [diagnostic("invalid_state", "runner lease does not exist", runnerStatePath(topic))];
  const result = update(current.snapshot.runner, runnerStatePath(topic));
  if (result.diagnostics?.length) return result.diagnostics;
  if (!result.runner) return [diagnostic("invalid_state", "runner update produced no state", runnerStatePath(topic))];
  return persistPiSweRunnerState(cwd, { topic, ownerToken, runner: result.runner });
}

function classifyRecovery(runner: PiSweRunnerRecord): PiSweRunnerRecovery {
  if (runner.status !== "running") return "inactive";
  if (!runner.pendingDispatch) return "evaluate";
  return runner.pendingDispatch.deliveryStatus === "sent" ? "await-checkpoint" : "uncertain-dispatch";
}

function isSnapshot(value: unknown, topic: string): value is PiSweRunnerSnapshot {
  return isRecord(value)
    && value.version === PI_SWE_RUNNER_STATE_VERSION
    && value.topic === topic
    && validOwnerToken(value.ownerToken)
    && validRunner(value.runner, topic);
}

function validRunner(value: unknown, topic: string): value is PiSweRunnerRecord {
  if (!isRecord(value) || value.version !== PI_SWE_RUNNER_STATE_VERSION || !validIdentity(value.identity, topic)) return false;
  if (!validOwnerToken(value.runId)
    || (value.mode !== "guided" && value.mode !== "autonomous")
    || (value.until !== "contract" && value.until !== "initiative")
    || !["running", "paused", "stopped", "blocked", "complete"].includes(String(value.status))
    || !isNonNegativeInteger(value.startedAtMs)
    || !validPolicy(value.policy)
    || !isNonNegativeInteger(value.turnCount)
    || !isNonNegativeInteger(value.retryCount)
    || !validRetryCounts(value.retryCounts)
    || !isPositiveInteger(value.nextDispatchSequence)
    || !isNonNegativeInteger(value.lastAcceptedDispatchSequence)
    || value.nextDispatchSequence <= value.lastAcceptedDispatchSequence
    || (value.lastAcceptedCheckpointKey !== undefined && (typeof value.lastAcceptedCheckpointKey !== "string" || value.lastAcceptedCheckpointKey.length > 16_384))
    || (value.terminalReason !== undefined && !validOwnerToken(value.terminalReason))) return false;
  if (value.turnCount !== value.lastAcceptedDispatchSequence) return false;
  const pendingDispatch = value.pendingDispatch;
  if (pendingDispatch !== undefined) {
    if (!validDispatch(pendingDispatch, value, topic)
      || pendingDispatch.sequence !== value.nextDispatchSequence - 1
      || value.lastAcceptedDispatchSequence !== pendingDispatch.sequence - 1) return false;
  } else if (value.nextDispatchSequence !== value.lastAcceptedDispatchSequence + 1) return false;
  return true;
}

function validIdentity(value: unknown, topic: string): boolean {
  return isRecord(value)
    && value.topic === topic
    && isPositiveInteger(value.planRevision)
    && validOwnerToken(value.contractId)
    && typeof value.contractPath === "string"
    && isTopicPath(value.contractPath, topic)
    && typeof value.contractHash === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value.contractHash);
}

function validPolicy(value: unknown): boolean {
  return isRecord(value)
    && isPositiveInteger(value.maxTurns)
    && isNonNegativeInteger(value.maxRetries)
    && isPositiveInteger(value.maxElapsedMs)
    && (value.maxProviderUnits === undefined || isNonNegativeInteger(value.maxProviderUnits));
}

function validRetryCounts(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, count]) => key.length > 0 && key.length <= 512 && isNonNegativeInteger(count));
}

function validDispatch(
  value: unknown,
  runner: Record<string, unknown>,
  topic: string,
): value is Record<string, unknown> & { sequence: number } {
  if (!isRecord(value) || !isPositiveInteger(value.sequence) || value.sequence <= Number(runner.lastAcceptedDispatchSequence)) return false;
  return value.sequence < Number(runner.nextDispatchSequence)
    && value.token === `${runner.runId}:${value.sequence}`
    && validOwnerToken(value.token)
    && RUNNER_STAGES.includes(value.stage as never)
    && typeof value.skill === "string"
    && /^swe-[a-z][a-z0-9-]*$/.test(value.skill)
    && value.skill.length <= 128
    && validIdentity(value.identity, topic)
    && sameIdentity(value.identity as Record<string, unknown>, runner.identity as Record<string, unknown>)
    && (value.deliveryStatus === "prepared" || value.deliveryStatus === "sent");
}

const RUNNER_STAGES = [
  "specify", "diagnose", "plan", "dsa-assess", "tdd-plan", "plan-review", "plan-revise",
  "implement", "verify", "implementation-review", "finalize",
] as const;

function sameIdentity(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left.topic === right.topic
    && left.planRevision === right.planRevision
    && left.contractId === right.contractId
    && left.contractPath === right.contractPath
    && left.contractHash === right.contractHash;
}

function isTopicPath(path: string, topic: string): boolean {
  return path.length <= 2_048
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== "..")
    && (path.startsWith(`.model-artifacts/initiatives/${topic}/`) || path.startsWith(`.model-artifacts/system/logs/pi-swe/${topic}/`));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validTopic(topic: string): boolean {
  const segments = topic.split("/");
  return isValidTopic(topic)
    && topic.length <= 256
    && segments.length <= 16
    && segments.every((segment) => segment.length <= 64);
}

function validOwnerToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function hasSymlinkedSegment(root: string, candidate: string): boolean {
  if (!isWithin(root, candidate)) return true;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

type RunnerWriteLock = { path: string; diagnostic?: PiSweRunnerPersistenceDiagnostic };

function acquireWriteLock(repositoryRoot: string, topic: string, ownerToken: string): RunnerWriteLock {
  const statePath = runnerStatePath(topic);
  const lockPath = runnerLockPath(topic);
  const absoluteLockPath = resolve(repositoryRoot, lockPath);
  try {
    mkdirSync(dirname(absoluteLockPath), { recursive: true });
    mkdirSync(absoluteLockPath, { mode: 0o700 });
    writeFileSync(join(absoluteLockPath, "owner"), `${ownerToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fsyncDirectory(absoluteLockPath);
    return { path: absoluteLockPath };
  } catch (error) {
    if (existsSync(absoluteLockPath)) {
      try {
        const lockStat = lstatSync(absoluteLockPath);
        if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
          return {
            path: absoluteLockPath,
            diagnostic: diagnostic("invalid_state", "runner state write lock is not a repository-local directory", statePath),
          };
        }
      } catch {
        return {
          path: absoluteLockPath,
          diagnostic: diagnostic("invalid_state", "runner state write lock could not be validated", statePath),
        };
      }
      let lockOwner = "unknown owner";
      try {
        const ownerPath = join(absoluteLockPath, "owner");
        const ownerStat = lstatSync(ownerPath);
        if (ownerStat.isFile() && !ownerStat.isSymbolicLink() && ownerStat.size <= 257) {
          lockOwner = readFileSync(ownerPath, "utf8").trim() || lockOwner;
        }
      } catch { /* incomplete stale lock */ }
      return {
        path: absoluteLockPath,
        diagnostic: diagnostic("owner_mismatch", `runner state write is locked by ${lockOwner}; explicit recovery is required`, statePath),
      };
    }
    return {
      path: absoluteLockPath,
      diagnostic: diagnostic("state_write_error", `could not acquire runner state write lock: ${errorMessage(error)}`, statePath),
    };
  }
}

function releaseWriteLock(lockPath: string): void {
  try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* stale lock fails future writes closed */ }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function diagnostic(code: PiSweRunnerPersistenceDiagnosticCode, message: string, path: string): PiSweRunnerPersistenceDiagnostic {
  return { code, message: message.slice(0, 512), path: path.slice(0, 2048) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
