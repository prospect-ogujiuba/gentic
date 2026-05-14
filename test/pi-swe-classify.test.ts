import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyToolCall, classifyToolResult } from "../extensions/pi-swe/src/domain/classify.ts";

test("pi-swe classifiers detect file inspection calls", () => {
  assert.deepEqual(classifyToolCall({ toolName: "read", args: { path: "./src/../src/a.ts" } }), [{ kind: "inspection", toolName: "read", path: "src/a.ts" }]);
  assert.deepEqual(classifyToolCall({ toolName: "ctx_execute_file", args: { path: "test/pi-swe.test.ts" } }), [{ kind: "inspection", toolName: "ctx_execute_file", path: "test/pi-swe.test.ts" }]);
  assert.deepEqual(classifyToolCall({ toolName: "bash", args: { command: "rg classify extensions/pi-swe/src/classify.ts" } }), [{ kind: "inspection", toolName: "bash", path: "extensions/pi-swe/src/classify.ts" }]);
});

test("pi-swe classifiers reject broad scans as per-file inspection", () => {
  assert.deepEqual(classifyToolCall({ toolName: "bash", args: { command: "rg classify ." } }), []);
  assert.deepEqual(classifyToolCall({ toolName: "bash", args: { command: "rg --files" } }), []);
  assert.deepEqual(classifyToolCall({ toolName: "unknown", args: { path: "src/a.ts" } }), []);
});

test("pi-swe classifiers detect code changes and write mode when visible", () => {
  assert.deepEqual(classifyToolCall({ toolName: "edit", args: { path: "src/a.ts" } }), [{ kind: "code_change", toolName: "edit", path: "src/a.ts", writeMode: "existing" }]);
  assert.deepEqual(classifyToolCall({ toolName: "write", args: { path: "src/new.ts", existed: false } }), [{ kind: "code_change", toolName: "write", path: "src/new.ts", writeMode: "new" }]);
  assert.deepEqual(classifyToolCall({ toolName: "write", args: { path: "src/existing.ts", alreadyExists: true } }), [{ kind: "code_change", toolName: "write", path: "src/existing.ts", writeMode: "existing" }]);
});

test("pi-swe classifiers detect broad format or fix commands without inventing paths", () => {
  assert.deepEqual(classifyToolCall({ toolName: "bash", args: { command: "npm run format" } }), [{ kind: "code_change", toolName: "bash", broad: true, command: "npm run format" }]);
  assert.deepEqual(classifyToolCall({ toolName: "bash", args: { command: "eslint . --fix" } }), [{ kind: "code_change", toolName: "bash", broad: true, command: "eslint . --fix" }]);
});

test("pi-swe classifiers detect verification results with exit codes and scope", () => {
  assert.deepEqual(classifyToolResult({ toolName: "bash", args: { command: "node --test test/pi-swe-classify.test.ts" }, result: { exitCode: 0 } }), [
    { kind: "verification", toolName: "bash", command: "node --test test/pi-swe-classify.test.ts", exitCode: 0, scope: "focused" },
  ]);
  assert.deepEqual(classifyToolResult({ toolName: "ctx_execute", args: { command: "npm test" }, result: { status: 1 } }), [
    { kind: "verification", toolName: "ctx_execute", command: "npm test", exitCode: 1, scope: "broad" },
  ]);
});

test("pi-swe classifiers detect visible todo completion attempts only", () => {
  assert.deepEqual(classifyToolCall({ toolName: "todo", args: { action: "complete", todoId: "todo-1" } }), [{ kind: "todo_completion_attempt", toolName: "todo", todoId: "todo-1" }]);
  assert.deepEqual(classifyToolCall({ toolName: "todo", args: { action: "start", todoId: "todo-1" } }), []);
});

test("pi-swe classifiers are pure and safely ignore ambiguous shapes", () => {
  const payload = { toolName: "bash", args: { command: "echo npm test" }, result: { exitCode: 0 } };
  assert.deepEqual(classifyToolCall(payload), []);
  assert.deepEqual(payload, { toolName: "bash", args: { command: "echo npm test" }, result: { exitCode: 0 } });
  assert.deepEqual(classifyToolResult({ toolName: "bash", args: { command: "echo ok" }, result: { exitCode: 0 } }), []);
});
