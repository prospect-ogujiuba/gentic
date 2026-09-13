import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PI_CONTEXT_CONFIG,
  loadEffectiveContextConfig,
} from "../extensions/pi-context/src/config/index.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "pi-context-config-"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("context config merges defaults, global, and project field by field", () => {
  const root = fixture();
  const cwd = join(root, "project");
  const home = join(root, "home");
  try {
    writeJson(join(home, ".pi/agent/pi-context.json"), {
      version: 1,
      pressure: { warningPercent: 30, criticalPercent: 12, hysteresisPercent: 4 },
    });
    writeJson(join(cwd, ".pi/pi-context.json"), {
      version: 1,
      pressure: { warningPercent: 28, repeatCooldownMs: 60_000 },
    });

    const result = loadEffectiveContextConfig({ cwd, homeDir: home });
    assert.deepEqual(result.config.pressure, {
      warningPercent: 28,
      criticalPercent: 12,
      hysteresisPercent: 4,
      repeatCooldownMs: 60_000,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(Object.isFrozen(result.config), true);
    assert.equal(Object.isFrozen(result.config.pressure), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid ordering falls back to safe defaults with bounded diagnostics", () => {
  const root = fixture();
  const cwd = join(root, "project");
  try {
    writeJson(join(cwd, ".pi/pi-context.json"), {
      version: 1,
      pressure: { warningPercent: 10, criticalPercent: 20, hysteresisPercent: 50 },
    });
    const result = loadEffectiveContextConfig({ cwd, homeDir: join(root, "home") });
    assert.deepEqual(result.config, DEFAULT_PI_CONTEXT_CONFIG);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid pressure threshold ordering")));
    assert.ok(result.diagnostics.length <= 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid known fields are diagnosed even when unknown fields exhaust the diagnostic budget", () => {
  const root = fixture();
  const cwd = join(root, "project");
  const home = join(root, "home");
  try {
    writeJson(join(home, ".pi/agent/pi-context.json"), {
      version: 1,
      pressure: { warningPercent: 35, criticalPercent: 12 },
    });
    writeJson(join(cwd, ".pi/pi-context.json"), {
      version: 1,
      pressure: { warningPercent: "invalid" },
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`unknown${index}`, index])),
    });

    const result = loadEffectiveContextConfig({ cwd, homeDir: home });
    assert.equal(result.config.pressure.warningPercent, 35);
    assert.equal(result.config.pressure.criticalPercent, 12);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("pressure.warningPercent")));
    assert.ok(result.diagnostics.length <= 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and future-version files are ignored without overriding valid lower precedence", () => {
  const root = fixture();
  const cwd = join(root, "project");
  const home = join(root, "home");
  try {
    writeJson(join(home, ".pi/agent/pi-context.json"), { version: 1, pressure: { warningPercent: 35 } });
    writeJson(join(cwd, ".pi/pi-context.json"), { version: 2, pressure: { warningPercent: 5 } });
    const future = loadEffectiveContextConfig({ cwd, homeDir: home });
    assert.equal(future.config.pressure.warningPercent, 35);
    assert.ok(future.diagnostics.some((diagnostic) => diagnostic.message.includes("unsupported version")));

    writeFileSync(join(cwd, ".pi/pi-context.json"), "{");
    const malformed = loadEffectiveContextConfig({ cwd, homeDir: home });
    assert.equal(malformed.config.pressure.warningPercent, 35);
    assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.message.includes("failed to parse")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
