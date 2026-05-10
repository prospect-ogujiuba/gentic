#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackageJson = join(piRoot, "package.json");
const extensionTypes = join(piRoot, "dist", "core", "extensions", "types.d.ts");
const catalogPath = join(root, "catalog", "surfaces.ts");
const packageJsonPath = join(root, "package.json");

function fail(message) {
  console.error(`check-pi-api: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(piPackageJson)) fail("installed @earendil-works/pi-coding-agent package not found");
if (!existsSync(extensionTypes)) fail("installed Pi extension type declarations not found");
if (!existsSync(catalogPath)) fail("catalog/surfaces.ts not found");
if (!existsSync(packageJsonPath)) fail("package.json not found");
if (process.exitCode) process.exit();

const piPackage = JSON.parse(readFileSync(piPackageJson, "utf8"));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const dts = readFileSync(extensionTypes, "utf8");
const catalog = readFileSync(catalogPath, "utf8");

for (const path of [catalogPath, packageJsonPath]) {
  const text = readFileSync(path, "utf8");
  if (text.includes(".model-artifacts/extension-types.ts") || text.includes(".model-artifacts\\extension-types.ts")) {
    fail(`${path} must not rely on generated .model-artifacts extension type snapshots`);
  }
}

const expectedManifest = {
  extensions: ["./extensions", "./extensions/**/index.ts"],
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
const surfaceArray = catalog.match(/SURFACE_IDS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
const actualSurfaceIds = [...surfaceArray.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(actualSurfaceIds) !== JSON.stringify(expectedSurfaceIds)) {
  fail(`SURFACE_IDS should be ${JSON.stringify(expectedSurfaceIds)}, got ${JSON.stringify(actualSurfaceIds)}`);
}

for (const marker of ["interface ExtensionAPI", "registerTool", "registerCommand"]){
  if (!dts.includes(marker)) fail(`installed Pi extension declarations are missing expected marker: ${marker}`);
}

if (!process.exitCode) {
  console.log(`check-pi-api: ok (@earendil-works/pi-coding-agent ${piPackage.version})`);
  console.log(`check-pi-api: manifest=root and extension-owned resources`);
}
