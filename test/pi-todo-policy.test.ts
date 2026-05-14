import test from "node:test";
import assert from "node:assert/strict";

import { decideToolPolicy, matchesToolName, type ToolPolicyConfig } from "../extensions/pi-todo/src/domain/policy.ts";

const policy: ToolPolicyConfig = {
  defaultAction: "requireTodo",
  rules: [
    { pattern: "read", action: "allow" },
    { pattern: "ctx_*", action: "allow" },
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
  assert.deepEqual(decideToolPolicy("ctx_execute", policy), { action: "allow", reason: "rule", pattern: "ctx_*" });
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
