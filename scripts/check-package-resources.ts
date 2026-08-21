#!/usr/bin/env node
import { resolve } from "node:path";
import { validatePackageResources } from "../src/package-resource-validation.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const { inventory, issues } = validatePackageResources(root);

console.log(
  `check-package-resources: extensions=${inventory.extensions.length} skills=${inventory.skills.length} prompts=${inventory.prompts.length} themes=${inventory.themes.length}`,
);
for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
if (issues.length) {
  console.error(`check-package-resources: failed (${issues.length} issues)`);
  process.exitCode = 1;
} else console.log("check-package-resources: ok");
