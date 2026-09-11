import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFixtureRecord, type FixtureRecord } from "./types.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/approved-plan/", import.meta.url));
const RUN_ROOT_MARKER = ".pi-swe-evaluator-owned";
const FIXTURE_ID = "approved-plan-v1";
const CONTRACT_IDS = ["P01-C01", "P01-C02", "P01-C03"] as const;

export type MaterializedFixture = {
  readonly workspacePath: string;
  readonly fixture: FixtureRecord;
};

export function createEvaluatorRunRoot(parentDirectory = tmpdir()): string {
  const parent = realpathSync.native(parentDirectory);
  const runRoot = mkdtempSync(join(parent, "pi-swe-eval-run-"));
  writeFileSync(join(runRoot, RUN_ROOT_MARKER), `${FIXTURE_ID}\n`, { encoding: "utf8", mode: 0o600 });
  return realpathSync.native(runRoot);
}

export function materializeApprovedPlanFixture(runRoot: string, workspaceId: string): MaterializedFixture {
  const ownedRoot = resolveOwnedRunRoot(runRoot);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workspaceId)) throw new Error("workspaceId must be a bounded path-safe identifier");

  const workspacePath = join(ownedRoot, workspaceId);
  mkdirSync(workspacePath, { recursive: false });
  try {
    for (const sourcePath of listFiles(FIXTURE_ROOT)) {
      const relativePath = relative(FIXTURE_ROOT, sourcePath);
      const destinationPath = join(workspacePath, relativePath);
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }

    const { digest, files } = digestContentTree(workspacePath);
    const fixture = parseFixtureRecord({
      schemaVersion: 1,
      fixtureId: FIXTURE_ID,
      contentTreeDigest: digest,
      files,
      contractIds: CONTRACT_IDS,
    });
    return { workspacePath: realpathSync.native(workspacePath), fixture };
  } catch (error) {
    rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupEvaluatorWorkspace(runRoot: string, workspacePath: string): void {
  const ownedRoot = resolveOwnedRunRoot(runRoot);
  const candidate = realpathSync.native(isAbsolute(workspacePath) ? workspacePath : resolve(workspacePath));
  if (candidate === ownedRoot || !candidate.startsWith(`${ownedRoot}${sep}`)) {
    throw new Error(`refusing cleanup outside evaluator run root: ${candidate}`);
  }
  rmSync(candidate, { recursive: true, force: false });
}

export function digestContentTree(root: string): { readonly digest: string; readonly files: readonly string[] } {
  const realRoot = realpathSync.native(root);
  const entries = listFiles(realRoot).map((path) => {
    const relativePath = relative(realRoot, path).split(sep).join("/");
    const contentHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    return [relativePath, contentHash] as const;
  });
  const digest = createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
  return { digest: `sha256:${digest}`, files: entries.map(([path]) => path) };
}

function resolveOwnedRunRoot(runRoot: string): string {
  const root = realpathSync.native(runRoot);
  const marker = join(root, RUN_ROOT_MARKER);
  if (!lstatSync(marker).isFile() || readFileSync(marker, "utf8") !== `${FIXTURE_ID}\n`) {
    throw new Error(`run root is not evaluator-owned: ${root}`);
  }
  return root;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`fixture content cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`fixture content must contain only regular files: ${path}`);
    }
  };
  visit(root);
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b), "en"));
}
