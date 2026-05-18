import test from "node:test";
import assert from "node:assert/strict";

import { classifyBashReadonlyCommand, decideToolPolicy, matchesToolName, type ToolPolicyConfig } from "../extensions/pi-todo/src/domain/policy.ts";

const policy: ToolPolicyConfig = {
  defaultAction: "requireTodo",
  rules: [
    { pattern: "read", action: "allow" },
    { pattern: "ctx_search", action: "allow" },
    { pattern: "context_mode_ctx_search", action: "allow" },
    { pattern: "ctx_purge", action: "requireTodo" },
  ],
};

test("tool policy supports exact tool-name matches", () => {
  assert.equal(matchesToolName("read", "read"), true);
  assert.equal(matchesToolName("read", "write"), false);
  assert.deepEqual(decideToolPolicy("read", policy), { action: "allow", reason: "rule", pattern: "read" });
});

test("tool policy supports wildcard tool-name matches", () => {
  assert.equal(matchesToolName("ctx_*", "ctx_execute"), true);
  assert.equal(matchesToolName("context_mode_ctx_*", "context_mode_ctx_search"), true);
  assert.equal(matchesToolName("ctx_*", "context_mode_ctx_search"), false);
});

test("tool policy can allow safe context lookup while requiring executable context tools", () => {
  assert.deepEqual(decideToolPolicy("ctx_search", policy), { action: "allow", reason: "rule", pattern: "ctx_search" });
  assert.deepEqual(decideToolPolicy("context_mode_ctx_search", policy), { action: "allow", reason: "rule", pattern: "context_mode_ctx_search" });
  assert.deepEqual(decideToolPolicy("ctx_execute", policy), { action: "requireTodo", reason: "default" });
  assert.deepEqual(decideToolPolicy("ctx_execute_file", policy), { action: "requireTodo", reason: "default" });
  assert.deepEqual(decideToolPolicy("context_mode_ctx_execute", policy), { action: "requireTodo", reason: "default" });
  assert.deepEqual(decideToolPolicy("context_mode_ctx_execute_file", policy), { action: "requireTodo", reason: "default" });
});

test("tool policy always allows the todo tool", () => {
  assert.deepEqual(decideToolPolicy("todo", { defaultAction: "requireTodo", rules: [{ pattern: "todo", action: "requireTodo" }] }), {
    action: "allow",
    reason: "todo_tool",
    pattern: "todo",
  });
});

test("tool policy gives require-todo rules precedence over broad allow patterns", () => {
  assert.deepEqual(decideToolPolicy("ctx_purge", policy), { action: "requireTodo", reason: "rule", pattern: "ctx_purge" });
});

test("tool policy gives require-todo rules precedence over more specific allow patterns", () => {
  assert.deepEqual(
    decideToolPolicy("read", {
      defaultAction: "requireTodo",
      rules: [
        { pattern: "*", action: "requireTodo" },
        { pattern: "read", action: "allow" },
      ],
    }),
    { action: "requireTodo", reason: "rule", pattern: "*" },
  );
});

test("tool policy uses the configured default action for unknown tools", () => {
  assert.deepEqual(decideToolPolicy("write", policy), { action: "requireTodo", reason: "default" });
  assert.deepEqual(decideToolPolicy("write", { defaultAction: "allow", rules: [] }), { action: "allow", reason: "default" });
});

test("tool policy allows conservative read-only bash before generic bash gating", () => {
  const bashPolicy: ToolPolicyConfig = { defaultAction: "requireTodo", rules: [{ pattern: "bash", action: "requireTodo" }] };

  assert.deepEqual(decideToolPolicy("bash", bashPolicy, { command: "pwd && ls" }), {
    action: "allow",
    reason: "bash_readonly",
    pattern: "bashReadonlyAllowlist",
  });
  assert.deepEqual(decideToolPolicy("bash", bashPolicy, { command: "cd src && rg \"needle\" ." }), {
    action: "allow",
    reason: "bash_readonly",
    pattern: "bashReadonlyAllowlist",
  });
  assert.deepEqual(decideToolPolicy("bash", bashPolicy, { command: "find . -name '*.ts'" }), {
    action: "allow",
    reason: "bash_readonly",
    pattern: "bashReadonlyAllowlist",
  });
  assert.deepEqual(decideToolPolicy("bash", bashPolicy, { command: "git status --short" }), {
    action: "allow",
    reason: "bash_readonly",
    pattern: "bashReadonlyAllowlist",
  });
});

test("read-only bash classifier allows broad discovery, reading, exploration, and navigation commands", () => {
  const allowed = [
    "cat README.md",
    "sed -n '1,20p' extensions/pi-todo/src/domain/policy.ts",
    "jq . package.json",
    "git blame extensions/pi-todo/src/domain/policy.ts",
    "git ls-tree HEAD extensions",
    "git config --get remote.origin.url",
    "env",
    "ps aux",
    "df -h",
    "ss -ltn",
    "which node",
    "realpath .",
    "dirname extensions/pi-todo/src/domain/policy.ts",
    "sort package.json",
    "diff README.md README.md",
  ];

  for (const command of allowed) assert.equal(classifyBashReadonlyCommand(command).readonly, true, command);
});

test("read-only bash classifier rejects mutating, unknown, and shell-expansion commands", () => {
  const blocked = [
    "rm -rf tmp",
    "find . -delete",
    "rg needle > out.txt",
    "npm test",
    "git commit -m change",
    "git stash pop",
    "git worktree add ../copy",
    "sed -i 's/a/b/' file.txt",
    "sort -o sorted.txt unsorted.txt",
    "yq -i . file.yml",
    "node script.js",
    "pwd && rm out.txt",
    "ls $(pwd)",
  ];

  for (const command of blocked) assert.equal(classifyBashReadonlyCommand(command).readonly, false, command);
});

test("empty bash read-only allowlist disables bash pre-todo allowance", () => {
  assert.deepEqual(
    decideToolPolicy("bash", { defaultAction: "requireTodo", rules: [{ pattern: "bash", action: "requireTodo" }], bashReadonlyAllowlist: [] }, { command: "pwd" }),
    { action: "requireTodo", reason: "rule", pattern: "bash" },
  );
});
