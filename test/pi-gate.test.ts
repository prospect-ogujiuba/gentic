import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelPendingGatePrompts, clearSessionDecisions, DEFAULT_AUDIT_PATH, decide, gate, getConfig, getConfigDiagnostics, globalConfigPath, loadConfig, patternRegex, persistRule, projectConfigPathForCwd, promptPermission, promptPermissionOutcome, registerPiGate, rememberSessionDecision } from "../extensions/pi-gate/index.ts";

function writeGateConfig(cwd: string, config: Record<string, unknown>): string {
  const path = join(cwd, ".pi/pi-gate/pi-gate.json");
  mkdirSync(join(cwd, ".pi/pi-gate"), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const originalHome = process.env.HOME;
const originalOverride = process.env.PI_GATE_CONFIG;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

test.beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "pi-gate-test-home-"));
  delete process.env.PI_GATE_CONFIG;
  delete process.env.PI_CODING_AGENT_DIR;
});

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalOverride === undefined) delete process.env.PI_GATE_CONFIG; else process.env.PI_GATE_CONFIG = originalOverride;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

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

test("pi-gate blocks outside-project tool paths by default and permits them when configured", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  registerPiGate({
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    registerCommand() {},
  } as any);
  const toolCall = handlers.get("tool_call")!;
  const outsidePath = join(tmpdir(), "outside-project.txt");

  const blockedCwd = mkdtempSync(join(tmpdir(), "pi-gate-path-blocked-"));
  loadConfig(blockedCwd);
  const blocked = await toolCall({ type: "tool_call", toolName: "read", input: { path: outsidePath } }, { cwd: blockedCwd });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason, /path outside project root/);

  const allowedCwd = mkdtempSync(join(tmpdir(), "pi-gate-path-allowed-"));
  writeGateConfig(allowedCwd, { version: 3, allowOutsideProject: true });
  loadConfig(allowedCwd);
  assert.equal(await toolCall({ type: "tool_call", toolName: "read", input: { path: outsidePath } }, { cwd: allowedCwd }), undefined);
  const protectedResult = await toolCall({ type: "tool_call", toolName: "write", input: { path: join(allowedCwd, ".env") } }, { cwd: allowedCwd });
  assert.equal(protectedResult?.block, true);
  assert.match(protectedResult?.reason, /protected write path/);
});

test("pi-gate rejects non-boolean allowOutsideProject config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-invalid-path-policy-"));
  writeGateConfig(cwd, { version: 3, allowOutsideProject: "yes" });
  loadConfig(cwd);
  assert.ok(getConfigDiagnostics().some((message) => message.includes("allowOutsideProject must be boolean")));
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

test("pi-gate resolves explicit and Pi global config directory overrides", () => {
  const explicit = join(tmpdir(), "pi-gate-explicit.json");
  process.env.PI_GATE_CONFIG = explicit;
  assert.equal(globalConfigPath(), explicit);

  delete process.env.PI_GATE_CONFIG;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-gate-agent-dir-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  assert.equal(globalConfigPath(), join(agentDir, "pi-gate/pi-gate.json"));
});

test("pi-gate writes remembered global rules to configured override targets", async () => {
  for (const override of ["explicit", "agent-dir"] as const) {
    delete process.env.PI_GATE_CONFIG;
    delete process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), `pi-gate-${override}-write-`));
    const target = override === "explicit"
      ? join(mkdtempSync(join(tmpdir(), "pi-gate-explicit-dir-")), "custom.json")
      : join(mkdtempSync(join(tmpdir(), "pi-gate-agent-dir-")), "pi-gate/pi-gate.json");
    if (override === "explicit") process.env.PI_GATE_CONFIG = target;
    else process.env.PI_CODING_AGENT_DIR = target.slice(0, -"/pi-gate/pi-gate.json".length);
    const command = `echo ${override} override`;
    const ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select(_title: string, labels: string[]) { return labels.find((label) => label.includes("globally")); },
        notify() {},
      },
    } as any;

    const result = await promptPermissionOutcome(ctx, { source: "agent", command, cwd }, { action: "ask", ruleId: "x", reason: "test" });

    assert.equal(result.remember, "global");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).literalPermissions.allow, [command]);
    assert.equal(existsSync(join(process.env.HOME!, ".pi/pi-gate/pi-gate.json")), false);
    assert.equal(existsSync(projectConfigPathForCwd(cwd)), false);
  }
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

test("pi-gate prompt persists global and project selections only to their selected scopes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-scope-"));
  const notices: string[] = [];
  let selection = "allow and remember globally";
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      select(_title: string, labels: string[]) {
        assert.ok(labels.includes(selection));
        assert.ok(labels.every((label) => !/^[ysgpn] — /.test(label)));
        return selection;
      },
      notify(message: string) { notices.push(message); },
    },
  } as any;
  const decision = { action: "ask", ruleId: "x", reason: "test" } as const;

  const globalCommand = "echo remember global";
  const globalResult = await promptPermissionOutcome(ctx, { source: "agent", command: globalCommand, cwd }, decision);
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPathForCwd(cwd);
  assert.equal(globalResult.remember, "global");
  assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")).literalPermissions.allow, [globalCommand]);
  assert.equal(existsSync(projectPath), false);
  assert.ok(notices.at(-1)?.includes(globalPath));

  selection = "allow and remember for this project";
  const projectCommand = "echo remember project";
  const projectResult = await promptPermissionOutcome(ctx, { source: "agent", command: projectCommand, cwd }, decision);
  assert.equal(projectResult.remember, "project");
  assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).literalPermissions.allow, [projectCommand]);
  assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")).literalPermissions.allow, [globalCommand]);
  assert.ok(notices.at(-1)?.includes(projectPath));
});

test("pi-gate audit records prompt scope and surfaces persistence errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-audit-prompt-"));
  writeGateConfig(cwd, { version: 3, audit: { enabled: true, path: DEFAULT_AUDIT_PATH } });
  loadConfig(cwd);
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      select(_title: string, labels: string[]) { return labels.find((label) => label.includes("globally")); },
      notify() {},
      setStatus() {},
    },
  } as any;

  assert.equal((await gate(ctx, { source: "agent", command: "sudo echo audited", cwd })).block, false);
  const auditPath = join(cwd, DEFAULT_AUDIT_PATH);
  const first = JSON.parse(readFileSync(auditPath, "utf8").trim());
  assert.deepEqual(first.prompt, { outcome: "allow", remember: "global" });

  const sensitiveCommand = "sudo echo token=secret";
  ctx.ui.select = () => { throw new Error(`dialog failed for ${sensitiveCommand}`); };
  const denied = await gate(ctx, { source: "agent", command: sensitiveCommand, cwd });
  assert.equal(denied.block, true);
  assert.equal(denied.reason?.includes("secret"), false);
  assert.equal(denied.reason?.includes(sensitiveCommand), false);
  const lastLine = readFileSync(auditPath, "utf8").trim().split("\n").at(-1)!;
  assert.equal(lastLine.includes("secret"), false);
  assert.equal(lastLine.includes(sensitiveCommand), false);
  const last = JSON.parse(lastLine);
  assert.deepEqual(last.prompt, { outcome: "error", remember: false, error: "prompt operation failed" });
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

test("pi-gate exact remembered permissions authorize compound shell commands", () => {
  const command = "pwd; find . -maxdepth 3 -type f | head -20";
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-exact-compound-"));
  writeGateConfig(cwd, { version: 3, mode: "permissive", literalPermissions: { allow: [command] } });
  loadConfig(cwd);
  assert.equal(decide({ source: "agent", command, cwd }).action, "allow");

  const sessionCommand = "command -v fzf || command -v gum";
  rememberSessionDecision(sessionCommand, "allow");
  assert.equal(decide({ source: "agent", command: sessionCommand, cwd }).action, "allow");
  clearSessionDecisions();
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

test("pi-gate global persistence keeps untrusted project policy excluded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gate-untrusted-persist-"));
  writeGateConfig(cwd, { version: 3, enabled: false, mode: "permissive", permissions: { allow: ["project-only*"] } });
  loadConfig(cwd, { includeProject: false });
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    ui: {
      select(_title: string, labels: string[]) { return labels.find((label) => label.includes("globally")); },
      notify() {},
    },
  } as any;

  const result = await promptPermissionOutcome(ctx, { source: "agent", command: "echo remember safely", cwd }, { action: "ask", ruleId: "x", reason: "test" });

  assert.equal(result.remember, "global");
  assert.equal(getConfig().enabled, true);
  assert.notEqual(decide({ source: "agent", command: "project-only command", cwd }).ruleId, "config:allow:project-only*");
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
