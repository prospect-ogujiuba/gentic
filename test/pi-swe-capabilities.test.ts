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
    getActiveTodo: () => ({
      id: "todo-1",
      title: "Implement adapter",
      status: "in_progress",
      acceptanceCriteria: ["peer context"],
      definitionOfDone: ["tests pass"],
      canonicalInitiative: {
        topic: "demo",
        contractId: "01",
        contractPath: ".model-artifacts/plans/demo/revisions/r1/contracts/01.md",
        planRevision: 1,
        dependencies: [],
      },
    }),
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
    canonicalInitiative: {
      topic: "demo",
      contractId: "01",
      contractPath: ".model-artifacts/plans/demo/revisions/r1/contracts/01.md",
      planRevision: 1,
      dependencies: [],
    },
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

test("pi-swe capability adapter ignores malformed or async todo links with warnings", () => {
  const malformed = createSweExternalCapabilities({
    capabilities: new Map([["pi-todo", { getActiveTodo: () => ({ id: "todo-1", canonicalInitiative: { topic: "../bad" } }) }]]),
    getCommands: () => [],
    getAllTools: () => [],
  } as never);
  assert.deepEqual(malformed.getActiveTodo?.(), { id: "todo-1" });
  assert.deepEqual(malformed.getWarnings().map((warning) => warning.message), ["getActiveTodo returned malformed canonicalInitiative link; link ignored"]);

  const asyncPeer = createSweExternalCapabilities({
    capabilities: new Map([["pi-todo", { getActiveTodo: async () => ({ id: "todo-1" }) }]]),
    getCommands: () => [],
    getAllTools: () => [],
  } as never);
  assert.equal(asyncPeer.getActiveTodo?.(), undefined);
  assert.deepEqual(asyncPeer.getWarnings().map((warning) => warning.message), ["getActiveTodo returned a Promise; async capability reads are ignored"]);
});

test("pi-swe capability adapter detects peers from command and tool provenance", () => {
  const capabilities = createSweExternalCapabilities({
    getCommands: () => [{ name: "todo", sourceInfo: { path: "/repo/extensions/pi-todo/index.ts" } }],
    getAllTools: () => [{ name: "permission-system", sourceInfo: { path: "/repo/node_modules/@gotgenes/pi-permission-system/src/index.ts" } }],
  } as never);

  assert.deepEqual(capabilities.listDetectedExtensions?.(), ["pi-permission-system", "pi-todo"]);
});
