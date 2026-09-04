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
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import { loadMigrationConfig } from "../domain/inventory.ts";
import { fingerprint, type MigrationMove, type MigrationPlan, type MigrationPlanBlocker, type MigrationPlanBounds, type MigrationRewrite } from "../domain/plan.ts";
import { projectRelative, resolveProjectPath, toPosix } from "../domain/normalize.ts";

const CLAIM_PATH = ".model-artifacts/system/logs/model-artifact-migration/active.claim.json";
const PLAN_KEYS = new Set(["schemaVersion", "generatedAt", "durationMs", "projectRoot", "configPath", "configFingerprint", "moves", "rewrites", "expectedPostTransformHashes", "authorityUnits", "bounds", "blockers", "eligible", "fingerprint"]);
const PLAN_BLOCKER_CODES = new Set<MigrationPlanBlocker["code"]>(["inventory-diagnostic", "unsafe-entry", "missing-identity", "destination-exists", "duplicate-destination", "destination-case-collision", "reference-cycle", "stale-source", "stale-reference", "affected-bytes-limit", "reference-limit", "rewrite-limit", "staging-bytes-limit", "rollback-bytes-limit", "no-moves"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type TransactionFaultStage = "preflight-complete" | "staging-complete" | "claim-acquired" | "journal-prepared" | "before-destination" | "destination-written" | "source-removed" | "ledger-written" | "recovery-record-restored" | "rollback-source-restored" | "finalize-marked" | "finalize-payloads-removed";
export type TransactionFault = (stage: TransactionFaultStage, move?: MigrationMove) => void;

export type ApplyMigrationOptions = { cwd: string; planPath: string; ownerToken?: string; fault?: TransactionFault };
export type ApplyMigrationResult = { status: "applied" | "already-applied"; ledgerPath: string; moved: number };
export type RollbackMigrationOptions = { cwd: string; ledgerPath: string; ownerToken?: string; fault?: TransactionFault };
export type RollbackMigrationResult = { status: "rolled-back" | "already-rolled-back"; ledgerPath: string; restored: number };
export type RecoverMigrationOptions = { cwd: string; journalPath: string; fault?: TransactionFault };
export type RecoverMigrationResult = { status: "recovered" | "already-recovered"; journalPath: string; restored: number };
export type FinalizeMigrationOptions = { cwd: string; ledgerPath: string; ownerToken?: string; fault?: TransactionFault };
export type FinalizeMigrationResult = { status: "finalized" | "already-finalized"; ledgerPath: string; reportPath: string; removedPayloads: number };

type Claim = { schemaVersion: 1; ownerToken: string; operation: "apply" | "rollback" | "finalize"; identity: string; createdAt: string };
type TransactionRecord = {
  kind: "move" | "rewrite";
  source: string;
  destination: string;
  originalHash: string;
  expectedHash: string;
  originalPayload: string;
  stagedPayload: string;
};
type PreparedBundle = { bundlePath: string; records: TransactionRecord[] };
type ApplyJournal = { schemaVersion: 2; operation: "apply"; planPath: string; planFingerprint: string; bundlePath: string; stage: "prepared" | "publishing" | "committed"; completed: number[]; current?: number };
type RollbackJournal = { schemaVersion: 2; operation: "rollback"; ledgerPath: string; bundlePath: string; stage: "prepared" | "restoring" | "committed"; restored: number[]; current?: number };
type MigrationLedger = {
  schemaVersion: 2;
  projectRoot: string;
  planPath: string;
  planFingerprint: string;
  state: "applied" | "rolled-back" | "finalizing" | "finalized";
  appliedAt: string;
  rolledBackAt?: string;
  finalizedAt?: string;
  finalizeReportPath?: string;
  bundlePath: string;
  moves: MigrationMove[];
  records: TransactionRecord[];
};

export function loadMigrationPlan(cwd: string, planPath: string): MigrationPlan {
  const root = realpathSync(resolve(cwd));
  if (!/^\.model-artifacts\/(?:system\/)?logs\/model-artifact-migration\/.+-plan\.json$/.test(planPath)) throw new Error(`plan path must name a saved migration plan: ${planPath}`);
  const absolute = resolveProjectPath(root, planPath);
  requireRegularNoSymlink(absolute, "migration plan");
  const raw: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("migration plan must be an object");
  const object = raw as Record<string, unknown>;
  if (object.schemaVersion !== 1) throw new Error(`unsupported migration plan schemaVersion: ${String(object.schemaVersion)}`);
  for (const key of Object.keys(object)) if (!PLAN_KEYS.has(key)) throw new Error(`unknown migration plan key: ${key}`);
  if (typeof object.generatedAt !== "string" || !Number.isSafeInteger(object.durationMs) || (object.durationMs as number) < 0 || typeof object.projectRoot !== "string" || (object.configPath !== null && typeof object.configPath !== "string")
    || typeof object.configFingerprint !== "string" || !SHA256_PATTERN.test(object.configFingerprint) || typeof object.eligible !== "boolean" || typeof object.fingerprint !== "string" || !SHA256_PATTERN.test(object.fingerprint)) throw new Error("migration plan scalar fields are invalid");
  if (object.configPath !== null) validateProjectRelativePath(root, object.configPath, "config path");
  if (!Array.isArray(object.moves) || !Array.isArray(object.rewrites) || !Array.isArray(object.authorityUnits) || !Array.isArray(object.blockers)
    || !object.expectedPostTransformHashes || typeof object.expectedPostTransformHashes !== "object" || Array.isArray(object.expectedPostTransformHashes)
    || !object.bounds || typeof object.bounds !== "object" || Array.isArray(object.bounds)) throw new Error("migration plan collections are invalid");
  const moves = object.moves.map((value) => parseMove(value, root));
  const rewrites = object.rewrites.map((value) => parseRewrite(value, root));
  const expectedPostTransformHashes = parseExpectedHashes(object.expectedPostTransformHashes, root);
  const authorityUnits = object.authorityUnits.map(parseAuthorityUnit);
  const bounds = parseBounds(object.bounds);
  const blockers = object.blockers.map((value) => parseBlocker(value, root));
  const logical = {
    schemaVersion: 1 as const,
    projectRoot: object.projectRoot,
    configPath: object.configPath,
    configFingerprint: object.configFingerprint,
    moves,
    rewrites,
    expectedPostTransformHashes,
    authorityUnits,
    bounds,
    blockers,
  };
  validatePlanRelationships(moves, rewrites, expectedPostTransformHashes, authorityUnits, bounds, blockers);
  const expected = fingerprint(logical);
  if (object.fingerprint !== expected) throw new Error(`migration plan fingerprint mismatch: expected ${expected}, observed ${object.fingerprint}`);
  if (object.eligible !== (blockers.length === 0) || moves.length === 0) throw new Error("migration plan eligibility does not match its moves and blockers");
  return { ...logical, generatedAt: object.generatedAt, durationMs: object.durationMs, eligible: object.eligible, fingerprint: object.fingerprint } as MigrationPlan;
}

export function applyMigration(options: ApplyMigrationOptions): ApplyMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const plan = loadMigrationPlan(root, options.planPath);
  const ledgerPath = ledgerPathForPlan(options.planPath);
  const ledgerAbsolute = resolveProjectPath(root, ledgerPath);
  if (existsSync(ledgerAbsolute)) {
    const ledger = loadLedger(root, ledgerPath);
    validateLedgerAgainstPlan(ledger, plan);
    if (ledger.state === "applied" || ledger.state === "finalizing" || ledger.state === "finalized") return { status: "already-applied", ledgerPath, moved: ledger.moves.length };
    throw new Error("migration plan was already rolled back; create a new plan before applying again");
  }
  validatePlanIdentity(root, plan);
  options.fault?.("preflight-complete");
  const journalPath = journalPathForPlan(options.planPath);
  const journalAbsolute = resolveProjectPath(root, journalPath);
  if (existsSync(journalAbsolute)) throw new Error(`unfinished migration journal requires recovery: ${journalPath}`);
  const claim = acquireClaim(root, { schemaVersion: 1, ownerToken: options.ownerToken ?? randomUUID(), operation: "apply", identity: plan.fingerprint, createdAt: new Date().toISOString() });
  try {
    options.fault?.("claim-acquired");
  } catch (error) {
    releaseClaim(root, claim);
    throw error;
  }

  let bundle: PreparedBundle | undefined;
  let journal: ApplyJournal | undefined;
  try {
    bundle = prepareBundle(root, options.planPath, plan);
    options.fault?.("staging-complete");
    journal = { schemaVersion: 2, operation: "apply", planPath: options.planPath, planFingerprint: plan.fingerprint, bundlePath: bundle.bundlePath, stage: "prepared", completed: [] };
    writeJournalExclusive(journalAbsolute, journal);
    options.fault?.("journal-prepared");
    for (const [index, record] of bundle.records.entries()) {
      assertClaim(root, claim);
      journal = { ...journal, stage: "publishing", current: index };
      writeJournalAtomic(journalAbsolute, journal);
      const move = plan.moves.find((candidate) => candidate.source === record.source);
      options.fault?.("before-destination", move);
      publishRecord(root, record);
      options.fault?.("destination-written", move);
      journal = { ...journal, completed: [...journal.completed, index], current: undefined };
      writeJournalAtomic(journalAbsolute, journal);
      options.fault?.("source-removed", move);
    }
    assertClaim(root, claim);
    journal = { ...journal, stage: "committed", current: undefined };
    writeJournalAtomic(journalAbsolute, journal);
    const ledger: MigrationLedger = {
      schemaVersion: 2,
      projectRoot: root,
      planPath: options.planPath,
      planFingerprint: plan.fingerprint,
      state: "applied",
      appliedAt: new Date().toISOString(),
      bundlePath: bundle.bundlePath,
      moves: plan.moves,
      records: bundle.records,
    };
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
    if (!journal) {
      if (bundle && existsSync(resolveProjectPath(root, bundle.bundlePath))) rmSync(resolveProjectPath(root, bundle.bundlePath), { recursive: true, force: true });
      releaseClaim(root, claim);
      throw error;
    }
    throw new Error(`migration interrupted at ${journal.stage}; journal retained at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function recoverMigration(options: RecoverMigrationOptions): RecoverMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const journalAbsolute = resolveProjectPath(root, options.journalPath);
  const recoveryPath = recoveryPathForJournal(options.journalPath);
  const recoveryAbsolute = resolveProjectPath(root, recoveryPath);
  if (!existsSync(journalAbsolute)) {
    if (existsSync(recoveryAbsolute)) {
      const recovered = JSON.parse(readFileSync(recoveryAbsolute, "utf8")) as { restored: number };
      return { status: "already-recovered", journalPath: options.journalPath, restored: recovered.restored };
    }
    throw new Error(`recovery journal does not exist: ${options.journalPath}`);
  }
  const journal = loadJournal(root, options.journalPath);
  const claim = loadActiveClaim(root);
  if (journal.operation === "apply") {
    if (claim.operation !== "apply" || claim.identity !== journal.planFingerprint) throw new Error("recovery claim does not match apply journal");
    const plan = loadMigrationPlan(root, journal.planPath);
    if (plan.fingerprint !== journal.planFingerprint) throw new Error("recovery journal plan fingerprint mismatch");
    if (journal.bundlePath !== journal.planPath.replace(/-plan\.json$/, "-transaction")) throw new Error("recovery journal bundle does not match plan identity");
    const bundle = loadPreparedBundle(root, journal.bundlePath, journal.planFingerprint);
    validateRecordsAgainstPlan(bundle.records, bundle.bundlePath, plan);
    restorePreimages(root, bundle.records, plan.moves, options.fault);
    rmSync(resolveProjectPath(root, journal.bundlePath), { recursive: true, force: true });
    writeJsonExclusive(recoveryAbsolute, { schemaVersion: 1, operation: "apply-recovery", journalPath: options.journalPath, planFingerprint: journal.planFingerprint, restored: bundle.records.length, recoveredAt: new Date().toISOString() });
    unlinkSync(journalAbsolute);
    releaseClaim(root, claim);
    return { status: "recovered", journalPath: options.journalPath, restored: bundle.records.length };
  }
  if (claim.operation !== "rollback") throw new Error("recovery claim does not match rollback journal");
  const ledger = loadLedger(root, journal.ledgerPath);
  restoreForRollback(root, ledger.records, journal, journalAbsolute, ledger.moves, options.fault);
  const completed: MigrationLedger = { ...ledger, state: "rolled-back", rolledBackAt: new Date().toISOString() };
  writeJsonAtomic(resolveProjectPath(root, journal.ledgerPath), completed);
  writeJsonExclusive(recoveryAbsolute, { schemaVersion: 1, operation: "rollback-recovery", journalPath: options.journalPath, restored: ledger.records.length, recoveredAt: new Date().toISOString() });
  unlinkSync(journalAbsolute);
  releaseClaim(root, claim);
  return { status: "recovered", journalPath: options.journalPath, restored: ledger.records.length };
}

export function rollbackMigration(options: RollbackMigrationOptions): RollbackMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const ledger = loadLedger(root, options.ledgerPath);
  const plan = loadMigrationPlan(root, ledger.planPath);
  validateLedgerAgainstPlan(ledger, plan);
  if (ledger.state === "finalized" || ledger.state === "finalizing") throw new Error("migration is finalized; rollback payloads were irreversibly removed");
  if (ledger.state === "rolled-back") return { status: "already-rolled-back", ledgerPath: options.ledgerPath, restored: ledger.records.length };
  if (ledger.projectRoot !== root) throw new Error(`ledger project root mismatch: ${ledger.projectRoot}`);
  validateAppliedRecords(root, ledger.records);
  const claim = acquireClaim(root, { schemaVersion: 1, ownerToken: options.ownerToken ?? randomUUID(), operation: "rollback", identity: ledger.planFingerprint, createdAt: new Date().toISOString() });
  const journalPath = rollbackJournalPath(options.ledgerPath);
  const journalAbsolute = resolveProjectPath(root, journalPath);
  if (existsSync(journalAbsolute)) {
    releaseClaim(root, claim);
    throw new Error(`unfinished rollback journal requires recovery: ${journalPath}`);
  }
  let journal: RollbackJournal = { schemaVersion: 2, operation: "rollback", ledgerPath: options.ledgerPath, bundlePath: ledger.bundlePath, stage: "prepared", restored: [] };
  writeJournalExclusive(journalAbsolute, journal);
  try {
    for (const index of ledger.records.map((_, index) => index).reverse()) {
      assertClaim(root, claim);
      journal = { ...journal, stage: "restoring", current: index };
      writeJournalAtomic(journalAbsolute, journal);
      restoreRecord(root, ledger.records[index]!);
      journal = { ...journal, restored: [...journal.restored, index], current: undefined };
      writeJournalAtomic(journalAbsolute, journal);
      options.fault?.("rollback-source-restored", plan.moves.find((move) => move.source === ledger.records[index]!.source));
    }
    journal = { ...journal, stage: "committed", current: undefined };
    writeJournalAtomic(journalAbsolute, journal);
    const completed: MigrationLedger = { ...ledger, state: "rolled-back", rolledBackAt: new Date().toISOString() };
    writeJsonAtomic(resolveProjectPath(root, options.ledgerPath), completed);
    unlinkSync(journalAbsolute);
    releaseClaim(root, claim);
    return { status: "rolled-back", ledgerPath: options.ledgerPath, restored: ledger.records.length };
  } catch (error) {
    throw new Error(`blocked rollback recovery; journal retained at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function finalizeMigration(options: FinalizeMigrationOptions): FinalizeMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  let ledger = loadLedger(root, options.ledgerPath);
  const reportPath = finalizeReportPath(options.ledgerPath);
  if (ledger.state === "finalized") return { status: "already-finalized", ledgerPath: options.ledgerPath, reportPath: ledger.finalizeReportPath ?? reportPath, removedPayloads: 0 };
  if (ledger.state !== "applied" && ledger.state !== "finalizing") throw new Error("only an applied migration can be finalized");
  validateAppliedRecords(root, ledger.records);
  const claim = acquireClaim(root, { schemaVersion: 1, ownerToken: options.ownerToken ?? randomUUID(), operation: "finalize", identity: ledger.planFingerprint, createdAt: new Date().toISOString() });
  try {
    const finalizedAt = ledger.finalizedAt ?? new Date().toISOString();
    if (ledger.state === "applied") {
      ledger = { ...ledger, state: "finalizing", finalizedAt, finalizeReportPath: reportPath };
      writeJsonAtomic(resolveProjectPath(root, options.ledgerPath), ledger);
      options.fault?.("finalize-marked");
    }
    const bundleAbsolute = resolveProjectPath(root, ledger.bundlePath);
    if (existsSync(bundleAbsolute)) rmSync(bundleAbsolute, { recursive: true, force: false });
    options.fault?.("finalize-payloads-removed");
    if (!existsSync(resolveProjectPath(root, reportPath))) {
      writeFileSync(resolveProjectPath(root, reportPath), `# Model-artifact migration finalized\n\n- Ledger: \`${options.ledgerPath}\`\n- Plan fingerprint: \`${ledger.planFingerprint}\`\n- Finalized: ${finalizedAt}\n- Removed rollback payloads: ${ledger.records.length}\n- Rollback: permanently unavailable\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    const completed: MigrationLedger = { ...ledger, state: "finalized" };
    writeJsonAtomic(resolveProjectPath(root, options.ledgerPath), completed);
    releaseClaim(root, claim);
    return { status: "finalized", ledgerPath: options.ledgerPath, reportPath, removedPayloads: ledger.records.length };
  } catch (error) {
    if (existsSync(resolveProjectPath(root, CLAIM_PATH))) releaseClaim(root, claim);
    throw error;
  }
}

function validatePlanIdentity(root: string, plan: MigrationPlan): void {
  if (!plan.eligible || plan.blockers.length > 0 || plan.moves.length === 0) throw new Error("migration plan is not eligible for apply");
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
  for (const rewrite of plan.rewrites) {
    const path = resolveProjectFile(root, rewrite.path);
    requireRegularNoSymlink(path, "migration rewrite source");
    const observed = hashFile(path);
    if (observed !== rewrite.sourceHash) throw new Error(`rewrite hash mismatch for ${rewrite.path}: expected ${rewrite.sourceHash}, observed ${observed}`);
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

function prepareBundle(root: string, planPath: string, plan: MigrationPlan): PreparedBundle {
  const bundlePath = planPath.replace(/-plan\.json$/, "-transaction");
  const bundleAbsolute = resolveProjectPath(root, bundlePath);
  if (existsSync(bundleAbsolute)) throw new Error(`transaction bundle already exists: ${bundlePath}`);
  ensureSafeParent(root, bundleAbsolute);
  mkdirSync(join(bundleAbsolute, "originals"), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundleAbsolute, "staged"), { recursive: true, mode: 0o700 });
  const moveBySource = new Map(plan.moves.map((move) => [move.source, move]));
  const rewriteByPath = new Map(plan.rewrites.map((rewrite) => [rewrite.path, rewrite]));
  const records: TransactionRecord[] = [];
  try {
    const paths = [...plan.moves.map((move) => move.source), ...plan.rewrites.filter((rewrite) => !moveBySource.has(rewrite.path)).map((rewrite) => rewrite.path)];
    for (const [index, path] of paths.entries()) {
      const move = moveBySource.get(path);
      const rewrite = rewriteByPath.get(path);
      const original = resolveProjectFile(root, path);
      const originalPayload = `${bundlePath}/originals/${String(index).padStart(6, "0")}.bin`;
      const stagedPayload = `${bundlePath}/staged/${String(index).padStart(6, "0")}.bin`;
      copyFileSync(original, resolveProjectPath(root, originalPayload), constants.COPYFILE_EXCL);
      const transformed = rewrite ? transformBytes(readFileSync(original), rewrite, plan) : readFileSync(original);
      writeBufferExclusive(resolveProjectPath(root, stagedPayload), transformed);
      const expectedHash = move ? plan.expectedPostTransformHashes[move.destination]! : rewrite!.expectedHash;
      if (hashFile(resolveProjectPath(root, originalPayload)) !== (move?.sourceHash ?? rewrite!.sourceHash)) throw new Error(`rollback payload hash mismatch: ${path}`);
      if (hashFile(resolveProjectPath(root, stagedPayload)) !== expectedHash) throw new Error(`staged transform hash mismatch: ${path}`);
      records.push({ kind: move ? "move" : "rewrite", source: path, destination: move?.destination ?? path, originalHash: move?.sourceHash ?? rewrite!.sourceHash, expectedHash, originalPayload, stagedPayload });
    }
    validateStagedGraph(root, plan, records);
    writeJsonExclusive(join(bundleAbsolute, "bundle.json"), { schemaVersion: 1, planFingerprint: plan.fingerprint, records });
    return { bundlePath, records };
  } catch (error) {
    rmSync(bundleAbsolute, { recursive: true, force: true });
    throw error;
  }
}

function transformBytes(bytes: Buffer, rewrite: MigrationRewrite, plan: MigrationPlan): Buffer {
  let content = bytes.toString("utf8");
  for (const replacement of rewrite.replacements) content = replaceExactReferences(content, replacement.from, replacement.to);
  if (/^\.model-artifacts\/specs\/.+\/manifest\.json$/.test(rewrite.path)) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.schemaVersion === 1) parsed.schemaVersion = 2;
    replaceContractRoots(parsed, new Map(plan.moves.map((move) => [move.source, move.destination])));
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (rewrite.path.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    replaceHashPointers(parsed, (path, previous) => plan.expectedPostTransformHashes[path] ?? previous);
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return Buffer.from(content);
}

function validateStagedGraph(root: string, plan: MigrationPlan, records: TransactionRecord[]): void {
  for (const record of records) {
    const staged = resolveProjectPath(root, record.stagedPayload);
    if (hashFile(staged) !== record.expectedHash) throw new Error(`staged graph hash mismatch: ${record.destination}`);
    const rewrite = plan.rewrites.find((item) => item.path === record.source);
    const content = readFileSync(staged, "utf8");
    for (const replacement of rewrite?.replacements ?? []) if (replaceExactReferences(content, replacement.from, replacement.to) !== content) throw new Error(`staged graph retains legacy reference: ${record.source}`);
    if (/\/specs\/manifest\.json$/.test(record.destination) && (JSON.parse(content) as { schemaVersion?: number }).schemaVersion !== 2) throw new Error(`staged manifest is not schema v2: ${record.destination}`);
  }
}

function publishRecord(root: string, record: TransactionRecord): void {
  const source = resolveProjectFile(root, record.source);
  const destination = resolveProjectFile(root, record.destination);
  requireRegularNoSymlink(source, "migration source");
  if (hashFile(source) !== record.originalHash) throw new Error(`source changed before publish: ${record.source}`);
  if (record.kind === "move") {
    ensureSafeParent(root, destination);
    copyFileSync(resolveProjectPath(root, record.stagedPayload), destination, constants.COPYFILE_EXCL);
    if (hashFile(destination) !== record.expectedHash) { unlinkSync(destination); throw new Error(`destination hash mismatch after write: ${record.destination}`); }
    unlinkSync(source);
    return;
  }
  replaceFromPayload(root, record.stagedPayload, record.source, record.expectedHash);
}

function validateAppliedRecords(root: string, records: TransactionRecord[]): void {
  for (const record of records) {
    const output = resolveProjectFile(root, record.destination);
    requireRegularNoSymlink(output, "migration destination");
    const observed = hashFile(output);
    if (observed !== record.expectedHash) throw new Error(`destination hash mismatch for ${record.destination}: expected ${record.expectedHash}, observed ${observed}`);
    if (record.kind === "move" && existsSync(resolveProjectFile(root, record.source))) throw new Error(`original source already exists: ${record.source}`);
  }
}

function restoreRecord(root: string, record: TransactionRecord): void {
  const originalPayload = resolveProjectPath(root, record.originalPayload);
  requireRegularNoSymlink(originalPayload, "rollback payload");
  if (hashFile(originalPayload) !== record.originalHash) throw new Error(`rollback payload hash mismatch: ${record.source}`);
  if (record.kind === "move") {
    const source = resolveProjectFile(root, record.source);
    const destination = resolveProjectFile(root, record.destination);
    if (existsSync(source)) {
      if (hashFile(source) !== record.originalHash) throw new Error(`source changed during rollback: ${record.source}`);
    } else {
      ensureSafeParent(root, source);
      copyFileSync(originalPayload, source, constants.COPYFILE_EXCL);
    }
    if (existsSync(destination)) {
      if (hashFile(destination) !== record.expectedHash) throw new Error(`destination hash mismatch for ${record.destination}`);
      unlinkSync(destination);
    }
    return;
  }
  const output = resolveProjectFile(root, record.source);
  if (hashFile(output) !== record.expectedHash && hashFile(output) !== record.originalHash) throw new Error(`rewrite changed during rollback: ${record.source}`);
  replaceFromPayload(root, record.originalPayload, record.source, record.originalHash);
}

function restorePreimages(root: string, records: TransactionRecord[], moves: MigrationMove[], fault?: TransactionFault): void {
  for (const record of [...records].reverse()) {
    const source = resolveProjectFile(root, record.source);
    const destination = resolveProjectFile(root, record.destination);
    if (record.kind === "move") {
      if (existsSync(source) && hashFile(source) !== record.originalHash) throw new Error(`source changed during recovery: ${record.source}`);
      if (existsSync(destination) && hashFile(destination) !== record.expectedHash) throw new Error(`destination changed during recovery: ${record.destination}`);
      if (!existsSync(source)) {
        ensureSafeParent(root, source);
        copyFileSync(resolveProjectPath(root, record.originalPayload), source, constants.COPYFILE_EXCL);
      }
      if (existsSync(destination)) unlinkSync(destination);
    } else {
      if (!existsSync(source)) throw new Error(`rewrite source missing during recovery: ${record.source}`);
      const observed = hashFile(source);
      if (observed !== record.originalHash && observed !== record.expectedHash) throw new Error(`rewrite changed during recovery: ${record.source}`);
      if (observed !== record.originalHash) replaceFromPayload(root, record.originalPayload, record.source, record.originalHash);
    }
    fault?.("recovery-record-restored", moves.find((move) => move.source === record.source));
  }
}

function restoreForRollback(root: string, records: TransactionRecord[], journal: RollbackJournal, journalAbsolute: string, moves: MigrationMove[], fault?: TransactionFault): void {
  for (const index of records.map((_, index) => index).reverse()) {
    if (journal.restored.includes(index)) continue;
    const record = records[index]!;
    restoreRecord(root, record);
    journal = { ...journal, stage: "restoring", restored: [...journal.restored, index], current: undefined };
    writeJournalAtomic(journalAbsolute, journal);
    fault?.("recovery-record-restored", moves.find((move) => move.source === record.source));
  }
}

function replaceFromPayload(root: string, payloadPath: string, targetPath: string, expectedHash: string): void {
  const target = resolveProjectFile(root, targetPath);
  ensureSafeParent(root, target);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  copyFileSync(resolveProjectPath(root, payloadPath), temporary, constants.COPYFILE_EXCL);
  if (hashFile(temporary) !== expectedHash) { unlinkSync(temporary); throw new Error(`payload hash mismatch for ${targetPath}`); }
  renameSync(temporary, target);
}

function writeBufferExclusive(path: string, bytes: Buffer): void {
  const handle = openSync(path, "wx", 0o600);
  try { writeSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
}

function loadPreparedBundle(root: string, bundlePath: string, expectedFingerprint?: string): PreparedBundle {
  const bundleAbsolute = resolveProjectPath(root, bundlePath);
  requireRegularNoSymlink(join(bundleAbsolute, "bundle.json"), "transaction bundle index");
  const value = JSON.parse(readFileSync(join(bundleAbsolute, "bundle.json"), "utf8")) as { schemaVersion?: number; planFingerprint?: string; records?: unknown[] };
  if (Object.keys(value).sort().join(",") !== "planFingerprint,records,schemaVersion" || value.schemaVersion !== 1 || typeof value.planFingerprint !== "string" || !Array.isArray(value.records)) throw new Error("transaction bundle is malformed");
  if (expectedFingerprint && value.planFingerprint !== expectedFingerprint) throw new Error("transaction bundle plan fingerprint mismatch");
  return { bundlePath, records: value.records.map((record) => parseTransactionRecord(record, root)) };
}

function loadJournal(root: string, journalPath: string): ApplyJournal | RollbackJournal {
  if (!/-apply-journal\.json$|-rollback-journal\.json$/.test(journalPath)) throw new Error(`recovery journal path is invalid: ${journalPath}`);
  const value = JSON.parse(readFileSync(resolveProjectPath(root, journalPath), "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 2 || (value.operation !== "apply" && value.operation !== "rollback")) throw new Error("recovery journal is malformed");
  const allowed = value.operation === "apply"
    ? new Set(["schemaVersion", "operation", "planPath", "planFingerprint", "bundlePath", "stage", "completed", "current"])
    : new Set(["schemaVersion", "operation", "ledgerPath", "bundlePath", "stage", "restored", "current"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("recovery journal is malformed");
  const indexes = value.operation === "apply" ? value.completed : value.restored;
  if (!Array.isArray(indexes) || indexes.some((index) => !Number.isSafeInteger(index) || (index as number) < 0) || (value.current !== undefined && (!Number.isSafeInteger(value.current) || (value.current as number) < 0))) throw new Error("recovery journal is malformed");
  if (typeof value.bundlePath !== "string") throw new Error("recovery journal is malformed");
  resolveProjectPath(root, value.bundlePath);
  if (value.operation === "apply" && (typeof value.planPath !== "string" || typeof value.planFingerprint !== "string")) throw new Error("recovery journal is malformed");
  if (value.operation === "rollback" && typeof value.ledgerPath !== "string") throw new Error("recovery journal is malformed");
  return value as ApplyJournal | RollbackJournal;
}

function loadActiveClaim(root: string): Claim {
  const absolute = resolveProjectPath(root, CLAIM_PATH);
  requireRegularNoSymlink(absolute, "migration claim");
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Claim;
  if (Object.keys(value).sort().join(",") !== "createdAt,identity,operation,ownerToken,schemaVersion" || value.schemaVersion !== 1 || !["apply", "rollback", "finalize"].includes(value.operation)
    || typeof value.ownerToken !== "string" || typeof value.identity !== "string" || typeof value.createdAt !== "string") throw new Error("migration claim is malformed");
  return value;
}

function replaceContractRoots(value: unknown, relocation: Map<string, string>): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceContractRoots(child, relocation)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.contractRoot === "string") {
    const contractRoot = object.contractRoot;
    const roots = [...relocation].flatMap(([source, destination]) => {
      if (!source.startsWith(`${contractRoot}/`)) return [];
      const suffix = source.slice(contractRoot.length);
      return [destination.slice(0, -suffix.length)];
    });
    if (new Set(roots).size === 1) object.contractRoot = roots[0];
  }
  Object.values(object).forEach((child) => replaceContractRoots(child, relocation));
}

function replaceHashPointers(value: unknown, replacement: (path: string, previous: string) => string): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceHashPointers(child, replacement)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.contentHash === "string") object.contentHash = replacement(object.path, object.contentHash);
  Object.values(object).forEach((child) => replaceHashPointers(child, replacement));
}

function replaceExactReferences(content: string, from: string, to: string): string {
  let cursor = 0;
  let output = "";
  let changed = false;
  while (cursor < content.length) {
    const index = content.indexOf(from, cursor);
    if (index < 0) { output += content.slice(cursor); break; }
    const before = content[index - 1];
    const after = content[index + from.length];
    const validBefore = before === undefined || /[\s"'`()<>\[\]{},:;]/.test(before);
    const validAfter = after === undefined || /[\s"'`()<>\[\]{},:;]/.test(after);
    output += content.slice(cursor, index);
    if (validBefore && validAfter) { output += to; changed = true; } else output += from;
    cursor = index + from.length;
  }
  return changed ? output : content;
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
  if (!/^\.model-artifacts\/(?:system\/)?logs\/model-artifact-migration\/.+-ledger\.json$/.test(ledgerPath)) throw new Error(`ledger path is invalid: ${ledgerPath}`);
  const absolute = resolveProjectPath(root, ledgerPath);
  requireRegularNoSymlink(absolute, "migration ledger");
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Partial<MigrationLedger>;
  const allowedKeys = new Set(["schemaVersion", "projectRoot", "planPath", "planFingerprint", "state", "appliedAt", "rolledBackAt", "finalizedAt", "finalizeReportPath", "bundlePath", "moves", "records"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)) || value.schemaVersion !== 2 || !["applied", "rolled-back", "finalizing", "finalized"].includes(value.state ?? "") || !Array.isArray(value.moves) || !Array.isArray(value.records)
    || typeof value.bundlePath !== "string" || typeof value.projectRoot !== "string" || typeof value.planPath !== "string" || typeof value.planFingerprint !== "string" || typeof value.appliedAt !== "string") throw new Error("migration ledger is malformed or unsupported");
  resolveProjectPath(root, value.bundlePath);
  const records = value.records.map((record) => parseTransactionRecord(record, root));
  return { ...value, moves: value.moves.map((move) => parseMove(move, root)), records } as MigrationLedger;
}

function parseTransactionRecord(value: unknown, root: string): TransactionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("transaction record is malformed");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "destination,expectedHash,kind,originalHash,originalPayload,source,stagedPayload"
    || (record.kind !== "move" && record.kind !== "rewrite") || typeof record.source !== "string" || typeof record.destination !== "string"
    || typeof record.originalHash !== "string" || !SHA256_PATTERN.test(record.originalHash) || typeof record.expectedHash !== "string" || !SHA256_PATTERN.test(record.expectedHash)
    || typeof record.originalPayload !== "string" || typeof record.stagedPayload !== "string") throw new Error("transaction record is malformed");
  resolveProjectFile(root, record.source as string);
  resolveProjectFile(root, record.destination as string);
  resolveProjectPath(root, record.originalPayload as string);
  resolveProjectPath(root, record.stagedPayload as string);
  return record as TransactionRecord;
}

function validatePlanRelationships(
  moves: MigrationMove[],
  rewrites: MigrationRewrite[],
  expectedHashes: Record<string, string>,
  authorityUnits: string[],
  bounds: MigrationPlanBounds,
  blockers: MigrationPlanBlocker[],
): void {
  const sortedMoves = [...moves].sort((a, b) => a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination));
  if (JSON.stringify(moves) !== JSON.stringify(sortedMoves) || new Set(moves.map((move) => move.source)).size !== moves.length) {
    throw new Error("migration move ordering or uniqueness is invalid");
  }
  const destinationCounts = new Map<string, number>();
  for (const move of moves) destinationCounts.set(move.destination, (destinationCounts.get(move.destination) ?? 0) + 1);
  for (const move of moves) {
    const duplicated = (destinationCounts.get(move.destination) ?? 0) > 1;
    const blocked = blockers.some((blocker) => blocker.code === "duplicate-destination" && blocker.source === move.source);
    if (duplicated !== blocked) throw new Error("migration move destination collision records are invalid");
  }
  const foldedDestinations = new Map<string, MigrationMove[]>();
  for (const move of moves) {
    const folded = move.destination.toLocaleLowerCase("en-US");
    foldedDestinations.set(folded, [...(foldedDestinations.get(folded) ?? []), move]);
  }
  for (const group of foldedDestinations.values()) {
    const collides = group.length > 1 && new Set(group.map((move) => move.destination)).size > 1;
    for (const move of group) {
      const blocked = blockers.some((blocker) => blocker.code === "destination-case-collision" && blocker.source === move.source);
      if (collides !== blocked) throw new Error("migration case-fold collision records are invalid");
    }
  }
  const sortedRewrites = [...rewrites].sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(rewrites) !== JSON.stringify(sortedRewrites) || new Set(rewrites.map((rewrite) => rewrite.path)).size !== rewrites.length) throw new Error("migration rewrite ordering or uniqueness is invalid");
  const sortedUnits = [...new Set(authorityUnits)].sort();
  if (JSON.stringify(authorityUnits) !== JSON.stringify(sortedUnits)) throw new Error("migration authority unit ordering or uniqueness is invalid");
  const sortedBlockers = [...blockers].sort((a, b) => a.source.localeCompare(b.source) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  if (JSON.stringify(blockers) !== JSON.stringify(sortedBlockers)) throw new Error("migration blocker ordering is invalid");

  const relocation = new Map(moves.map((move) => [move.source, move.destination]));
  const moveBySource = new Map(moves.map((move) => [move.source, move]));
  const rewriteByPath = new Map(rewrites.map((rewrite) => [rewrite.path, rewrite]));
  const expectedKeys = Object.keys(expectedHashes).sort();
  const destinationKeys = [...new Set(moves.map((move) => move.destination))].sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(destinationKeys)) throw new Error("migration expected hash keys do not match move destinations");

  for (const rewrite of rewrites) {
    const moved = moveBySource.get(rewrite.path);
    if (moved && (moved.sourceHash !== rewrite.sourceHash || moved.bytes !== rewrite.sourceBytes || ((destinationCounts.get(moved.destination) ?? 0) === 1 && expectedHashes[moved.destination] !== rewrite.expectedHash))) {
      throw new Error(`migration rewrite relationship is invalid: ${rewrite.path}`);
    }
    if (!moved && rewrite.replacements.length === 0) throw new Error(`migration rewrite relationship is invalid: ${rewrite.path}`);
    const seen = new Set<string>();
    for (const replacement of rewrite.replacements) {
      if (relocation.get(replacement.from) !== replacement.to || seen.has(replacement.from)) throw new Error(`migration rewrite relationship is invalid: ${rewrite.path}`);
      seen.add(replacement.from);
    }
  }
  for (const move of moves) {
    if ((destinationCounts.get(move.destination) ?? 0) > 1) continue;
    const rewrite = rewriteByPath.get(move.source);
    const expected = rewrite?.expectedHash ?? move.sourceHash;
    if (expectedHashes[move.destination] !== expected) throw new Error(`migration expected hash relationship is invalid: ${move.destination}`);
  }

  const externalRewrites = rewrites.filter((rewrite) => !moveBySource.has(rewrite.path));
  const affectedBytes = moves.reduce((sum, move) => sum + move.bytes, 0) + externalRewrites.reduce((sum, rewrite) => sum + rewrite.sourceBytes, 0);
  const rollbackBytes = affectedBytes;
  const stagingBytes = moves.reduce((sum, move) => sum + (rewriteByPath.get(move.source)?.expectedBytes ?? move.bytes), 0)
    + externalRewrites.reduce((sum, rewrite) => sum + rewrite.expectedBytes, 0);
  const references = rewrites.reduce((sum, rewrite) => sum + rewrite.replacements.length, 0);
  if (bounds.affectedBytes !== affectedBytes || bounds.rollbackBytes !== rollbackBytes || bounds.stagingBytes !== stagingBytes || bounds.references !== references || bounds.rewriteRecords !== rewrites.length) {
    throw new Error("migration bounds counts do not match plan records");
  }

  const limits: Array<[boolean, MigrationPlanBlocker["code"]]> = [
    [bounds.affectedBytes > bounds.maxAffectedBytes, "affected-bytes-limit"],
    [bounds.references > bounds.maxReferences, "reference-limit"],
    [bounds.rewriteRecords > bounds.maxRewriteRecords, "rewrite-limit"],
    [bounds.stagingBytes > bounds.maxStagingBytes, "staging-bytes-limit"],
    [bounds.rollbackBytes > bounds.maxRollbackBytes, "rollback-bytes-limit"],
  ];
  for (const [exceeded, code] of limits) {
    if (blockers.some((blocker) => blocker.code === code) !== exceeded) throw new Error(`migration bounds blocker does not match counts: ${code}`);
  }
}

function parseMove(value: unknown, root: string): MigrationMove {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration move must be an object");
  const move = value as Record<string, unknown>;
  const keys = Object.keys(move).sort().join(",");
  if (keys !== "bytes,destination,reason,source,sourceHash" || typeof move.source !== "string" || typeof move.destination !== "string" || typeof move.sourceHash !== "string" || !SHA256_PATTERN.test(move.sourceHash)
    || !Number.isSafeInteger(move.bytes) || (move.bytes as number) < 0 || typeof move.reason !== "string") throw new Error("migration move is malformed");
  resolveProjectPath(root, move.source);
  resolveProjectPath(root, move.destination);
  return move as MigrationMove;
}

function parseRewrite(value: unknown, root: string): MigrationRewrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration rewrite must be an object");
  const rewrite = value as Record<string, unknown>;
  if (Object.keys(rewrite).sort().join(",") !== "expectedBytes,expectedHash,path,replacements,sourceBytes,sourceHash" || typeof rewrite.path !== "string" || typeof rewrite.sourceHash !== "string" || !SHA256_PATTERN.test(rewrite.sourceHash)
    || typeof rewrite.expectedHash !== "string" || !SHA256_PATTERN.test(rewrite.expectedHash) || !Number.isSafeInteger(rewrite.sourceBytes) || (rewrite.sourceBytes as number) < 0
    || !Number.isSafeInteger(rewrite.expectedBytes) || (rewrite.expectedBytes as number) < 0 || !Array.isArray(rewrite.replacements)) throw new Error("migration rewrite is malformed");
  validateProjectRelativePath(root, rewrite.path, "rewrite path");
  const replacements = rewrite.replacements.map((replacement) => {
    if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) throw new Error("migration rewrite replacement is malformed");
    const object = replacement as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "from,to" || typeof object.from !== "string" || typeof object.to !== "string") throw new Error("migration rewrite replacement is malformed");
    resolveProjectPath(root, object.from);
    resolveProjectPath(root, object.to);
    return { from: object.from, to: object.to };
  });
  return { path: rewrite.path, sourceHash: rewrite.sourceHash, expectedHash: rewrite.expectedHash, sourceBytes: rewrite.sourceBytes as number, expectedBytes: rewrite.expectedBytes as number, replacements };
}

function parseExpectedHashes(value: unknown, root: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration expected hash records are malformed");
  const result: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    resolveProjectPath(root, path);
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) throw new Error(`migration expected hash record is malformed: ${path}`);
    result[path] = hash;
  }
  return result;
}

function parseAuthorityUnit(value: unknown): string {
  if (value === "isolated" || value === "system") return value;
  if (typeof value !== "string" || !/^initiative:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(value)) throw new Error("migration authority unit is malformed");
  return value;
}

function parseBounds(value: unknown): MigrationPlanBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration bounds are malformed");
  const bounds = value as Record<string, unknown>;
  const expectedKeys = "affectedBytes,maxAffectedBytes,maxReferences,maxRewriteRecords,maxRollbackBytes,maxStagingBytes,references,rewriteRecords,rollbackBytes,stagingBytes";
  if (Object.keys(bounds).sort().join(",") !== expectedKeys) throw new Error("migration bounds are malformed");
  for (const key of Object.keys(bounds)) {
    const number = bounds[key];
    const isMaximum = key.startsWith("max");
    if (!Number.isSafeInteger(number) || (number as number) < (isMaximum ? 1 : 0)) throw new Error(`migration bounds field is malformed: ${key}`);
  }
  return bounds as MigrationPlanBounds;
}

function parseBlocker(value: unknown, root: string): MigrationPlanBlocker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("migration blocker must be an object");
  const blocker = value as Record<string, unknown>;
  if (Object.keys(blocker).sort().join(",") !== "code,message,source" || typeof blocker.code !== "string" || !PLAN_BLOCKER_CODES.has(blocker.code as MigrationPlanBlocker["code"])
    || typeof blocker.source !== "string" || typeof blocker.message !== "string") throw new Error("migration blocker is malformed");
  validateProjectRelativePath(root, blocker.source, "blocker source");
  return blocker as MigrationPlanBlocker;
}

function validateProjectRelativePath(root: string, path: string, label: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || posix.normalize(path) !== path || path === ".." || path.startsWith("../")) throw new Error(`${label} is not project-relative: ${path}`);
  projectRelative(root, resolve(root, ...path.split("/")));
}

function resolveProjectFile(root: string, path: string): string {
  validateProjectRelativePath(root, path, "transaction path");
  return resolve(root, ...path.split("/"));
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
  if (ledger.bundlePath !== ledger.planPath.replace(/-plan\.json$/, "-transaction")) throw new Error("migration ledger bundle does not match plan identity");
  validateRecordsAgainstPlan(ledger.records, ledger.bundlePath, plan);
}

function validateRecordsAgainstPlan(records: TransactionRecord[], bundlePath: string, plan: MigrationPlan): void {
  const moveBySource = new Map(plan.moves.map((move) => [move.source, move]));
  const rewriteByPath = new Map(plan.rewrites.map((rewrite) => [rewrite.path, rewrite]));
  const paths = [...plan.moves.map((move) => move.source), ...plan.rewrites.filter((rewrite) => !moveBySource.has(rewrite.path)).map((rewrite) => rewrite.path)];
  if (records.length !== paths.length) throw new Error("migration ledger records do not match the saved plan");
  for (const [index, path] of paths.entries()) {
    const move = moveBySource.get(path);
    const rewrite = rewriteByPath.get(path);
    const record = records[index];
    const expected: TransactionRecord = {
      kind: move ? "move" : "rewrite",
      source: path,
      destination: move?.destination ?? path,
      originalHash: move?.sourceHash ?? rewrite!.sourceHash,
      expectedHash: move ? plan.expectedPostTransformHashes[move.destination]! : rewrite!.expectedHash,
      originalPayload: `${bundlePath}/originals/${String(index).padStart(6, "0")}.bin`,
      stagedPayload: `${bundlePath}/staged/${String(index).padStart(6, "0")}.bin`,
    };
    if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error("migration ledger records do not match the saved plan");
  }
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
  const handle = openSync(path, "wx", 0o600);
  try {
    writeSync(handle, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeJsonExclusive(temporary, value);
  renameSync(temporary, path);
}

function writeJournalExclusive(path: string, value: ApplyJournal | RollbackJournal): void {
  writeJsonExclusive(path, value);
  appendJournalEvent(path, value);
}

function writeJournalAtomic(path: string, value: ApplyJournal | RollbackJournal): void {
  writeJsonAtomic(path, value);
  appendJournalEvent(path, value);
}

function appendJournalEvent(path: string, value: ApplyJournal | RollbackJournal): void {
  const event = { recordedAt: new Date().toISOString(), operation: value.operation, stage: value.stage, current: value.current, completed: value.operation === "apply" ? value.completed : value.restored };
  const handle = openSync(path.replace(/-journal\.json$/, "-journal-events.jsonl"), "a", 0o600);
  try {
    writeSync(handle, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
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

function recoveryPathForJournal(journalPath: string): string {
  return journalPath.replace(/-(?:apply|rollback)-journal\.json$/, "-recovery.json");
}

function finalizeReportPath(ledgerPath: string): string {
  return ledgerPath.replace(/-ledger\.json$/, "-finalize-report.md");
}
