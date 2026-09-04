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
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import { loadMigrationConfig } from "../domain/inventory.ts";
import { fingerprint, type MigrationMove, type MigrationPlan, type MigrationPlanBlocker, type MigrationPlanBounds, type MigrationRewrite } from "../domain/plan.ts";
import { projectRelative, resolveProjectPath, toPosix } from "../domain/normalize.ts";

const CLAIM_PATH = ".model-artifacts/system/logs/model-artifact-migration/active.claim.json";
const PLAN_KEYS = new Set(["schemaVersion", "generatedAt", "durationMs", "projectRoot", "configPath", "configFingerprint", "moves", "rewrites", "expectedPostTransformHashes", "authorityUnits", "bounds", "blockers", "eligible", "fingerprint"]);
const PLAN_BLOCKER_CODES = new Set<MigrationPlanBlocker["code"]>(["inventory-diagnostic", "unsafe-entry", "missing-identity", "destination-exists", "duplicate-destination", "destination-case-collision", "reference-cycle", "stale-source", "stale-reference", "affected-bytes-limit", "reference-limit", "rewrite-limit", "staging-bytes-limit", "rollback-bytes-limit", "no-moves"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

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
  if (plan.rewrites.length > 0 || plan.authorityUnits.some((unit) => unit !== "isolated")) {
    throw new Error("complete-authority apply is assigned to P03-C02; review this read-only plan without applying it");
  }
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
  if (!/^\.model-artifacts\/(?:system\/)?logs\/model-artifact-migration\/.+-ledger\.json$/.test(ledgerPath)) throw new Error(`ledger path is invalid: ${ledgerPath}`);
  const absolute = resolveProjectPath(root, ledgerPath);
  requireRegularNoSymlink(absolute, "migration ledger");
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Partial<MigrationLedger>;
  if (value.schemaVersion !== 1 || (value.state !== "applied" && value.state !== "rolled-back") || !Array.isArray(value.moves)
    || typeof value.projectRoot !== "string" || typeof value.planPath !== "string" || typeof value.planFingerprint !== "string" || typeof value.appliedAt !== "string") throw new Error("migration ledger is malformed or unsupported");
  return { ...value, moves: value.moves.map((move) => parseMove(move, root)) } as MigrationLedger;
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
