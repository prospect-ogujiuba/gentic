#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportIndex = process.argv.indexOf("--report");
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
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", encoding: "utf8" });
  return { command: [command, ...args].join(" "), exitCode: result.status ?? 1 };
});
const lines = [
  "# Gentic release verification",
  "",
  `Created: ${new Date().toISOString()}`,
  "Purpose: Record reproducible release versions and all required verification results.",
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
];
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join("\n"));
console.log(`release-verify: wrote ${reportPath}`);
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
