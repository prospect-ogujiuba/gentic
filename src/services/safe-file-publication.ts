import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_SAFE_PUBLICATION_BYTES = 1_048_576;

export type SafePublicationErrorCode =
  | "invalid-path"
  | "workflow-authority"
  | "content-too-large"
  | "unsafe-parent"
  | "collision"
  | "unsafe-destination";

export class SafePublicationError extends Error {
  readonly code: SafePublicationErrorCode;

  constructor(code: SafePublicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafePublicationError";
    this.code = code;
  }
}

export type PublishNewTextFileOptions = {
  root: string;
  relativePath: string;
  content: string;
  maxBytes: number;
  temporaryTag: string;
};

export type PublishedTextFile = {
  path: string;
  relativePath: string;
  bytes: number;
};

/**
 * Publish a bounded UTF-8 file beneath .model-artifacts without replacing an
 * existing destination. This least-capability API never publishes workflow.json;
 * pi-swe owns that authority through its private store.
 */
export function publishNewTextFile(options: PublishNewTextFileOptions): PublishedTextFile {
  const root = fs.realpathSync(path.resolve(options.root));
  const relativePath = validatePublicationPath(options.relativePath);
  const bytes = Buffer.byteLength(options.content);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || bytes > options.maxBytes) {
    throw new SafePublicationError("content-too-large", `publication content exceeds the ${options.maxBytes} byte limit`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.temporaryTag)) {
    throw new SafePublicationError("invalid-path", "publication temporary tag must be kebab-case");
  }

  const destination = path.resolve(root, ...relativePath.split("/"));
  assertInside(root, destination);
  const directory = path.dirname(destination);
  ensureSafeDirectory(root, directory);
  publishExclusive(root, directory, destination, options.content, options.temporaryTag);
  return { path: destination, relativePath, bytes };
}

function validatePublicationPath(candidate: string): string {
  if (
    typeof candidate !== "string"
    || !candidate
    || candidate.length > 1_024
    || candidate.startsWith("/")
    || path.isAbsolute(candidate)
    || candidate.includes("\\")
    || candidate.includes("\u0000")
    || candidate !== path.posix.normalize(candidate)
  ) {
    throw new SafePublicationError("invalid-path", "publication path must be a normalized project-relative POSIX path");
  }
  const parts = candidate.split("/");
  if (parts[0] !== ".model-artifacts" || parts.some((part) => !part || part === "." || part === "..")) {
    throw new SafePublicationError("invalid-path", "publication path must be beneath .model-artifacts");
  }
  if (parts.some((part) => part.toLowerCase() === "workflow.json")) {
    throw new SafePublicationError("workflow-authority", "publication at or beneath workflow.json is reserved for pi-swe");
  }
  return candidate;
}

function ensureSafeDirectory(root: string, directory: string): void {
  assertInside(root, directory);
  const segments = path.relative(root, directory).split(path.sep).filter(Boolean);
  let cursor = root;
  let parentHandle = fs.openSync(root, fs.constants.O_RDONLY);
  try {
    let parentIdentity = fileIdentity(parentHandle);
    let stableParent = stableDirectoryPath(parentHandle, parentIdentity);
    assertStableDirectory(root, cursor, parentIdentity);

    for (const segment of segments) {
      const child = path.join(cursor, segment);
      const stableChild = path.join(stableParent, segment);
      if (!pathEntryExists(stableChild)) {
        try {
          fs.mkdirSync(stableChild);
          syncDirectory(stableParent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const childStat = fs.lstatSync(stableChild);
      if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
        throw new SafePublicationError("unsafe-parent", "publication parent is not a safe directory");
      }

      let childHandle: number | undefined;
      try {
        childHandle = fs.openSync(stableChild, fs.constants.O_RDONLY);
        const childIdentity = fileIdentity(childHandle);
        const stableGrandchildParent = stableDirectoryPath(childHandle, childIdentity);
        assertStableDirectory(root, child, childIdentity);
        fs.closeSync(parentHandle);
        parentHandle = childHandle;
        childHandle = undefined;
        parentIdentity = childIdentity;
        stableParent = stableGrandchildParent;
        cursor = child;
      } finally {
        if (childHandle !== undefined) fs.closeSync(childHandle);
      }
    }
    assertStableDirectory(root, directory, parentIdentity);
  } finally {
    fs.closeSync(parentHandle);
  }
}

function pathEntryExists(candidate: string): boolean {
  try { fs.lstatSync(candidate); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeDirectory(root: string, directory: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    throw new SafePublicationError("unsafe-parent", "publication parent is not a safe directory", { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SafePublicationError("unsafe-parent", "publication parent is not a safe directory");
  }
  const canonical = fs.realpathSync(directory);
  if (canonical !== root) assertInside(root, canonical);
  if (canonical !== directory) {
    throw new SafePublicationError("unsafe-parent", "publication parent changed or contains a symbolic link");
  }
}

function publishExclusive(root: string, directory: string, destination: string, content: string, tag: string): void {
  assertSafeDirectory(root, directory);
  let directoryHandle: number | undefined;
  let fileHandle: number | undefined;
  let stagedIdentity: FileIdentity | undefined;
  let stableTemporary: string | undefined;
  let stableDestination: string | undefined;
  let published = false;
  try {
    directoryHandle = fs.openSync(directory, fs.constants.O_RDONLY);
    const directoryIdentity = fileIdentity(directoryHandle);
    const stableDirectory = stableDirectoryPath(directoryHandle, directoryIdentity);
    assertStableDirectory(root, directory, directoryIdentity);
    stableDestination = path.join(stableDirectory, path.basename(destination));
    if (pathEntryExists(stableDestination)) throw collision(destination);

    stableTemporary = path.join(stableDirectory, `.${randomUUID()}.${tag}.tmp`);
    fileHandle = fs.openSync(stableTemporary, "wx", 0o666);
    stagedIdentity = fileIdentity(fileHandle);
    fs.writeFileSync(fileHandle, content, "utf8");
    fs.fsyncSync(fileHandle);
    fs.closeSync(fileHandle);
    fileHandle = undefined;

    assertStableDirectory(root, directory, directoryIdentity);
    fs.linkSync(stableTemporary, stableDestination);
    published = true;
    assertStableDirectory(root, directory, directoryIdentity);
    assertPublishedPath(root, destination, stableDestination, stagedIdentity);
    fs.unlinkSync(stableTemporary);
    stableTemporary = undefined;
    assertStableDirectory(root, directory, directoryIdentity);
    syncDirectory(stableDirectory);
    assertStableDirectory(root, directory, directoryIdentity);
  } catch (error) {
    if (fileHandle !== undefined) fs.closeSync(fileHandle);
    if (published && stagedIdentity && stableDestination && isSameFile(stableDestination, stagedIdentity)) {
      try { fs.unlinkSync(stableDestination); if (directoryHandle !== undefined) syncDirectory(stableDirectoryPath(directoryHandle, fileIdentity(directoryHandle))); }
      catch { /* preserve the original publication error */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw collision(destination);
    throw error;
  } finally {
    if (stagedIdentity && stableTemporary && isSameFile(stableTemporary, stagedIdentity)) fs.unlinkSync(stableTemporary);
    if (directoryHandle !== undefined) fs.closeSync(directoryHandle);
  }
}

type FileIdentity = { dev: bigint; ino: bigint };

function fileIdentity(handleOrPath: number | string): FileIdentity {
  const stat = typeof handleOrPath === "number"
    ? fs.fstatSync(handleOrPath, { bigint: true })
    : fs.lstatSync(handleOrPath, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function stableDirectoryPath(handle: number, expected: FileIdentity): string {
  for (const candidate of [`/proc/self/fd/${handle}`, `/dev/fd/${handle}`]) {
    let probe: number | undefined;
    try {
      probe = fs.openSync(path.join(candidate, "."), fs.constants.O_RDONLY);
      if (sameIdentity(fileIdentity(probe), expected)) return candidate;
    } catch { /* try the next descriptor filesystem */ }
    finally { if (probe !== undefined) fs.closeSync(probe); }
  }
  throw new SafePublicationError("unsafe-parent", "safe publication requires a stable directory-descriptor path");
}

function assertStableDirectory(root: string, directory: string, expected: FileIdentity): void {
  assertSafeDirectory(root, directory);
  if (!sameIdentity(fileIdentity(directory), expected)) {
    throw new SafePublicationError("unsafe-parent", "publication parent changed during publication");
  }
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function isSameFile(candidate: string, expected: FileIdentity): boolean {
  try { return sameIdentity(fileIdentity(candidate), expected); }
  catch { return false; }
}

function assertPublishedPath(root: string, destination: string, stableDestination: string, expected: FileIdentity): void {
  const stableStat = fs.lstatSync(stableDestination);
  if (stableStat.isSymbolicLink() || !stableStat.isFile() || !isSameFile(stableDestination, expected)) {
    throw new SafePublicationError("unsafe-destination", "published path is not the staged regular file");
  }
  const canonical = fs.realpathSync(destination);
  assertInside(root, canonical);
  if (canonical !== destination || !isSameFile(destination, expected)) {
    throw new SafePublicationError("unsafe-destination", "published file escaped its canonical path");
  }
}

function syncDirectory(directory: string): void {
  const handle = fs.openSync(directory, "r");
  try { fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
}

function collision(destination: string): SafePublicationError {
  return new SafePublicationError("collision", `publication destination already exists: ${destination}`);
}

function assertInside(root: string, candidate: string): void {
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new SafePublicationError("invalid-path", "publication path escapes the project root");
  }
}
