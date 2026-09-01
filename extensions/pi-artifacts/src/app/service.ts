import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { auditArtifacts, loadMigrationConfig } from "../domain/inventory.ts";
import { createMigrationPlan, fingerprint, type MigrationPlan } from "../domain/plan.ts";
import { projectRelative, toPosix } from "../domain/normalize.ts";
import type { ArtifactInventory } from "../domain/types.ts";

const MIGRATION_LOG_DIRECTORY = ".model-artifacts/logs/model-artifact-migration";

export type PlanMigrationOptions = {
  cwd: string;
  generatedAt?: string;
  maxFiles?: number;
  maxBytes?: number;
};

export type PlanMigrationResult = {
  inventory: ArtifactInventory;
  plan: MigrationPlan;
  planPath: string;
  reportPath: string;
};

export function planMigration(options: PlanMigrationOptions): PlanMigrationResult {
  const root = realpathSync(resolve(options.cwd));
  const inventory = auditArtifacts({ cwd: root, maxFiles: options.maxFiles, maxBytes: options.maxBytes });
  const config = loadMigrationConfig(root);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const plan = createMigrationPlan(inventory, { generatedAt, configFingerprint: fingerprint(config) });
  const timestamp = sortableTimestamp(generatedAt);
  const id = plan.fingerprint.slice("sha256:".length, "sha256:".length + 12);
  const directory = ensureSafeDirectory(root, MIGRATION_LOG_DIRECTORY);
  const planAbsolute = join(directory, `${timestamp}-${id}-plan.json`);
  const reportAbsolute = join(directory, `${timestamp}-${id}-plan-report.md`);
  const planPath = toPosix(projectRelative(root, planAbsolute));
  const reportPath = toPosix(projectRelative(root, reportAbsolute));
  if (existsSync(planAbsolute)) throw fileExists(planAbsolute);
  if (existsSync(reportAbsolute)) throw fileExists(reportAbsolute);
  let wrotePlan = false;
  try {
    writeFileSync(planAbsolute, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    wrotePlan = true;
    writeFileSync(reportAbsolute, renderPlanReport(plan, planPath), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (wrotePlan && existsSync(planAbsolute)) unlinkSync(planAbsolute);
    throw error;
  }
  return { inventory, plan, planPath, reportPath };
}

export function renderPlanReport(plan: MigrationPlan, planPath: string): string {
  const blockers = plan.blockers.slice(0, 20).map((blocker) => `- ${blocker.code}: \`${blocker.source}\` — ${blocker.message}`);
  return [
    "# Model-artifact migration plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Project root: \`${plan.projectRoot}\``,
    `Plan: \`${planPath}\``,
    `Fingerprint: \`${plan.fingerprint}\``,
    `Eligible: ${plan.eligible ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `- eligible moves: ${plan.moves.length}`,
    `- blockers: ${plan.blockers.length}`,
    "",
    "## Blockers",
    "",
    ...(blockers.length ? blockers : ["None."]),
    ...(plan.blockers.length > blockers.length ? [`- … ${plan.blockers.length - blockers.length} additional blockers omitted from this bounded report.`] : []),
    "",
    "## Next action",
    "",
    plan.eligible ? `Review the JSON plan, then run \`/artifacts apply ${planPath}\`.` : "Resolve every blocker and generate a new plan. This plan cannot be applied.",
    "",
  ].join("\n");
}

function ensureSafeDirectory(root: string, relativePath: string): string {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`migration log path is not a safe directory: ${toPosix(projectRelative(root, current))}`);
    const resolved = realpathSync(current);
    projectRelative(root, resolved);
    if (resolved !== current) throw new Error(`migration log directory resolves unexpectedly: ${toPosix(projectRelative(root, current))}`);
  }
  return current;
}

function sortableTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`invalid generatedAt timestamp: ${value}`);
  return date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
}

function fileExists(path: string): NodeJS.ErrnoException {
  const error = new Error(`migration artifact already exists: ${path}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}
