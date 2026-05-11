import assert from "node:assert/strict";
import { test } from "node:test";

import { createSweExternalCapabilities } from "../extensions/pi-swe/src/capabilities.ts";

test("pi-swe capability adapter treats absent peers as normal", () => {
  const capabilities = createSweExternalCapabilities({ getCommands: () => [], getAllTools: () => [] } as never);

  assert.deepEqual(capabilities.listDetectedExtensions?.(), []);
  assert.equal(capabilities.getActiveTodo?.(), undefined);
  assert.equal(capabilities.getTodoScope?.(), undefined);
  assert.deepEqual(capabilities.getTodoEvidence?.(), []);
  assert.deepEqual(capabilities.getWarnings(), []);
});

test("pi-swe capability adapter reads valid todo peer context", () => {
  const provider = {
    getActiveTodo: () => ({ id: "todo-1", title: "Implement adapter", status: "in_progress", acceptanceCriteria: ["peer context"], definitionOfDone: ["tests pass"] }),
    getTodoScope: () => ({ files: ["extensions/pi-swe/index.ts"], component: "pi-swe" }),
    getTodoEvidence: () => [{ type: "command", command: "npm test", exitCode: 0 }],
  };
  const capabilities = createSweExternalCapabilities({ capabilities: new Map([["pi-todo", provider]]), getCommands: () => [], getAllTools: () => [] } as never);

  assert.deepEqual(capabilities.getActiveTodo?.(), {
    id: "todo-1",
    title: "Implement adapter",
    status: "in_progress",
    acceptanceCriteria: ["peer context"],
    definitionOfDone: ["tests pass"],
  });
  assert.deepEqual(capabilities.getTodoScope?.(), { files: ["extensions/pi-swe/index.ts"], component: "pi-swe" });
  assert.deepEqual(capabilities.getTodoEvidence?.(), [{ type: "command", command: "npm test", exitCode: 0 }]);
  assert.deepEqual(capabilities.listDetectedExtensions?.(), ["pi-todo"]);
  assert.deepEqual(capabilities.getWarnings(), []);
});

test("pi-swe capability adapter reports malformed peer responses as warnings", () => {
  const provider = {
    getActiveTodo: () => "not-a-todo",
    getTodoScope: () => ["not", "a", "scope"],
    getTodoEvidence: () => ({ type: "command" }),
  };
  const capabilities = createSweExternalCapabilities({ capabilities: new Map([["pi-todo", provider]]), getCommands: () => [], getAllTools: () => [] } as never);

  assert.equal(capabilities.getActiveTodo?.(), undefined);
  assert.equal(capabilities.getTodoScope?.(), undefined);
  assert.deepEqual(capabilities.getTodoEvidence?.(), []);
  assert.deepEqual(
    capabilities.getWarnings().map((warning) => warning.message),
    ["getActiveTodo returned malformed data", "getTodoScope returned malformed data", "getTodoEvidence returned malformed data"],
  );
});

test("pi-swe capability adapter detects peers from command and tool provenance", () => {
  const capabilities = createSweExternalCapabilities({
    getCommands: () => [{ name: "todo", sourceInfo: { path: "/repo/extensions/pi-todo/index.ts" } }],
    getAllTools: () => [{ name: "gate", sourceInfo: { path: "/repo/extensions/pi-gate/index.ts" } }],
  } as never);

  assert.deepEqual(capabilities.listDetectedExtensions?.(), ["pi-gate", "pi-todo"]);
});
