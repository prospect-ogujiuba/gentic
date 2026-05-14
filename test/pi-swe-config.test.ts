import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { DEFAULT_PI_SWE_CONFIG, loadEffectiveSweConfig } from "../extensions/pi-swe/src/config/index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-swe-config-"));
}

test("pi-swe effective config uses safe defaults when files are missing", () => {
  const cwd = tempDir();
  const homeDir = tempDir();

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.deepEqual(result.config, DEFAULT_PI_SWE_CONFIG);
  assert.deepEqual(result.diagnostics, []);
});

test("pi-swe effective config applies global overrides", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "pi-swe.json"), JSON.stringify({ mode: "enforced", stages: { plan: { enabled: false } } }));

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.equal(result.config.enabled, true);
  assert.equal(result.config.mode, "enforced");
  assert.deepEqual(result.config.stages.plan, { enabled: false });
  assert.deepEqual(result.config.stages.read, { enabled: true, mode: "advisory" });
});

test("pi-swe effective config lets project override global config", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "pi-swe.json"), JSON.stringify({ enabled: false, mode: "enforced", stages: { scope: { enabled: false } } }));
  writeFileSync(join(cwd, ".pi", "pi-swe.json"), JSON.stringify({ enabled: true, mode: "advisory", stages: { scope: { enabled: true } } }));

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.equal(result.config.enabled, true);
  assert.equal(result.config.mode, "advisory");
  assert.deepEqual(result.config.stages.scope, { enabled: true });
});

test("pi-swe effective config supports disabled config", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-swe.json"), JSON.stringify({ enabled: false, mode: "off" }));

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.equal(result.config.enabled, false);
  assert.equal(result.config.mode, "off");
});

test("pi-swe effective config falls back safely for malformed config", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-swe.json"), "{");

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.deepEqual(result.config, DEFAULT_PI_SWE_CONFIG);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /failed to parse pi-swe config/);
});

test("pi-swe effective config ignores invalid and unknown fields with diagnostics", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-swe.json"), JSON.stringify({ enabled: "yes", mode: "strict", extra: true, stages: { read: false } }));

  const result = loadEffectiveSweConfig({ cwd, homeDir });

  assert.equal(result.config.enabled, true);
  assert.equal(result.config.mode, "advisory");
  assert.deepEqual(result.config.stages.read, { enabled: true, mode: "advisory" });
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("unknown pi-swe config field 'extra'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enabled'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'mode'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid stages.read")));
});

test("pi-swe config resources remain top-level discoverable", () => {
  const extensionRoot = join(process.cwd(), "extensions", "pi-swe");
  const schemaPath = join(extensionRoot, "pi-swe.schema.json");
  const anatomy = JSON.parse(readFileSync(join(extensionRoot, "extension.anatomy.json"), "utf8"));

  for (const resourceDir of ["docs", "prompts", "skills", "references"]) {
    assert.equal(existsSync(join(extensionRoot, resourceDir)), true, `${resourceDir}/ should stay top-level`);
    assert.ok(anatomy.resources.includes(resourceDir), `${resourceDir}/ should be declared as a pi-swe resource`);
  }

  assert.equal(existsSync(schemaPath), true, "pi-swe.schema.json should stay top-level for compatibility");
  assert.ok(anatomy.resources.includes("schemas"), "top-level schema files should be declared as resources");
});
