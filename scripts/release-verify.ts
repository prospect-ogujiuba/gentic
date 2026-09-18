#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { formatCutoverReadiness, inspectCutoverReadiness } from "../extensions/pi-swe/src/cutover.ts";
import { PI_CONTRACT_SOURCE } from "../src/pi-contract.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportIndex = process.argv.indexOf("--report");
const activeTodosIndex = process.argv.indexOf("--active-todos");
const activeTodoCount = activeTodosIndex >= 0 ? Number(process.argv[activeTodosIndex + 1]) : Number.NaN;
const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const reportPath = resolve(reportIndex >= 0 && process.argv[reportIndex + 1]
  ? process.argv[reportIndex + 1]
  : `${root}/.model-artifacts/system/reports/release/${timestamp}-release-verification.md`);
const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  engines: { node: string };
};
const commands = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "check"]],
  ["npm", ["run", "check:commands"]],
  ["npm", ["run", "check:performance"]],
  ["npm", ["test"]],
] as const;
const results = commands.map(([command, args]) => {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1024 * 1024 });
  return { command: [command, ...args].join(" "), exitCode: result.status ?? 1 };
});
const piVersions = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]
  .map((name) => packageJson.dependencies[name] ?? "missing");
const readiness = inspectCutoverReadiness(root, {
  activeTodoCount,
  nodeVersion: process.version,
  nodeSupport: packageJson.engines.node,
  piVersions,
  expectedPiVersion: PI_CONTRACT_SOURCE.version,
  releaseChecks: results.map((result) => ({ name: result.command, passed: result.exitCode === 0 })),
});
const readinessText = formatCutoverReadiness(readiness);
const lines = [
  "# Gentic release verification",
  "",
  `Created: ${new Date().toISOString()}`,
  "Purpose: Record reproducible release versions, required checks, and read-only cutover readiness.",
  "",
  `- Gentic: ${packageJson.version}`,
  `- Pi: ${packageJson.dependencies["@earendil-works/pi-coding-agent"]}`,
  `- Node runtime: ${process.version}`,
  `- Node support: ${packageJson.engines.node}`,
  "",
  "| Check | Exit | Result |",
  "| --- | ---: | --- |",
  ...results.map((result) => `| \`${result.command}\` | ${result.exitCode} | ${result.exitCode === 0 ? "passed" : "failed"} |`),
  "",
  "## SWE cutover readiness",
  "",
  "```text",
  readinessText,
  "```",
  "",
  "A READY result is evidence only. This command never changes workflow state, runtime selection, publication state, or external authorization.",
  "",
];
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join("\n"));
console.log(readinessText);
console.log(`release-verify: wrote ${reportPath}`);
if (results.some((result) => result.exitCode !== 0) || !readiness.ready) process.exitCode = 1;
