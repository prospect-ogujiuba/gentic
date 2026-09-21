#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { ArtifactService } from "../extensions/pi-artifacts/index.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  engines: { node: string };
};
const checks = [
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "check", command: "npm", args: ["run", "check"] },
  { name: "check:commands", command: "npm", args: ["run", "check:commands"] },
  { name: "check:performance", command: "npm", args: ["run", "check:performance"] },
  { name: "test", command: "npm", args: ["test"] },
] as const;
const results = checks.map(({ name, command, args }) => {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return { name, exitCode: result.status ?? 1 };
});
const passed = results.every((result) => result.exitCode === 0);
const content = [
  "# Gentic release verification",
  "",
  `Created: ${new Date().toISOString()}`,
  "Purpose: Record reproducible release versions and required repository checks.",
  "",
  `- Gentic: ${packageJson.version}`,
  `- Pi: ${packageJson.dependencies["@earendil-works/pi-coding-agent"]}`,
  `- Node runtime: ${process.version}`,
  `- Node support: ${packageJson.engines.node}`,
  `- Result: ${passed ? "passed" : "failed"}`,
  "",
  "| Check | Exit | Result |",
  "| --- | ---: | --- |",
  ...results.map((result) => `| \`${result.name}\` | ${result.exitCode} | ${result.exitCode === 0 ? "passed" : "failed"} |`),
  "",
].join("\n");
const artifact = new ArtifactService(root).create({
  scope: "system",
  kind: "reports",
  namespace: "release",
  name: `release-verification-${process.pid}`,
  content,
});
console.log(`release-verify: ${passed ? "passed" : "failed"}`);
console.log(`release-verify: wrote ${artifact.path}`);
if (!passed) process.exitCode = 1;
