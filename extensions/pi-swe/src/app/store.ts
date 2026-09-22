import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseInitialInitiative, parseInitiative, type Initiative } from "../domain/initiative.ts";
import { hashInitiativeArtifacts } from "./artifacts.ts";

export type StoredInitiative = { initiative: Initiative; hash: string; path: string };
export type MutationStage = "locked" | "history-written" | "before-publish" | "before-create-link" | "published";
export type InitiativeStoreErrorCode = "already-exists" | "identity-mismatch" | "invalid-proposal" | "locked" | "unsupported-filesystem";

export class InitiativeStoreError extends Error {
  readonly code: InitiativeStoreErrorCode;

  constructor(code: InitiativeStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InitiativeStoreError";
    this.code = code;
  }
}
export type StoreOptions = { fault?: (stage: MutationStage) => void };
export type MutationOptions = {
  expectedRevision: number;
  expectedHash?: string;
  reason: string;
  signal?: AbortSignal;
};

const queues = new Map<string, Promise<void>>();
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function initiativePath(cwd: string, initiativeId: string): string {
  if (!TOPIC.test(initiativeId) || initiativeId.length > 128) throw new Error("initiative id must be canonical kebab-case");
  return join(resolve(cwd), ".model-artifacts", "initiatives", initiativeId, "workflow.json");
}

export class InitiativeStore {
  readonly #root: string;
  readonly #fault?: (stage: MutationStage) => void;

  constructor(cwd: string, options: StoreOptions = {}) {
    this.#root = resolve(cwd);
    this.#fault = options.fault;
  }

  create(initiativeId: string, proposal: unknown, signal?: AbortSignal): Promise<StoredInitiative> {
    const path = initiativePath(this.#root, initiativeId);
    let initiative: Initiative;
    try {
      initiative = parseInitialInitiative(proposal);
      if (initiative.id !== initiativeId) throw new InitiativeStoreError("identity-mismatch", `initiative identity mismatch: expected ${initiativeId}`);
    } catch (error) {
      if (error instanceof InitiativeStoreError) throw error;
      throw new InitiativeStoreError("invalid-proposal", error instanceof Error ? error.message : String(error), { cause: error });
    }
    const previous = queues.get(path) ?? Promise.resolve();
    const run = previous.then(async () => {
      signal?.throwIfAborted();
      return this.#createLocked(initiativeId, initiative, signal);
    });
    const tail = run.then(() => undefined, () => undefined);
    queues.set(path, tail);
    void tail.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
    return run;
  }

  read(initiativeId: string): StoredInitiative {
    const path = initiativePath(this.#root, initiativeId);
    assertSafeAuthorityPath(this.#root, path);
    const bytes = readFileSync(path);
    let input: unknown;
    try { input = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new Error(`initiative JSON is malformed: ${error instanceof Error ? error.message : String(error)}`); }
    const initiative = parseInitiative(input);
    if (initiative.id !== initiativeId) throw new Error(`initiative identity mismatch: expected ${initiativeId}`);
    return { initiative, hash: sha256(bytes), path };
  }

  mutate(
    initiativeId: string,
    options: MutationOptions,
    mutate: (initiative: Initiative) => Initiative | Promise<Initiative>,
  ): Promise<StoredInitiative> {
    validateMutationOptions(options);
    const path = initiativePath(this.#root, initiativeId);
    const previous = queues.get(path) ?? Promise.resolve();
    const run = previous.then(async () => {
      options.signal?.throwIfAborted();
      return this.#mutateLocked(initiativeId, options, mutate);
    });
    const tail = run.then(() => undefined, () => undefined);
    queues.set(path, tail);
    void tail.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
    return run;
  }

  async #createLocked(initiativeId: string, initiative: Initiative, signal?: AbortSignal): Promise<StoredInitiative> {
    const path = initiativePath(this.#root, initiativeId);
    const lockPath = `${path}.lock`;
    let parentHandle: number | undefined;
    let lockHandle: number | undefined;
    let stableLockPath = lockPath;
    let temporary: string | undefined;
    let stableTemporary: string | undefined;
    try {
      assertSafeAuthorityPath(this.#root, path);
      fsyncAuthorityDirectories(this.#root, dirname(path));
      parentHandle = openSync(dirname(path), constants.O_RDONLY);
      const parentIdentity = authorityParentIdentity(parentHandle);
      const stableParent = stableDirectoryPath(parentHandle);
      const stableAuthority = join(stableParent, basename(path));
      stableLockPath = join(stableParent, basename(lockPath));
      try { lockHandle = openSync(stableLockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new InitiativeStoreError("locked", `initiative is locked by another process: ${initiativeId}`, { cause: error });
        throw error;
      }
      writeAllSync(lockHandle, `${JSON.stringify({ schemaVersion: 1, operation: "create", pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() })}\n`);
      fsyncSync(lockHandle);
      this.#fault?.("locked");
      signal?.throwIfAborted();
      assertStableAuthorityParent(this.#root, path, parentIdentity);
      if (existsSync(path)) throw new InitiativeStoreError("already-exists", `initiative already exists: ${initiativeId}`);

      const candidate = hashInitiativeArtifacts(this.#root, initiative);
      const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const hash = sha256(bytes);
      temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      stableTemporary = join(stableParent, basename(temporary));
      const handle = openSync(stableTemporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeAllSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
      this.#fault?.("before-publish");
      signal?.throwIfAborted();
      assertStableAuthorityParent(this.#root, path, parentIdentity);
      const verified = Buffer.from(`${JSON.stringify(hashInitiativeArtifacts(this.#root, initiative), null, 2)}\n`);
      if (!verified.equals(bytes)) throw new InitiativeStoreError("invalid-proposal", "initiative artifacts changed during creation");
      this.#fault?.("before-create-link");
      signal?.throwIfAborted();
      try { linkSync(stableTemporary, stableAuthority); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new InitiativeStoreError("already-exists", `initiative already exists: ${initiativeId}`, { cause: error });
        throw error;
      }
      try {
        assertStableAuthorityParent(this.#root, path, parentIdentity);
        const published = Buffer.from(`${JSON.stringify(hashInitiativeArtifacts(this.#root, initiative), null, 2)}\n`);
        if (!published.equals(bytes)) throw new InitiativeStoreError("invalid-proposal", "initiative artifacts changed during publication");
      } catch (error) {
        rmSync(stableAuthority, { force: true });
        fsyncDirectory(stableParent);
        throw error;
      }
      fsyncDirectory(stableParent);
      rmSync(stableTemporary);
      temporary = undefined;
      stableTemporary = undefined;
      fsyncDirectory(stableParent);
      this.#fault?.("published");
      return { initiative: candidate, hash, path };
    } finally {
      if (stableTemporary) rmSync(stableTemporary, { force: true });
      if (lockHandle !== undefined) closeSync(lockHandle);
      if (lockHandle !== undefined) rmSync(stableLockPath, { force: true });
      if (parentHandle !== undefined) closeSync(parentHandle);
    }
  }

  async #mutateLocked(
    initiativeId: string,
    options: MutationOptions,
    mutate: (initiative: Initiative) => Initiative | Promise<Initiative>,
  ): Promise<StoredInitiative> {
    const path = initiativePath(this.#root, initiativeId);
    const lockPath = `${path}.lock`;
    let lockHandle: number | undefined;
    let temporary: string | undefined;
    try {
      assertSafeAuthorityPath(this.#root, path);
      try { lockHandle = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new InitiativeStoreError("locked", `initiative is locked by another process: ${initiativeId}`, { cause: error });
        throw error;
      }
      writeAllSync(lockHandle, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() })}\n`);
      fsyncSync(lockHandle);
      this.#fault?.("locked");
      options.signal?.throwIfAborted();

      const before = this.read(initiativeId);
      if (before.initiative.revision !== options.expectedRevision || (options.expectedHash !== undefined && before.hash !== options.expectedHash)) {
        throw new Error(`stale initiative ${initiativeId}: expected revision/hash no longer current`);
      }
      const proposed = await mutate(structuredClone(before.initiative));
      options.signal?.throwIfAborted();
      const candidate = parseInitiative({ ...proposed, revision: before.initiative.revision + 1 });
      if (candidate.id !== initiativeId || candidate.kind !== before.initiative.kind || candidate.schemaVersion !== before.initiative.schemaVersion) throw new Error("initiative identity is immutable");
      const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const afterHash = sha256(bytes);
      writeRevisionHistory(this.#root, candidate, options.reason, before.hash, afterHash);
      this.#fault?.("history-written");
      options.signal?.throwIfAborted();

      temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      const handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeAllSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
      this.#fault?.("before-publish");
      options.signal?.throwIfAborted();
      renameSync(temporary, path);
      temporary = undefined;
      fsyncDirectory(dirname(path));
      this.#fault?.("published");
      return { initiative: candidate, hash: afterHash, path };
    } finally {
      if (temporary) rmSync(temporary, { force: true });
      if (lockHandle !== undefined) closeSync(lockHandle);
      if (lockHandle !== undefined) rmSync(lockPath, { force: true });
    }
  }
}

function writeRevisionHistory(root: string, initiative: Initiative, reason: string, beforeHash: string, afterHash: string): void {
  const directory = join(root, ".model-artifacts", "initiatives", initiative.id, "logs");
  mkdirSync(directory, { recursive: true });
  assertDirectoryNoSymlink(root, directory);
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}_${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const path = join(directory, `${stamp}-revision-${initiative.revision}.md`);
  const body = `# Initiative revision ${initiative.revision}\n\nTopic: ${initiative.id}\n\nReason: ${reason.trim()}\n\nPreimage: \`${beforeHash}\`\n\nPostimage: \`${afterHash}\`\n`;
  try { writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; throw new Error(`revision history already exists: ${path}`); }
  const handle = openSync(path, constants.O_RDONLY); try { fsyncSync(handle); } finally { closeSync(handle); }
  fsyncDirectory(directory);
}

function validateMutationOptions(options: MutationOptions): void {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) throw new Error("expectedRevision must be a positive integer");
  if (options.expectedHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.expectedHash)) throw new Error("expectedHash must be canonical sha256");
  if (typeof options.reason !== "string" || !options.reason.trim() || options.reason.length > 2_048 || /[\u0000]/.test(options.reason)) throw new Error("mutation reason must be bounded non-empty text");
}

function assertSafeAuthorityPath(root: string, path: string): void {
  const absoluteRoot = realpathSync(root);
  if (!resolve(path).startsWith(`${absoluteRoot}/`)) throw new Error("initiative path escapes project root");
  let cursor = dirname(path);
  const pending: string[] = [];
  while (!existsSync(cursor)) { pending.push(cursor); cursor = dirname(cursor); }
  if (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor) !== cursor) throw new Error("initiative path contains a symlink");
  for (const directory of pending.reverse()) mkdirSync(directory);
  assertDirectoryNoSymlink(absoluteRoot, dirname(path));
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error("initiative authority must be a regular file");
}

function assertDirectoryNoSymlink(root: string, directory: string): void {
  let cursor = resolve(directory); const boundary = resolve(root);
  while (cursor !== boundary) { const stat = lstatSync(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("initiative path contains a symlink"); cursor = dirname(cursor); }
}
function authorityParentIdentity(handleOrPath: number | string): { dev: bigint; ino: bigint } {
  const stat = typeof handleOrPath === "number" ? fstatSync(handleOrPath, { bigint: true }) : lstatSync(dirname(handleOrPath), { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}
function stableDirectoryPath(handle: number): string {
  const expected = authorityParentIdentity(handle);
  for (const path of [`/proc/self/fd/${handle}`, `/dev/fd/${handle}`]) {
    let probe: number | undefined;
    try {
      probe = openSync(join(path, "."), constants.O_RDONLY);
      const actual = authorityParentIdentity(probe);
      if (actual.dev === expected.dev && actual.ino === expected.ino) return path;
    } catch { /* try the next descriptor filesystem */ }
    finally { if (probe !== undefined) closeSync(probe); }
  }
  throw new InitiativeStoreError("unsupported-filesystem", "safe initiative creation requires a stable directory-descriptor path");
}
function assertStableAuthorityParent(root: string, path: string, expected: { dev: bigint; ino: bigint }): void {
  assertSafeAuthorityPath(root, path);
  const actual = authorityParentIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("initiative authority parent changed during publication");
}
function fsyncAuthorityDirectories(root: string, directory: string): void {
  let cursor = resolve(directory); const boundary = resolve(root);
  while (true) { fsyncDirectory(cursor); if (cursor === boundary) return; cursor = dirname(cursor); }
}
function fsyncDirectory(path: string): void { const handle = openSync(path, constants.O_RDONLY); try { fsyncSync(handle); } finally { closeSync(handle); } }
function writeAllSync(handle: number, value: Buffer | string): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(handle, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("initiative write made no progress");
    offset += written;
  }
}
function sha256(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
