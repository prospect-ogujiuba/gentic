import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_SAFE_PUBLICATION_BYTES,
  SafePublicationError,
  publishNewTextFile,
} from "../../../../src/services/safe-file-publication.ts";
import { createArtifactPath, validateCanonicalArtifactPath } from "../domain/normalize.ts";
import type { CreateArtifactRequest, CreatedArtifact } from "../domain/types.ts";

export const MAX_ARTIFACT_CONTENT_BYTES = MAX_SAFE_PUBLICATION_BYTES;

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
    try {
      publishNewTextFile({
        root: this.root,
        relativePath: path,
        content: request.content,
        maxBytes: MAX_ARTIFACT_CONTENT_BYTES,
        temporaryTag: "artifact",
      });
    } catch (error) {
      if (error instanceof SafePublicationError && error.code === "collision") {
        throw new Error(`artifact already exists: ${destination}`);
      }
      throw error;
    }
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
