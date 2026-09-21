#!/usr/bin/env node
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { validateCanonicalArtifactPath } from "../extensions/pi-artifacts/src/domain/normalize.ts";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = join(root, ".model-artifacts");
const issues: string[] = [];
let files = 0;
let directories = 0;

walk(artifactRoot);

if (issues.length) {
  console.error(`model-artifacts: invalid layout\n- ${issues.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`model-artifacts: canonical files=${files}; directories=${directories}`);
}

function walk(directory: string): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === artifactRoot) return;
    throw error;
  }
  directories += 1;
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { issues.push(`${path}: symbolic links are not allowed`); continue; }
    if (stat.isDirectory()) { walk(absolute); continue; }
    if (!stat.isFile()) { issues.push(`${path}: only regular files are allowed`); continue; }
    files += 1;
    try { validateCanonicalArtifactPath(path); }
    catch (error) { issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
