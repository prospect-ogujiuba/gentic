import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelPendingGatePrompts, DEFAULT_AUDIT_PATH, decide, getConfig, getConfigDiagnostics, loadConfig, patternRegex, persistRule, promptPermission, promptPermissionOutcome } from "../extensions/pi-gate/index.ts";

function writeGateConfig(cwd: string, config: Record<string, unknown>): string {
  const path = join(cwd, ".pi/pi-gate/pi-gate.json");
  mkdirSync(join(cwd, ".pi/pi-gate"), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  return path;
}

test("pi-gate wildcard patterns treat * and ? as globs", () => {
  assert.equal(patternRegex("git status*").test("git status --short"), true);
  assert.equal(patternRegex("node*").test("node --version"), true);
  assert.equal(patternRegex("chmod -R 777*").test("chmod -R 777 --help"), true);
  assert.equal(patternRegex("git diff ?").test("git diff x"), true);
  assert.equal(patternRegex("git diff ?").test("git diff xy"), false);
});

test("pi-gate applies configured allow ask and deny permissions before default", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  writeGateConfig(cwd, {
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
  });

  loadConfig(cwd);

  assert.equal(decide({ source: "agent", command: "git status --short", cwd }).action, "allow");
  assert.equal(decide({ source: "agent", command: "node --version", cwd }).action, "ask");
  const deny = decide({ source: "agent", command: "chmod -R 777 --help", cwd });
  assert.equal(deny.action, "deny");
  assert.match(deny.ruleId, /^config:deny:/);
});

test("pi-gate deny permissions override ask and allow matches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  writeGateConfig(cwd, {
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
  });

  loadConfig(cwd);

  const decision = decide({ source: "agent", command: "chmod -R 777 --help", cwd });
  assert.equal(decision.action, "deny");
  assert.match(decision.ruleId, /^config:deny:/);
});

test("pi-gate built-in deny beats configured ask and allow matches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  writeGateConfig(cwd, {
    version: 2,
    enabled: true,
    mode: "ask",
    defaultAction: "ask",
    audit: { enabled: false },
    permissions: {
      allow: ["rm *"],
      ask: ["rm foo*"],
    }
  });

  loadConfig(cwd);

  const decision = decide({ source: "agent", command: "rm foo -rf /", cwd });
  assert.equal(decision.action, "deny");
  assert.match(decision.ruleId, /^builtin:deny:/);
});

test("pi-gate config deny beats built-in allow", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  writeGateConfig(cwd, {
    version: 2,
    enabled: true,
    mode: "ask",
    defaultAction: "ask",
    audit: { enabled: false },
    permissions: { deny: ["git status secret*"] }
  });

  loadConfig(cwd);

  const decision = decide({ source: "agent", command: "git status secret-token", cwd });
  assert.equal(decision.action, "deny");
  assert.match(decision.ruleId, /^config:deny:/);
});

test("pi-gate strict and disabled modes short-circuit while permissive still enforces deny", () => {
  const strictCwd = mkdtempSync(join(tmpdir(), "pi-gate-strict-"));
  writeGateConfig(strictCwd, { version: 2, enabled: true, mode: "strict", audit: { enabled: false }, permissions: { allow: ["pwd"] } });
  loadConfig(strictCwd);
  assert.equal(decide({ source: "agent", command: "pwd", cwd: strictCwd }).action, "deny");

  const permissiveCwd = mkdtempSync(join(tmpdir(), "pi-gate-permissive-"));
  writeGateConfig(permissiveCwd, { version: 2, enabled: true, mode: "permissive", audit: { enabled: false }, permissions: { deny: ["pwd"] } });
  loadConfig(permissiveCwd);
  assert.equal(decide({ source: "agent", command: "pwd", cwd: permissiveCwd }).action, "deny");

  const disabledCwd = mkdtempSync(join(tmpdir(), "pi-gate-disabled-"));
  writeGateConfig(disabledCwd, { version: 2, enabled: false, mode: "ask", audit: { enabled: false }, permissions: { deny: ["pwd"] } });
  loadConfig(disabledCwd);
  assert.equal(decide({ source: "agent", command: "pwd", cwd: disabledCwd }).action, "allow");
});

test("pi-gate project persistence does not duplicate rules", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  const path = writeGateConfig(cwd, { version: 2, permissions: { allow: [] } });
  const ctx = { cwd, ui: { notify() {} } } as any;

  persistRule(ctx, path, "echo once*", "allow");
  persistRule(ctx, path, "echo once*", "allow");

  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved.literalPermissions.allow, ["echo once*"]);

  loadConfig(cwd);
  assert.equal(decide({ source: "agent", command: "echo once*", cwd }).action, "allow");
  assert.notEqual(decide({ source: "agent", command: "echo once anything", cwd }).action, "allow");
});

test("pi-gate migrates legacy root audit path to pi-gate state directory", () => {
  const originalHome = process.env.HOME;
  const originalOverride = process.env.PI_GATE_CONFIG;
  const home = mkdtempSync(join(tmpdir(), "pi-gate-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-project-"));
  delete process.env.PI_GATE_CONFIG;
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi/pi-gate"), { recursive: true });
    writeFileSync(join(home, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
      version: 2,
      audit: { enabled: true, path: ".pi/pi-gate-audit.jsonl" },
    }));

    loadConfig(cwd);

    assert.equal(getConfig().audit.path, DEFAULT_AUDIT_PATH);
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.PI_GATE_CONFIG; else process.env.PI_GATE_CONFIG = originalOverride;
  }
});

test("pi-gate rewrites remembered rules with canonical audit path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-"));
  const path = writeGateConfig(cwd, { version: 2, audit: { enabled: true, path: ".pi/pi-gate-audit.jsonl" }, permissions: { allow: [] } });
  const ctx = { cwd, ui: { notify() {} } } as any;

  persistRule(ctx, path, "echo canonical*", "allow");

  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.audit.path, DEFAULT_AUDIT_PATH);
});

test("pi-gate no-UI prompt falls back safely", async () => {
  const req = { source: "agent", command: "sudo true", cwd: process.cwd() } as const;
  for (const mode of ["json", "print"] as const) {
    let uiCalls = 0;
    const ctx = { mode, hasUI: false, ui: { select() { uiCalls += 1; } } } as any;
    assert.deepEqual(await promptPermissionOutcome(ctx, req, { action: "ask", ruleId: "x", reason: "test" }), { action: "deny", outcome: "unavailable", remember: false, error: undefined });
    assert.equal(await promptPermission(ctx, req, { action: "ask", ruleId: "x", reason: "test" }), "deny");
    assert.equal(uiCalls, 0);
  }
});

test("pi-gate TUI and RPC prompt matrix resolves allow, deny, cancel, timeout, and error safely", async () => {
  const req = { source: "agent", command: "sudo true", cwd: process.cwd() } as const;
  const decision = { action: "ask", ruleId: "x", reason: "test" } as const;
  for (const mode of ["tui", "rpc"] as const) {
    for (const scenario of ["allow", "deny", "cancel", "timeout", "error"] as const) {
      let customCalls = 0;
      const ctx = {
        mode,
        hasUI: true,
        ui: {
          custom() { customCalls += 1; },
          async select(_title: string, labels: string[], options: { signal?: AbortSignal }) {
            if (scenario === "allow") return labels[0];
            if (scenario === "deny") return labels.at(-1);
            if (scenario === "cancel") return undefined;
            if (scenario === "error") throw new Error("dialog failed");
            return new Promise<string | undefined>((resolve) => options.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
          },
        },
      } as any;
      const result = await promptPermissionOutcome(ctx, req, decision, { timeoutMs: 5 });
      assert.equal(result.action, scenario === "allow" ? "allow" : "deny", `${mode}:${scenario}`);
      assert.equal(result.outcome, scenario, `${mode}:${scenario}`);
      assert.equal(customCalls, 0);
    }
  }
});

test("pi-gate lifecycle cancellation closes a pending prompt with deny", async () => {
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      select(_title: string, _labels: string[], options: { signal?: AbortSignal }) {
        return new Promise<undefined>((resolve) => options.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
      },
    },
  } as any;
  const pending = promptPermissionOutcome(ctx, { source: "agent", command: "sudo true", cwd: process.cwd() }, { action: "ask", ruleId: "x", reason: "test" }, { timeoutMs: 10_000 });
  cancelPendingGatePrompts();
  const result = await pending;
  assert.equal(result.action, "deny");
  assert.equal(result.outcome, "cancel");
});

test("pi-gate broad allows cannot authorize compound shell syntax", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-adversarial-"));
  writeGateConfig(cwd, { version: 3, enabled: true, mode: "permissive", audit: { enabled: false }, permissions: { allow: ["ls*"] } });
  loadConfig(cwd);
  for (const command of ["ls; rm -rf /tmp/x", "ls && whoami", "ls | sh", "ls > /tmp/x", "ls $(whoami)", "ls\nwhoami"]) {
    assert.notEqual(decide({ source: "agent", command, cwd }).action, "allow", command);
  }
});

test("pi-gate detects reordered and long destructive rm flags", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-rm-"));
  writeGateConfig(cwd, { version: 3, enabled: true, mode: "permissive", audit: { enabled: false } });
  loadConfig(cwd);
  for (const command of ["rm -fr /", "rm --force --recursive /", "command rm -r -f $HOME", "sudo rm -rf ~"]) {
    assert.equal(decide({ source: "agent", command, cwd }).action, "deny", command);
  }
});

test("pi-gate invalid reload retains last-known-good policy", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-lkg-"));
  const path = writeGateConfig(cwd, { version: 3, enabled: true, mode: "ask", audit: { enabled: false }, permissions: { deny: ["secret*"] } });
  loadConfig(cwd);
  assert.equal(decide({ source: "agent", command: "secret value", cwd }).action, "deny");
  writeFileSync(path, JSON.stringify({ version: 999, mode: "broken" }));
  loadConfig(cwd);
  assert.ok(getConfigDiagnostics().length > 0);
  assert.equal(decide({ source: "agent", command: "secret value", cwd }).action, "deny");
});

test("pi-gate can exclude untrusted project policy", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-untrusted-"));
  writeGateConfig(cwd, { version: 3, permissions: { allow: ["project-only*"] } });
  loadConfig(cwd, { includeProject: false });
  const decision = decide({ source: "agent", command: "project-only command", cwd });
  assert.notEqual(decision.ruleId, "config:allow:project-only*");
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
    writeGateConfig(cwd, {
      version: 2,
      permissions: { deny: ["echo global secret*"] }
    });
    writeFileSync(join(home, ".pi/pi-gate/pi-gate.json"), JSON.stringify({
      version: 2,
      enabled: true,
      mode: "ask",
      defaultAction: "ask",
      audit: { enabled: false },
      permissions: { allow: ["echo global*"] }
    }));

    loadConfig(cwd);

    assert.equal(decide({ source: "agent", command: "echo global ok", cwd }).action, "allow");
    assert.equal(decide({ source: "agent", command: "echo global secret token", cwd }).action, "deny");
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.PI_GATE_CONFIG; else process.env.PI_GATE_CONFIG = originalOverride;
  }
});
