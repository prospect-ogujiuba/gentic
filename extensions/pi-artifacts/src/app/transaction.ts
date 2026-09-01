import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadMigrationConfig } from "../domain/inventory.ts";
import { fingerprint, type MigrationMove, type MigrationPlan, type MigrationPlanBlocker } from "../domain/plan.ts";
import { projectRelative, resolveProjectPath, toPosix } from "../domain/normalize.ts";

const CLAIM_PATH = ".model-artifacts/logs/model-artifact-migration/active.claim.json";
const PLAN_KEYS = new Set(["schemaVersion", "generatedAt", "projectRoot", "configPath", "configFingerprint", "moves", "blockers", "eligible", "fingerprint"]);

export type TransactionFaultStage = "claim-acquired" | "journal-prepared" | "before-destination" | "destination-written" | "source-removed" | "ledger-written" | "rollback-source-restored";
export type TransactionFault = (stage: TransactionFaultStage, move?: MigrationMove) => void;

export type ApplyMigrationOptions = {
  cwd: string;
  planPath: string;
  ownerToken?: string;
  fault?: TransactionFault;
};

export type ApplyMigrationResult = {
  status: "applied" | "already-applied";
  ledgerPath: string;
  moved: number;
};

export type RollbackMigrationOptions = {
  cwd: string;
  ledgerPath: string;
  ownerToken?: string;
  fault?: TransactionFault;
};

export type RollbackMigrationResult = {
  status: "rolled-back" | "already-rolled-back";
  ledgerPath: string;
  restored: number;
};

type Claim = { schemaVersion: 1; ownerToken: string; operation: "apply" | "rollback"; identity: string; createdAt: string };
type ApplyJournal = { schemaVersion: 1; operation: "apply"; planPath: string; planFingerprint: string; stage: "prepared" | "copying" | "copied" | "moved" | "committed"; completed: MigrationMove[]; current?: MigrationMove };
type RollbackJournal = { schemaVersion: 1; operation: "rollback"; ledgerPath: string; stage: "prepared" | "restoring" | "restored" | "committed"; restored: MigrationMove[]; current?: MigrationMove };
type MigrationLedger = { schemaVersion: 1; projectRoot: string; planPath: string; planFingerprint: string; state: "applied" | "rolled-back"; appliedAt: string; rolledBackAt?: string; moves: MigrationMove[] };

export function loadMigrationPlan(cwd: string, planPath: string): MigrationPlan {
  const root = realpathSync(resolve(cwd));
  if (!/^\.model-artifacts\/logs\/model-artifact-migration\/.+-plan\.json$/.test(planPath)) throw new Error(`plan path must name a saved migration plan: ${planPath}`);
  const absolute = resolveProjectPath(root, planPath);
  requireRegularNoSymlink(absolute, "migration plan");
  const raw: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("migration plan must be an object");
  const object = raw as Record<string, unknown>;
  if (object.schemaVersion !== 1) throw new Error(`unsupported migration plan schemaVersion: ${String(object.schemaVersion)}`);
  for (const key of Object.keys(object)) if (!PLAN_KEYS.has(key)) throw new Error(`unknown migration plan key: ${key}`);
  if (typeof object.generatedAt !== "string" || typeof object.projectRoot !== "string" || (object.configPath !== null && typeof object.configPath !== "string")
    || typeof object.configFingerprint !== "string" || typeof object.eligible !== "boolean" || typeof object.fingerprint !== "string") throw new Error("migration plan scalar fields are invalid");
  if (!Array.isArray(object.moves) || !Array.isArray(object.blockers)) throw new Error("migration plan moves and blockers must be arrays");
  const moves = object.moves.map(parseMove);
  const blockers = object.blockers.map(parseBlocker);
  const logical = { schemaVersion: 1 as const, projectRoot: object.projectRoot, configPath: object.configPath, configFingerprint: object.configFingerprint, moves, blockers };
  const expected = fingerprint(logical);
  if (object.fingerprint !== expected) throw new Error(`migration plan fingerprint mismatch: expected ${expected}, observed ${object.fingerprint}`);
  if (object.eligible !== (blockers.length === 0) || moves.length === 0) throw new Error("migration plan eligibility does not match its moves and blockers");
  return { ...logical, generatedAt: object.generatedAt, eligible: object.eligible, fingerprint: object.fingerprint };
}

export function applyMigration(options: ApplyMigrationOptions): ApplyMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const plan = loadMigrationPlan(root, options.planPath);
  const ledgerPath = ledgerPathForPlan(options.planPath);
  const ledgerAbsolute = resolveProjectPath(root, ledgerPath);
  if (existsSync(ledgerAbsolute)) {
    const ledger = loadLedger(root, ledgerPath);
    validateLedgerAgainstPlan(ledger, plan);
    if (ledger.state === "applied") return { status: "already-applied", ledgerPath, moved: ledger.moves.length };
    throw new Error("migration plan was already rolled back; create a new plan before applying again");
  }
  validatePlanIdentity(root, plan);
  const ownerToken = options.ownerToken ?? randomUUID();
  const claim = acquireClaim(root, { schemaVersion: 1, ownerToken, operation: "apply", identity: plan.fingerprint, createdAt: new Date().toISOString() });
  try {
    options.fault?.("claim-acquired");
  } catch (error) {
    releaseClaim(root, claim);
    throw error;
  }
  const journalPath = journalPathForPlan(options.planPath);
  const journalAbsolute = resolveProjectPath(root, journalPath);
  if (existsSync(journalAbsolute)) {
    releaseClaim(root, claim);
    throw new Error(`unfinished migration journal requires recovery: ${journalPath}`);
  }
  let journal: ApplyJournal = { schemaVersion: 1, operation: "apply", planPath: options.planPath, planFingerprint: plan.fingerprint, stage: "prepared", completed: [] };
  try {
    writeJsonExclusive(journalAbsolute, journal);
    options.fault?.("journal-prepared");
    for (const move of plan.moves) {
      assertClaim(root, claim);
      validateMoveBeforeWrite(root, move);
      journal = { ...journal, stage: "copying", current: move };
      writeJsonAtomic(journalAbsolute, journal);
      options.fault?.("before-destination", move);
      writeDestinationExclusive(root, move);
      journal = { ...journal, stage: "copied" };
      writeJsonAtomic(journalAbsolute, journal);
      options.fault?.("destination-written", move);
      assertClaim(root, claim);
      const source = resolveProjectPath(root, move.source);
      if (hashFile(source) !== move.sourceHash) throw new Error(`source hash mismatch before removal: ${move.source}`);
      unlinkSync(source);
      journal = { ...journal, stage: "moved", completed: [...journal.completed, move], current: undefined };
      writeJsonAtomic(journalAbsolute, journal);
      options.fault?.("source-removed", move);
    }
    assertClaim(root, claim);
    journal = { ...journal, stage: "committed", current: undefined };
    writeJsonAtomic(journalAbsolute, journal);
    const ledger: MigrationLedger = { schemaVersion: 1, projectRoot: root, planPath: options.planPath, planFingerprint: plan.fingerprint, state: "applied", appliedAt: new Date().toISOString(), moves: plan.moves };
    writeJsonExclusive(ledgerAbsolute, ledger);
    options.fault?.("ledger-written");
    unlinkSync(journalAbsolute);
    releaseClaim(root, claim);
    return { status: "applied", ledgerPath, moved: plan.moves.length };
  } catch (error) {
    if (existsSync(ledgerAbsolute)) {
      if (existsSync(journalAbsolute)) unlinkSync(journalAbsolute);
      releaseClaim(root, claim);
      return { status: "applied", ledgerPath, moved: plan.moves.length };
    }
    try {
      rollbackApplyJournal(root, journal);
      if (existsSync(journalAbsolute)) unlinkSync(journalAbsolute);
      releaseClaim(root, claim);
    } catch (recoveryError) {
      throw new Error(`blocked recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}; original: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

export function rollbackMigration(options: RollbackMigrationOptions): RollbackMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const ledger = loadLedger(root, options.ledgerPath);
  const plan = loadMigrationPlan(root, ledger.planPath);
  validateLedgerAgainstPlan(ledger, plan);
  if (ledger.state === "rolled-back") return { status: "already-rolled-back", ledgerPath: options.ledgerPath, restored: ledger.moves.length };
  if (ledger.projectRoot !== root) throw new Error(`ledger project root mismatch: ${ledger.projectRoot}`);
  for (const move of ledger.moves) validateMoveBeforeRollback(root, move);
  const claim = acquireClaim(root, { schemaVersion: 1, ownerToken: options.ownerToken ?? randomUUID(), operation: "rollback", identity: ledger.planFingerprint, createdAt: new Date().toISOString() });
  const journalPath = rollbackJournalPath(options.ledgerPath);
  const journalAbsolute = resolveProjectPath(root, journalPath);
  if (existsSync(journalAbsolute)) {
    releaseClaim(root, claim);
    throw new Error(`unfinished rollback journal requires recovery: ${journalPath}`);
  }
  let journal: RollbackJournal = { schemaVersion: 1, operation: "rollback", ledgerPath: options.ledgerPath, stage: "prepared", restored: [] };
  writeJsonExclusive(journalAbsolute, journal);
  try {
    for (const move of [...ledger.moves].reverse()) {
      assertClaim(root, claim);
      validateMoveBeforeRollback(root, move);
      journal = { ...journal, stage: "restoring", current: move };
      writeJsonAtomic(journalAbsolute, journal);
      restoreDestinationToSource(root, move);
      journal = { ...journal, stage: "restored", restored: [...journal.restored, move], current: undefined };
      writeJsonAtomic(journalAbsolute, journal);
      options.fault?.("rollback-source-restored", move);
    }
    assertClaim(root, claim);
    journal = { ...journal, stage: "committed", current: undefined };
    writeJsonAtomic(journalAbsolute, journal);
    const completed: MigrationLedger = { ...ledger, state: "rolled-back", rolledBackAt: new Date().toISOString() };
    writeJsonAtomic(resolveProjectPath(root, options.ledgerPath), completed);
    unlinkSync(journalAbsolute);
    releaseClaim(root, claim);
    return { status: "rolled-back", ledgerPath: options.ledgerPath, restored: ledger.moves.length };
  } catch (error) {
    throw new Error(`blocked rollback recovery; journal retained at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePlanIdentity(root: string, plan: MigrationPlan): void {
  if (plan.projectRoot !== root) throw new Error(`plan project root mismatch: ${plan.projectRoot}`);
  const currentConfig = fingerprint(loadMigrationConfig(root));
  if (currentConfig !== plan.configFingerprint) throw new Error(`plan config fingerprint mismatch: expected ${plan.configFingerprint}, observed ${currentConfig}`);
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const move of plan.moves) {
    if (sources.has(move.source)) throw new Error(`duplicate plan source: ${move.source}`);
    if (destinations.has(move.destination)) throw new Error(`duplicate plan destination: ${move.destination}`);
    sources.add(move.source);
    destinations.add(move.destination);
    validateMoveBeforeWrite(root, move);
  }
}

function validateMoveBeforeWrite(root: string, move: MigrationMove): void {
  const source = resolveProjectPath(root, move.source);
  requireRegularNoSymlink(source, "migration source");
  const observed = hashFile(source);
  if (observed !== move.sourceHash) throw new Error(`source hash mismatch for ${move.source}: expected ${move.sourceHash}, observed ${observed}`);
  const destination = resolveProjectPath(root, move.destination);
  validateSafeParent(root, destination);
  if (existsSync(destination)) throw new Error(`destination already exists: ${move.destination}`);
}

function validateMoveBeforeRollback(root: string, move: MigrationMove): void {
  const source = resolveProjectPath(root, move.source);
  if (existsSync(source)) throw new Error(`original source already exists: ${move.source}`);
  const destination = resolveProjectPath(root, move.destination);
  requireRegularNoSymlink(destination, "migration destination");
  const observed = hashFile(destination);
  if (observed !== move.sourceHash) throw new Error(`destination hash mismatch for ${move.destination}: expected ${move.sourceHash}, observed ${observed}`);
  validateSafeParent(root, source);
}

function writeDestinationExclusive(root: string, move: MigrationMove): void {
  const source = resolveProjectPath(root, move.source);
  const destination = resolveProjectPath(root, move.destination);
  ensureSafeParent(root, destination);
  const bytes = readFileSync(source);
  const handle = openSync(destination, "wx", 0o600);
  try {
    writeSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  const observed = hashFile(destination);
  if (observed !== move.sourceHash) throw new Error(`destination hash mismatch after write: ${move.destination}`);
}

function restoreDestinationToSource(root: string, move: MigrationMove): void {
  const source = resolveProjectPath(root, move.source);
  const destination = resolveProjectPath(root, move.destination);
  ensureSafeParent(root, source);
  copyFileSync(destination, source, constants.COPYFILE_EXCL);
  if (hashFile(source) !== move.sourceHash) {
    unlinkSync(source);
    throw new Error(`restored source hash mismatch: ${move.source}`);
  }
  unlinkSync(destination);
}

function rollbackApplyJournal(root: string, journal: ApplyJournal): void {
  const candidates = [...journal.completed];
  if (journal.current) candidates.push(journal.current);
  for (const move of candidates.reverse()) {
    const source = resolveProjectPath(root, move.source);
    const destination = resolveProjectPath(root, move.destination);
    const sourceExists = existsSync(source);
    const destinationExists = existsSync(destination);
    if (sourceExists && hashFile(source) !== move.sourceHash) throw new Error(`source changed during recovery: ${move.source}`);
    if (destinationExists && hashFile(destination) !== move.sourceHash) throw new Error(`destination changed during recovery: ${move.destination}`);
    if (!sourceExists && destinationExists) restoreDestinationToSource(root, move);
    else if (sourceExists && destinationExists) unlinkSync(destination);
    else if (!sourceExists && !destinationExists) throw new Error(`both source and destination are missing: ${move.source}`);
  }
}

function acquireClaim(root: string, claim: Claim): Claim {
  const absolute = resolveProjectPath(root, CLAIM_PATH);
  ensureSafeParent(root, absolute);
  try {
    writeJsonExclusive(absolute, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`migration claim already exists: ${CLAIM_PATH}`);
    throw error;
  }
  return claim;
}

function assertClaim(root: string, expected: Claim): void {
  const absolute = resolveProjectPath(root, CLAIM_PATH);
  const observed = JSON.parse(readFileSync(absolute, "utf8")) as Partial<Claim>;
  if (observed.ownerToken !== expected.ownerToken || observed.operation !== expected.operation || observed.identity !== expected.identity) throw new Error(`migration claim ownership mismatch: ${CLAIM_PATH}`);
}

function releaseClaim(root: string, expected: Claim): void {
  const absolute = resolveProjectPath(root, CLAIM_PATH);
  if (!existsSync(absolute)) return;
  assertClaim(root, expected);
  unlinkSync(absolute);
}

function loadLedger(root: string, ledgerPath: string): MigrationLedger {
  if (!/^\.model-artifacts\/logs\/model-artifact-migration\/.+-ledger\.json$/.test(ledgerPath)) throw new Error(`ledger path is invalid: ${ledgerPath}`);
  const absolute = resolveProjectPath(root, ledgerPath);
  requireRegularNoSymlink(absolute, "migration ledger");
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Partial<MigrationLedger>;
  if (value.schemaVersion !== 1 || (value.state !== "applied" && value.state !== "rolled-back") || !Array.isArray(value.moves)
    || typeof value.projectRoot !== "string" || typeof value.planPath !== "string" || typeof value.planFingerprint !== "string" || typeof value.appliedAt !== "string") throw new Error("migration ledger is malformed or unsupported");
  return { ...value, moves: value.moves.map(parseMove) } as MigrationLedger;
}

function parseMove(value: unknown): MigrationMove {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration move must be an object");
  const move = value as Record<string, unknown>;
  const keys = Object.keys(move).sort().join(",");
  if (keys !== "bytes,destination,reason,source,sourceHash" || typeof move.source !== "string" || typeof move.destination !== "string" || typeof move.sourceHash !== "string" || typeof move.bytes !== "number" || typeof move.reason !== "string") throw new Error("migration move is malformed");
  return move as MigrationMove;
}

function parseBlocker(value: unknown): MigrationPlanBlocker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration blocker must be an object");
  const blocker = value as Record<string, unknown>;
  if (Object.keys(blocker).sort().join(",") !== "code,message,source" || typeof blocker.code !== "string" || typeof blocker.source !== "string" || typeof blocker.message !== "string") throw new Error("migration blocker is malformed");
  return blocker as MigrationPlanBlocker;
}

function validateSafeParent(root: string, target: string): void {
  const relative = toPosix(projectRelative(root, dirname(target)));
  let current = root;
  let missing = false;
  for (const segment of relative === "." ? [] : relative.split("/")) {
    current = join(current, segment);
    if (missing || !existsSync(current)) {
      missing = true;
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe directory in migration path: ${toPosix(projectRelative(root, current))}`);
    if (realpathSync(current) !== current) throw new Error(`migration directory resolves unexpectedly: ${toPosix(projectRelative(root, current))}`);
  }
}

function ensureSafeParent(root: string, target: string): void {
  validateSafeParent(root, target);
  const relative = toPosix(projectRelative(root, dirname(target)));
  let current = root;
  for (const segment of relative === "." ? [] : relative.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) throw new Error(`unsafe directory in migration path: ${toPosix(projectRelative(root, current))}`);
  }
}

function validateLedgerAgainstPlan(ledger: MigrationLedger, plan: MigrationPlan): void {
  if (ledger.projectRoot !== plan.projectRoot || ledger.planFingerprint !== plan.fingerprint || ledger.planPath.length === 0) throw new Error("migration ledger does not match plan identity");
  if (JSON.stringify(ledger.moves) !== JSON.stringify(plan.moves)) throw new Error("migration ledger moves do not match the saved plan");
}

function requireRegularNoSymlink(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
}

function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function writeJsonExclusive(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeJsonExclusive(temporary, value);
  renameSync(temporary, path);
}

function ledgerPathForPlan(planPath: string): string {
  return planPath.replace(/-plan\.json$/, "-ledger.json");
}

function journalPathForPlan(planPath: string): string {
  return planPath.replace(/-plan\.json$/, "-apply-journal.json");
}

function rollbackJournalPath(ledgerPath: string): string {
  return ledgerPath.replace(/-ledger\.json$/, "-rollback-journal.json");
}
