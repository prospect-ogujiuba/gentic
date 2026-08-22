#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PI_CONTRACT_SCHEMA_VERSION,
  PI_CONTRACT_SOURCE,
  PI_EXTENSION_EVENT_GROUPS,
  PI_NATIVE_CAPABILITY_GROUPS,
  PI_PACKAGE_SURFACES,
} from "../src/pi-contract.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = join(root, "node_modules", PI_CONTRACT_SOURCE.package, "package.json");
const declarationPath = join(root, "node_modules", PI_CONTRACT_SOURCE.package, PI_CONTRACT_SOURCE.declarations);
const outputPath = join(root, "catalog", "pi-native-capabilities.json");
const installed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
const declarations = readFileSync(declarationPath, "utf8");

if (installed.version !== PI_CONTRACT_SOURCE.version) {
  throw new Error(`Pinned Pi catalog source mismatch: expected ${PI_CONTRACT_SOURCE.version}, installed ${String(installed.version)}`);
}
for (const [group, entries] of Object.entries(PI_NATIVE_CAPABILITY_GROUPS)) {
  for (const entry of entries) {
    if (!declarations.includes(entry)) throw new Error(`Catalog entry ${group}.${entry} is absent from ${PI_CONTRACT_SOURCE.declarations}`);
  }
}

const catalog = {
  schemaVersion: PI_CONTRACT_SCHEMA_VERSION,
  source: PI_CONTRACT_SOURCE,
  packageSurfaces: PI_PACKAGE_SURFACES,
  eventGroups: PI_EXTENSION_EVENT_GROUPS,
  capabilityGroups: PI_NATIVE_CAPABILITY_GROUPS,
};
const rendered = `${JSON.stringify(catalog, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== rendered) throw new Error(`Catalog is stale: run npm run generate:catalog`);
  console.log(`pi-catalog: ok (${PI_CONTRACT_SOURCE.package} ${installed.version})`);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  console.log(`pi-catalog: wrote ${outputPath}`);
}
