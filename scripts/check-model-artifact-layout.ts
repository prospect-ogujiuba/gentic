#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { auditArtifacts } from "../extensions/pi-artifacts/src/domain/inventory.ts";

const root = resolve(import.meta.dirname, "..");
const legacyPattern = /\.model-artifacts\/(?:specs|plans|todo|findings|reports|logs)\//g;
const textExtensions = new Set([".json", ".jsonl", ".md", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".yaml", ".yml", ".txt"]);
const skippedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv"]);
const classifications = new Map<string, number>();
const unclassified: string[] = [];

for (const path of walk(root)) {
  const content = readFileSync(join(root, path), "utf8");
  const matches = content.match(legacyPattern)?.length ?? 0;
  if (!matches) continue;
  const classification = classifyLegacyReference(path);
  if (!classification) unclassified.push(`${path} (${matches})`);
  else classifications.set(classification, (classifications.get(classification) ?? 0) + matches);
}

const inventory = auditArtifacts({ cwd: root });
const artifactBlockers = inventory.entries.filter((entry) => ["legacy-movable", "ambiguous", "invalid"].includes(entry.classification));
for (const [classification, count] of [...classifications].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`model-artifacts: ${classification} legacy references=${count}`);
}
if (unclassified.length) console.error(`model-artifacts: unclassified kind-first references:\n- ${unclassified.join("\n- ")}`);
if (inventory.diagnostics.length) console.error(`model-artifacts: audit diagnostics:\n- ${inventory.diagnostics.join("\n- ")}`);
if (artifactBlockers.length) console.error(`model-artifacts: non-v2 artifacts:\n- ${artifactBlockers.map((entry) => `${entry.classification}: ${entry.source}`).join("\n- ")}`);
if (unclassified.length || inventory.diagnostics.length || artifactBlockers.length) process.exitCode = 1;
else console.log(`model-artifacts: canonical files=${inventory.totals["canonical-valid"] + inventory.totals.protected}; non-v2 artifacts=0`);

function classifyLegacyReference(path: string): string | undefined {
  if (path.startsWith("test/")) return "compatibility-fixture";
  if (path.startsWith("extensions/pi-artifacts/")) return "migration-compatibility";
  if (path === "extensions/pi-swe/src/planning.ts" || path === "extensions/pi-swe/README.md") return "v1-read-compatibility";
  if (path.startsWith(".model-artifacts/system/logs/model-artifact-migration/")) return "retained-transaction-evidence";
  if (path.startsWith(".model-artifacts/initiatives/")) return "historical-initiative-evidence";
  if (path === ".pi/model-artifacts-migration.json") return "migration-mapping";
  if (path === ".pi/pi-gate/pi-gate-audit.jsonl") return "historical-runtime-evidence";
  return undefined;
}

function walk(directory: string, prefix = ""): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) output.push(...walk(absolute, path));
    else if (stat.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) output.push(relative(root, absolute).split("\\").join("/"));
  }
  return output;
}
