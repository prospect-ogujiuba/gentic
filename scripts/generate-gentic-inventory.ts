#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateGenticInventory } from "../src/release/inventory.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "catalog/gentic-inventory.json");
const rendered = `${JSON.stringify(generateGenticInventory(root), null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== rendered) {
    throw new Error("Generated Gentic inventory is stale; run npm run generate:inventory");
  }
  console.log("gentic-inventory: ok");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered);
  console.log(`gentic-inventory: wrote ${output}`);
}
