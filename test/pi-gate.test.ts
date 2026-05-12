import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decide, loadConfig, patternRegex } from "../extensions/pi-gate/index.ts";

test("pi-gate wildcard patterns treat * and ? as globs", () => {
  assert.equal(patternRegex("git status*").test("git status --short"), true);
  assert.equal(patternRegex("node*").test("node --version"), true);
  assert.equal(patternRegex("chmod -R 777*").test("chmod -R 777 --help"), true);
  assert.equal(patternRegex("git diff ?").test("git diff x"), true);
  assert.equal(patternRegex("git diff ?").test("git diff xy"), false);
});

test("pi-gate applies configured allow ask and deny permissions before default", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  mkdirSync(join(cwd, ".pi/pi-gate"), { recursive: true });
  writeFileSync(join(cwd, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
    version: 2,
    enabled: true,
    mode: "ask",
    defaultAction: "ask",
    audit: { enabled: false },
    permissions: {
      allow: ["git status*"],
      ask: ["node*"],
      deny: ["chmod -R 777*"]
    }
  }));

  loadConfig(cwd);

  assert.equal(decide({ source: "agent", command: "git status --short", cwd }).action, "allow");
  assert.equal(decide({ source: "agent", command: "node --version", cwd }).action, "ask");
  const deny = decide({ source: "agent", command: "chmod -R 777 --help", cwd });
  assert.equal(deny.action, "deny");
  assert.match(deny.ruleId, /^config:deny:/);
});

test("pi-gate deny permissions override ask and allow matches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  mkdirSync(join(cwd, ".pi/pi-gate"), { recursive: true });
  writeFileSync(join(cwd, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
    version: 2,
    enabled: true,
    mode: "ask",
    defaultAction: "ask",
    audit: { enabled: false },
    permissions: {
      allow: ["chmod*"],
      ask: ["chmod -R*"],
      deny: ["chmod -R 777*"]
    }
  }));

  loadConfig(cwd);

  const decision = decide({ source: "agent", command: "chmod -R 777 --help", cwd });
  assert.equal(decision.action, "deny");
  assert.match(decision.ruleId, /^config:deny:/);
});

test("pi-gate loads global extension config and project config with project-specific permissions", () => {
  const originalHome = process.env.HOME;
  const originalOverride = process.env.PI_GATE_CONFIG;
  const home = mkdtempSync(join(tmpdir(), "pi-gate-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-project-"));
  delete process.env.PI_GATE_CONFIG;
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi/pi-gate"), { recursive: true });
    mkdirSync(join(cwd, ".pi/pi-gate"), { recursive: true });
    writeFileSync(join(home, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
      version: 2,
      enabled: true,
      mode: "ask",
      defaultAction: "ask",
      audit: { enabled: false },
      permissions: { allow: ["echo global*"] }
    }));
    writeFileSync(join(cwd, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
      version: 2,
      permissions: { deny: ["echo global secret*"] }
    }));

    loadConfig(cwd);

    assert.equal(decide({ source: "agent", command: "echo global ok", cwd }).action, "allow");
    assert.equal(decide({ source: "agent", command: "echo global secret token", cwd }).action, "deny");
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.PI_GATE_CONFIG; else process.env.PI_GATE_CONFIG = originalOverride;
  }
});
