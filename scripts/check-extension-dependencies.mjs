#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const GLOB_CHARACTERS = /[*?{}[\]]/;

export const TEMPORARY_PRIVATE_SRC_EXCEPTIONS = Object.freeze([
  Object.freeze({
    importer: "extensions/pi-hud/types.ts",
    specifier: "../pi-context/src/app/index.ts",
    target: "extensions/pi-context/src/app/index.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
  Object.freeze({
    importer: "extensions/pi-hud/src/app/git-status.ts",
    specifier: "../../../pi-git/src/app/snapshot.ts",
    target: "extensions/pi-git/src/app/snapshot.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
  Object.freeze({
    importer: "extensions/pi-hud/src/app/snapshot.ts",
    specifier: "../../../pi-context/src/app/index.ts",
    target: "extensions/pi-context/src/app/index.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
  Object.freeze({
    importer: "extensions/pi-hud/src/app/snapshot.ts",
    specifier: "../../../pi-context/src/domain/index.ts",
    target: "extensions/pi-context/src/domain/index.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
  Object.freeze({
    importer: "extensions/pi-hud/src/pi/runtime.ts",
    specifier: "../../../pi-context/src/config/index.ts",
    target: "extensions/pi-context/src/config/index.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
  Object.freeze({
    importer: "extensions/pi-hud/src/pi/runtime.ts",
    specifier: "../../../pi-context/src/domain/index.ts",
    target: "extensions/pi-context/src/domain/index.ts",
    removalOwner: "03-pi-hud-provider-decoupling",
  }),
]);

function toRepoPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function sourceFiles(root) {
  const extensionsRoot = join(root, "extensions");
  if (!existsSync(extensionsRoot)) return [];
  const files = [];
  const nonProductionDirectories = new Set(["test", "tests", "__tests__", "fixtures", "templates"]);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !nonProductionDirectories.has(entry.name)) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
    }
  };
  for (const extension of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (extension.isDirectory()) walk(join(extensionsRoot, extension.name));
  }
  return files.sort();
}

function privateSiblingTarget(root, importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(importer), specifier);
  const importerParts = toRepoPath(root, importer).split("/");
  const targetParts = toRepoPath(root, target).split("/");
  if (importerParts[0] !== "extensions" || targetParts[0] !== "extensions") return undefined;
  if (importerParts[1] === targetParts[1] || targetParts[2] !== "src") return undefined;
  return toRepoPath(root, target);
}

function validateExceptions(root, exceptions) {
  const keys = new Set();
  for (const exception of exceptions) {
    for (const field of ["importer", "specifier", "target", "removalOwner"]) {
      if (typeof exception[field] !== "string" || !exception[field] || GLOB_CHARACTERS.test(exception[field])) {
        throw new Error(`private-src exception must use an exact non-glob ${field}`);
      }
    }
    if (!exception.importer.startsWith("extensions/") || !exception.target.startsWith("extensions/") || !exception.specifier.startsWith(".")) {
      throw new Error("private-src exception must name an exact extension file and relative import");
    }
    const resolvedTarget = toRepoPath(root, resolve(dirname(join(root, exception.importer)), exception.specifier));
    if (resolvedTarget !== exception.target) {
      throw new Error(`private-src exception target does not match its import: ${exception.importer} -> ${exception.specifier}`);
    }
    const key = `${exception.importer}\0${exception.specifier}\0${exception.target}`;
    if (keys.has(key)) throw new Error(`duplicate private-src exception: ${exception.importer} -> ${exception.specifier}`);
    keys.add(key);
  }
  return keys;
}

export function checkProductionExtensionDependencies(root = SCRIPT_ROOT, exceptions = TEMPORARY_PRIVATE_SRC_EXCEPTIONS) {
  const exceptionKeys = validateExceptions(root, exceptions);
  const matchedExceptions = new Set();
  const violations = [];
  const files = sourceFiles(root);

  for (const importerPath of files) {
    const importer = toRepoPath(root, importerPath);
    const source = readFileSync(importerPath, "utf8");
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      const target = privateSiblingTarget(root, importerPath, specifier);
      if (!target) continue;
      const key = `${importer}\0${specifier}\0${target}`;
      if (exceptionKeys.has(key)) matchedExceptions.add(key);
      else violations.push({ importer, specifier, target });
    }
  }

  const staleExceptions = exceptions.filter((exception) => {
    const key = `${exception.importer}\0${exception.specifier}\0${exception.target}`;
    return !matchedExceptions.has(key);
  });
  return { violations, staleExceptions, scannedFiles: files.length };
}

export function formatDependencyFailures(result) {
  return [
    ...result.violations.map(({ importer, specifier, target }) =>
      `${importer}: forbidden sibling private-src import ${JSON.stringify(specifier)} -> ${target}`),
    ...result.staleExceptions.map(({ importer, specifier, removalOwner }) =>
      `${importer}: stale private-src exception ${JSON.stringify(specifier)} (removal owner: ${removalOwner})`),
  ];
}

function main() {
  const result = checkProductionExtensionDependencies();
  const failures = formatDependencyFailures(result);
  console.log(`check-extension-dependencies: scanned ${result.scannedFiles} production source files`);
  console.log(`check-extension-dependencies: temporary exceptions ${TEMPORARY_PRIVATE_SRC_EXCEPTIONS.length}`);
  for (const failure of failures) console.log(`  failure: ${failure}`);
  if (failures.length) {
    console.log(`check-extension-dependencies: failed (${failures.length})`);
    process.exitCode = 1;
  } else {
    console.log("check-extension-dependencies: passed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
