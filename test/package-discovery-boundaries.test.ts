import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  PI_PACKAGE_MANIFEST_KEY,
  PI_PACKAGE_RESOURCE_VOCABULARY,
} from "../src/pi-contract.ts";

const root = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const piManifest = packageJson[PI_PACKAGE_MANIFEST_KEY] as Record<string, string[]>;

function assertIncludes(manifestKey: string, pattern: string) {
  assert.ok(
    piManifest[manifestKey]?.includes(pattern),
    `package.json#pi.${manifestKey} must include ${pattern}`,
  );
}

test("package discovery includes the extension root", () => {
  assertIncludes(PI_PACKAGE_RESOURCE_VOCABULARY.extension.manifestKey, "./extensions");
});

test("package discovery includes root and extension-owned skill directories while excluding skill READMEs", () => {
  const manifestKey = PI_PACKAGE_RESOURCE_VOCABULARY.skill.manifestKey;

  assertIncludes(manifestKey, "./skills");
  assertIncludes(manifestKey, "./extensions/**/skills");
  assertIncludes(manifestKey, "!./skills/**/README.md");
  assertIncludes(manifestKey, "!./extensions/**/skills/**/README.md");
});

test("package discovery includes root and extension-owned prompt templates while excluding prompt READMEs", () => {
  const manifestKey = PI_PACKAGE_RESOURCE_VOCABULARY["prompt-template"].manifestKey;

  assertIncludes(manifestKey, "./prompts/**/*.md");
  assertIncludes(manifestKey, "./extensions/**/prompts/**/*.md");
  assertIncludes(manifestKey, "!./prompts/**/README.md");
  assertIncludes(manifestKey, "!./extensions/**/prompts/**/README.md");
});

test("package discovery includes root and extension-owned theme JSON", () => {
  const manifestKey = PI_PACKAGE_RESOURCE_VOCABULARY.theme.manifestKey;

  assertIncludes(manifestKey, "./themes/**/*.json");
  assertIncludes(manifestKey, "./extensions/**/themes/**/*.json");
});
