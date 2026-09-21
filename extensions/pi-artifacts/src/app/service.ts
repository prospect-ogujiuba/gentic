import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { createArtifactPath, validateCanonicalArtifactPath } from "../domain/normalize.ts";
import type { CreateArtifactRequest, CreatedArtifact } from "../domain/types.ts";

export const MAX_ARTIFACT_CONTENT_BYTES = 1_048_576;

export class ArtifactService {
  readonly root: string;

  constructor(cwd: string) {
    this.root = realpathSync(resolve(cwd));
  }

  create(request: CreateArtifactRequest, options: { now?: Date } = {}): CreatedArtifact {
    validateContent(request.content);
    const createdAt = (options.now ?? new Date()).toISOString();
    const path = createArtifactPath(request, new Date(createdAt));
    validateCanonicalArtifactPath(path);
    const destination = resolve(this.root, path);
    assertInside(this.root, destination);
    ensureSafeDirectory(this.root, dirname(destination));
    publishNewFile(this.root, destination, request.content);
    return {
      path,
      createdAt,
      bytes: Buffer.byteLength(request.content),
      contentHash: `sha256:${createHash("sha256").update(request.content).digest("hex")}`,
    };
  }
}

function validateContent(content: string): void {
  if (typeof content !== "string" || !content.trim()) throw new Error("artifact content must be non-empty text");
  if (content.includes("\u0000")) throw new Error("artifact content contains a NUL byte");
  if (Buffer.byteLength(content) > MAX_ARTIFACT_CONTENT_BYTES) throw new Error("artifact content exceeds the 1 MiB limit");
}

function ensureSafeDirectory(root: string, directory: string): void {
  assertInside(root, directory);
  const relativeDirectory = relative(root, directory);
  let cursor = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) mkdirSync(cursor);
    assertSafeDirectory(root, cursor);
  }
  assertSafeDirectory(root, directory);
}

function assertSafeDirectory(root: string, directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`artifact parent is not a safe directory: ${relative(root, directory)}`);
  const canonical = realpathSync(directory);
  assertInside(root, canonical);
  if (canonical !== directory) throw new Error(`artifact parent changed or contains a symbolic link: ${relative(root, directory)}`);
}

function publishNewFile(root: string, destination: string, content: string): void {
  const directory = dirname(destination);
  assertSafeDirectory(root, directory);
  if (existsSync(destination)) throw new Error(`artifact already exists: ${destination}`);
  const temporary = join(directory, `.${randomUUID()}.artifact.tmp`);
  let handle: number | undefined;
  let published = false;
  try {
    handle = openSync(temporary, "wx", 0o666);
    writeFileSync(handle, content, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    assertSafeDirectory(root, directory);
    linkSync(temporary, destination);
    published = true;
    assertPublishedPath(root, destination);
    unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (published && existsSync(destination)) {
      try { unlinkSync(destination); syncDirectory(directory); }
      catch { /* preserve the original publication error */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`artifact already exists: ${destination}`);
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertPublishedPath(root: string, destination: string): void {
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("published artifact is not a regular file");
  const canonical = realpathSync(destination);
  assertInside(root, canonical);
  if (canonical !== destination) throw new Error("published artifact escaped its canonical path");
}

function syncDirectory(directory: string): void {
  const handle = openSync(directory, "r");
  try { fsyncSync(handle); }
  finally { closeSync(handle); }
}

function assertInside(root: string, path: string): void {
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("artifact path escapes the project root");
}
