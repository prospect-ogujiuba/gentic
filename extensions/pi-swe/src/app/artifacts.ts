import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { parseInitiative, type Initiative } from "../domain/initiative.ts";

export function hashInitiativeArtifacts(cwd: string, initiative: Initiative): Initiative {
  const root = realpathSync(resolve(cwd));
  const prefix = `.model-artifacts/initiatives/${initiative.id}/`;
  const artifacts = initiative.artifacts.map((artifact) => {
    if (!artifact.path.startsWith(prefix)) throw new Error(`artifact path must use initiative topic ${initiative.id}`);
    const absolute = resolve(root, artifact.path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error("artifact path escapes project root");
    assertRegularPath(root, absolute);
    const contentHash = `sha256:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`;
    if (artifact.contentHash !== undefined && artifact.contentHash !== contentHash) {
      throw new Error(`artifact content hash mismatch: ${artifact.path}`);
    }
    return { ...artifact, contentHash };
  });
  return parseInitiative({ ...initiative, artifacts });
}

function assertRegularPath(root: string, path: string): void {
  let cursor = path;
  while (cursor !== root) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`artifact path contains a symbolic link: ${path}`);
    if (cursor === path && !stat.isFile()) throw new Error(`artifact must be a regular file: ${path}`);
    if (cursor !== path && !stat.isDirectory()) throw new Error(`artifact parent must be a directory: ${path}`);
    cursor = dirname(cursor);
  }
}
