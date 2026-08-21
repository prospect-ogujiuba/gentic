#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const result = spawnSync("pi", ["-e", root, "--mode", "rpc", "--no-session"], {
  cwd: root,
  env: { ...process.env, PI_OFFLINE: "1" },
  input: `${JSON.stringify({ type: "get_commands" })}\n`,
  encoding: "utf8",
  timeout: 30_000,
});
if (result.error) throw result.error;
const response = result.stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .find((event) => event?.command === "get_commands");
if (!response?.success) {
  console.error(result.stderr || "Pi did not return get_commands provenance");
  process.exit(1);
}

const commands = response.data.commands.filter((command) => command.sourceInfo?.baseDir === root);
const failures = [];
const names = new Set();
for (const command of commands) {
  if (/:[0-9]+$/.test(command.name)) failures.push(`numeric collision suffix: /${command.name}`);
  if (names.has(command.name)) failures.push(`duplicate command: /${command.name}`);
  names.add(command.name);
  console.log(`/${command.name}\t${command.source}\t${command.sourceInfo.path}`);
}
if (!commands.length) failures.push("no Gentic package commands discovered");
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`check-command-inventory: ok (${commands.length} commands)`);
