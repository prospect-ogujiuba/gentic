#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackageJson = join(piRoot, "package.json");
const extensionTypes = join(piRoot, "dist", "core", "extensions", "types.d.ts");
const contractArgIndex = process.argv.indexOf("--contract");
const contractPath = contractArgIndex >= 0 && process.argv[contractArgIndex + 1]
  ? resolve(root, process.argv[contractArgIndex + 1])
  : join(root, "src", "pi-contract.ts");
const packageJsonPath = join(root, "package.json");
const packageLockPath = join(root, "package-lock.json");

function fail(message) {
  console.error(`check-pi-api: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(piPackageJson)) fail("installed @earendil-works/pi-coding-agent package not found");
if (!existsSync(extensionTypes)) fail("installed Pi extension type declarations not found");
if (!existsSync(contractPath)) fail("src/pi-contract.ts not found");
if (!existsSync(packageJsonPath)) fail("package.json not found");
if (!existsSync(packageLockPath)) fail("package-lock.json not found");
if (process.exitCode) process.exit();

const piPackage = JSON.parse(readFileSync(piPackageJson, "utf8"));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
const dts = readFileSync(extensionTypes, "utf8");
const contract = readFileSync(contractPath, "utf8");

const supportedPiVersion = packageJson.dependencies?.["@earendil-works/pi-coding-agent"];
const lockedPiVersion = packageLock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version;
if (supportedPiVersion !== "0.84.2") fail(`package.json must pin the supported Pi baseline to 0.84.2, got ${String(supportedPiVersion)}`);
if (lockedPiVersion !== supportedPiVersion) fail(`package-lock Pi version must equal the documented baseline. expected=${String(supportedPiVersion)}, got=${String(lockedPiVersion)}`);
if (piPackage.version !== supportedPiVersion) fail(`installed Pi version must equal the repository baseline. expected=${String(supportedPiVersion)}, got=${String(piPackage.version)}`);

for (const path of [contractPath, packageJsonPath]) {
  const text = readFileSync(path, "utf8");
  if (text.includes(".model-artifacts/extension-types.ts") || text.includes(".model-artifacts\\extension-types.ts")) {
    fail(`${path} must not rely on generated .model-artifacts extension type snapshots`);
  }
}

const expectedManifest = {
  extensions: ["./extensions"],
  skills: ["./skills", "./extensions/**/skills", "!./skills/**/README.md", "!./extensions/**/skills/**/README.md"],
  prompts: ["./prompts/**/*.md", "./extensions/**/prompts/**/*.md", "!./prompts/**/README.md", "!./extensions/**/prompts/**/README.md"],
  themes: ["./themes/**/*.json", "./extensions/**/themes/**/*.json"],
};
for (const [key, expected] of Object.entries(expectedManifest)) {
  const actual = packageJson.pi?.[key] ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`package.json pi.${key} should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const expectedSurfaceIds = ["package", "extension", "skill", "prompt-template", "theme"];
const surfaceArray = contract.match(/PI_PACKAGE_SURFACE_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "";
const actualSurfaceIds = [...surfaceArray.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(actualSurfaceIds) !== JSON.stringify(expectedSurfaceIds)) {
  fail(`PI_PACKAGE_SURFACE_IDS should be ${JSON.stringify(expectedSurfaceIds)}, got ${JSON.stringify(actualSurfaceIds)}`);
}

for (const marker of ["interface ExtensionAPI", "registerTool", "registerCommand"]){
  if (!dts.includes(marker)) fail(`installed Pi extension declarations are missing expected marker: ${marker}`);
}

const expectedEvents = [...new Set([...dts.matchAll(/on\(event: "([^"]+)"/g)].map((match) => match[1]))];
const eventGroupsObject = contract.match(/PI_EXTENSION_EVENT_GROUPS\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] ?? "";
const actualEvents = [...eventGroupsObject.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) {
  fail(`PI_EXTENSION_EVENTS should match installed Pi events. expected=${JSON.stringify(expectedEvents)}, got=${JSON.stringify(actualEvents)}`);
}

if (!process.exitCode) {
  console.log(`check-pi-api: ok (@earendil-works/pi-coding-agent ${piPackage.version})`);
  console.log(`check-pi-api: manifest=root and extension-owned resources`);
}
