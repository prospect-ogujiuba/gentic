import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { DEFAULT_PI_TODO_CONFIG, loadEffectiveTodoConfig } from "../extensions/pi-todo/src/config.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-todo-config-"));
}

test("pi-todo effective config keeps completed docket focus by default", () => {
  const result = loadEffectiveTodoConfig({ cwd: tempDir(), homeDir: tempDir() });

  assert.deepEqual(result.config, DEFAULT_PI_TODO_CONFIG);
  assert.equal(result.config.docket.showCompletedFocus, true);
  assert.deepEqual(result.config.enforcement, DEFAULT_PI_TODO_CONFIG.enforcement);
  assert.deepEqual(result.diagnostics, []);
});

test("pi-todo effective config allows project to hide completed docket focus", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-todo.json"), JSON.stringify({ docket: { showCompletedFocus: false } }));

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.equal(result.config.docket.showCompletedFocus, false);
  assert.deepEqual(result.diagnostics, []);
});

test("pi-todo effective config lets project override global docket focus", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "pi-todo.json"), JSON.stringify({ docket: { showCompletedFocus: false } }));
  writeFileSync(join(cwd, ".pi", "pi-todo.json"), JSON.stringify({ docket: { showCompletedFocus: true } }));

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.equal(result.config.docket.showCompletedFocus, true);
});

test("pi-todo effective config accepts project enforcement allow rules", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-todo.json"),
    JSON.stringify({
      enforcement: {
        rules: [
          { pattern: "read", action: "allow" },
          { pattern: "ctx_search", action: "allow" },
          { pattern: "edit", action: "requireTodo" },
        ],
      },
    }),
  );

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.deepEqual(result.config.enforcement, {
    defaultAction: "requireTodo",
    rules: [
      { pattern: "read", action: "allow" },
      { pattern: "ctx_search", action: "allow" },
      { pattern: "edit", action: "requireTodo" },
    ],
    bashReadonlyAllowlist: DEFAULT_PI_TODO_CONFIG.enforcement.bashReadonlyAllowlist,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("pi-todo effective config accepts project bash read-only allowlist", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-todo.json"), JSON.stringify({ enforcement: { bashReadonlyAllowlist: ["pwd", "git status"] } }));

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.deepEqual(result.config.enforcement.bashReadonlyAllowlist, ["pwd", "git status"]);
  assert.deepEqual(result.diagnostics, []);
});

test("pi-todo effective config merges global and project enforcement predictably", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(homeDir, ".pi", "agent", "pi-todo.json"),
    JSON.stringify({ enforcement: { defaultAction: "allow", rules: [{ pattern: "edit", action: "requireTodo" }] } }),
  );
  writeFileSync(join(cwd, ".pi", "pi-todo.json"), JSON.stringify({ enforcement: { defaultAction: "requireTodo" } }));

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.deepEqual(result.config.enforcement, {
    defaultAction: "requireTodo",
    rules: [{ pattern: "edit", action: "requireTodo" }],
    bashReadonlyAllowlist: DEFAULT_PI_TODO_CONFIG.enforcement.bashReadonlyAllowlist,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("pi-todo effective config falls back safely for invalid docket config", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-todo.json"), JSON.stringify({ docket: { showCompletedFocus: "no" }, extra: true }));

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.equal(result.config.docket.showCompletedFocus, true);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'docket.showCompletedFocus'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("unknown pi-todo config field 'extra'")));
});

test("pi-todo effective config falls back safely for invalid enforcement config", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-todo.json"),
    JSON.stringify({
      enforcement: {
        defaultAction: "prompt",
        rules: [
          { pattern: "read", action: "allow" },
          { pattern: "edit", action: "prompt" },
          { pattern: "", action: "allow" },
          "ctx_*",
        ],
        extra: true,
      },
    }),
  );

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.deepEqual(result.config.enforcement, {
    defaultAction: "requireTodo",
    rules: [{ pattern: "read", action: "allow" }],
    bashReadonlyAllowlist: DEFAULT_PI_TODO_CONFIG.enforcement.bashReadonlyAllowlist,
  });
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enforcement.defaultAction'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("unknown enforcement field 'extra'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enforcement.rules[1].action'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enforcement.rules[2].pattern'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enforcement.rules[3]'")));
});

test("pi-todo effective config forces invalid relaxed enforcement closed", () => {
  const cwd = tempDir();
  const homeDir = tempDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-todo.json"),
    JSON.stringify({
      enforcement: {
        defaultAction: "allow",
        rules: [{ pattern: "edit", action: "require" }],
      },
    }),
  );

  const result = loadEffectiveTodoConfig({ cwd, homeDir });

  assert.deepEqual(result.config.enforcement, {
    defaultAction: "requireTodo",
    rules: [],
    bashReadonlyAllowlist: DEFAULT_PI_TODO_CONFIG.enforcement.bashReadonlyAllowlist,
  });
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid 'enforcement.rules[0].action'")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("defaultAction forced to 'requireTodo'")));
});
