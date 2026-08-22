#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { PI_CONTRACT_SOURCE, PI_NATIVE_CAPABILITY_GROUPS } from "../src/pi-contract.ts";

export type DriftSet = { added: string[]; removed: string[] };
export type PiUpdateAnalysis = {
  currentVersion: string;
  targetVersion: string;
  currentSha256: string;
  targetSha256: string;
  events: DriftSet;
  extensionApiMethods: DriftSet;
  missingCatalogCapabilities: string[];
  changelogExcerpt: string[];
  driftDetected: boolean;
};
export type CheckResult = { name: string; command: string; status: "passed" | "failed" | "planned"; exitCode?: number };

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const declarationRelativePath = PI_CONTRACT_SOURCE.declarations;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((entry) => !rightSet.has(entry)).sort((a, b) => a.localeCompare(b));
}
function eventsFromDeclarations(value: string): string[] {
  return [...new Set([...value.matchAll(/\bon\(event:\s*["']([^"']+)["']/g)].map((match) => match[1]))].sort((a, b) => a.localeCompare(b));
}
function interfaceBody(value: string, name: string): string {
  const declaration = new RegExp(`(?:export\\s+)?interface\\s+${name}\\b`).exec(value);
  if (!declaration) return "";
  const open = value.indexOf("{", declaration.index + declaration[0].length);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(open + 1, index);
    }
  }
  return "";
}
function methodsFromDeclarations(value: string): string[] {
  const block = interfaceBody(value, "ExtensionAPI");
  return [...new Set([...block.matchAll(/^\s*(\w+)\??(?:<[^>]+>)?\s*\(/gm)].map((match) => match[1]))].sort((a, b) => a.localeCompare(b));
}

export function analyzePiUpdate(input: {
  currentVersion: string;
  targetVersion: string;
  currentDeclarations: string;
  targetDeclarations: string;
  changelog?: string;
}): PiUpdateAnalysis {
  const currentEvents = eventsFromDeclarations(input.currentDeclarations);
  const targetEvents = eventsFromDeclarations(input.targetDeclarations);
  const currentMethods = methodsFromDeclarations(input.currentDeclarations);
  const targetMethods = methodsFromDeclarations(input.targetDeclarations);
  const catalogCapabilities = Object.values(PI_NATIVE_CAPABILITY_GROUPS).flat().filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
  const missingCatalogCapabilities = [...new Set(catalogCapabilities.filter((entry) => !input.targetDeclarations.includes(entry)))].sort();
  const events = { added: difference(targetEvents, currentEvents), removed: difference(currentEvents, targetEvents) };
  const extensionApiMethods = { added: difference(targetMethods, currentMethods), removed: difference(currentMethods, targetMethods) };
  const currentSha256 = sha256(input.currentDeclarations);
  const targetSha256 = sha256(input.targetDeclarations);
  return {
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    currentSha256,
    targetSha256,
    events,
    extensionApiMethods,
    missingCatalogCapabilities,
    changelogExcerpt: (input.changelog ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(0, 20),
    driftDetected: currentSha256 !== targetSha256 || events.added.length > 0 || events.removed.length > 0 || extensionApiMethods.added.length > 0 || extensionApiMethods.removed.length > 0,
  };
}

export function renderPiUpdateReport(analysis: PiUpdateAnalysis, checks: readonly CheckResult[], mode: "dry-run" | "apply"): string {
  const list = (values: readonly string[]) => values.length ? values.map((value) => `\`${value}\``).join(", ") : "none";
  return [
    "# Pi update compatibility report",
    "",
    `Created: ${new Date().toISOString()}`,
    "Purpose: Record pinned-to-candidate Pi declaration drift and compatibility matrix results.",
    "",
    `- Mode: ${mode}`,
    `- Node: ${process.version}`,
    `- Current Pi: ${analysis.currentVersion}`,
    `- Target Pi: ${analysis.targetVersion}`,
    `- Drift detected: ${analysis.driftDetected ? "yes" : "no"}`,
    `- Current declarations SHA-256: \`${analysis.currentSha256}\``,
    `- Target declarations SHA-256: \`${analysis.targetSha256}\``,
    "",
    "## Declaration drift",
    "",
    `- Events added: ${list(analysis.events.added)}`,
    `- Events removed: ${list(analysis.events.removed)}`,
    `- ExtensionAPI methods added: ${list(analysis.extensionApiMethods.added)}`,
    `- ExtensionAPI methods removed: ${list(analysis.extensionApiMethods.removed)}`,
    `- Catalog capabilities missing from target: ${list(analysis.missingCatalogCapabilities)}`,
    "",
    "## Compatibility matrix",
    "",
    "| Check | Command | Result |",
    "| --- | --- | --- |",
    ...checks.map((check) => `| ${check.name} | \`${check.command}\` | ${check.status}${check.exitCode === undefined ? "" : ` (${check.exitCode})`} |`),
    "",
    "## Changelog excerpt",
    "",
    ...(analysis.changelogExcerpt.length ? analysis.changelogExcerpt.map((line) => `> ${line}`) : ["> No changelog fixture was available. Inspect the upstream release notes before applying."]),
    "",
  ].join("\n");
}

function artifactTimestamp(date = new Date()): string {
  return date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
}
function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function run(command: string, args: string[]): CheckResult {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", encoding: "utf8" });
  return { name: args.join(" "), command: [command, ...args].join(" "), status: result.status === 0 ? "passed" : "failed", exitCode: result.status ?? 1 };
}
function candidateFromFixture(path: string): { directory: string; cleanup?: () => void } {
  return { directory: resolve(path) };
}
function candidateFromNpm(version: string): { directory: string; cleanup: () => void } {
  const temporary = mkdtempSync(join(tmpdir(), "gentic-pi-update-"));
  const packed = spawnSync("npm", ["pack", `${PI_CONTRACT_SOURCE.package}@${version}`, "--pack-destination", temporary], { cwd: root, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const archive = join(temporary, basename((packed.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? ""));
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", temporary], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`candidate extraction failed: ${extracted.stderr}`);
  return { directory: join(temporary, "package"), cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}
function updatePinnedVersion(version: string): void {
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { dependencies: Record<string, string> };
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) packageJson.dependencies[name] = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const contractPath = join(root, "src/pi-contract.ts");
  const contract = readFileSync(contractPath, "utf8");
  writeFileSync(contractPath, contract.replace(/(PI_CONTRACT_SOURCE\s*=\s*\{[\s\S]*?version:\s*)"[^"]+"/, `$1"${version}"`));
}

async function main(): Promise<void> {
  const fixture = valueAfter("--fixture");
  const requestedTarget = valueAfter("--target");
  const apply = process.argv.includes("--apply");
  const reportPath = resolve(valueAfter("--report") ?? join(root, `.model-artifacts/reports/pi-update/${artifactTimestamp()}-pi-update.md`));
  if (!fixture && !requestedTarget) throw new Error("Usage: npm run pi:update -- --target <version> [--apply] [--report <path>] or --fixture <dir>");
  if (apply && fixture) throw new Error("--apply cannot use a fixture package");

  const candidate = fixture ? candidateFromFixture(fixture) : candidateFromNpm(requestedTarget!);
  try {
    const candidatePackage = JSON.parse(readFileSync(join(candidate.directory, "package.json"), "utf8")) as { version: string };
    const targetVersion = candidatePackage.version;
    const currentDeclarations = readFileSync(join(root, "node_modules", PI_CONTRACT_SOURCE.package, declarationRelativePath), "utf8");
    const targetDeclarations = readFileSync(join(candidate.directory, declarationRelativePath), "utf8");
    const changelogPath = [join(candidate.directory, "CHANGELOG.md"), join(candidate.directory, "changelog.md")].find((path) => {
      try { readFileSync(path); return true; } catch { return false; }
    });
    const analysis = analyzePiUpdate({
      currentVersion: PI_CONTRACT_SOURCE.version,
      targetVersion,
      currentDeclarations,
      targetDeclarations,
      changelog: changelogPath ? readFileSync(changelogPath, "utf8") : undefined,
    });
    const checks: CheckResult[] = [
      {
        name: "candidate event contract",
        command: "compare ExtensionAPI.on overloads",
        status: analysis.events.added.length || analysis.events.removed.length ? "failed" : "passed",
      },
      {
        name: "candidate catalog capabilities",
        command: "compare PI_NATIVE_CAPABILITY_GROUPS with target declarations",
        status: analysis.missingCatalogCapabilities.length ? "failed" : "passed",
      },
    ];
    if (apply) {
      updatePinnedVersion(targetVersion);
      checks.push(run("npm", ["install"]));
      checks.push(run("npm", ["run", "generate:catalog"]));
      checks.push(run("npm", ["run", "generate:inventory"]));
      for (const script of ["typecheck", "check", "check:commands", "check:performance", "test"]) checks.push(run("npm", ["run", script]));
    } else {
      for (const script of ["typecheck", "check", "check:commands", "check:performance", "test"]) {
        checks.push({ name: script, command: `npm run ${script}`, status: "planned" });
      }
    }
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderPiUpdateReport(analysis, checks, apply ? "apply" : "dry-run"), { flag: "w" });
    console.log(`pi-update: ${analysis.driftDetected ? "drift detected" : "no drift"}; report ${reportPath}`);
    if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
  } finally {
    candidate.cleanup?.();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
