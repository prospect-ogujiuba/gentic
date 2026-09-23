import assert from "node:assert/strict";
import test from "node:test";

import {
  prefixedCompletions,
  renderActionHelp,
  renderUsage,
  rootActionCompletions,
  type CommandActionSpec,
} from "../src/command-guidance.ts";

const actions = [
  { action: "list", syntax: "/example list", description: "List values" },
  { action: "start", syntax: "/example start <id>", description: "Start a value", help: "Start one ready value" },
] as const satisfies readonly CommandActionSpec[];

test("command guidance filters described roots without parsing domain arguments", () => {
  assert.deepEqual(rootActionCompletions("st", actions), [{
    value: "start",
    label: "start",
    description: "Start a value · /example start <id>",
  }]);
  assert.deepEqual(rootActionCompletions("start ", actions), []);
});

test("command guidance preserves nested prefixes and renders authoritative metadata", () => {
  assert.deepEqual(prefixedCompletions("start project ", [{ value: "W-1", label: "W-1", description: "ready" }]), [{
    value: "start project W-1",
    label: "W-1",
    description: "ready",
  }]);
  assert.deepEqual(renderActionHelp(actions), [
    "/example list        List values",
    "/example start <id>  Start one ready value",
  ]);
  assert.equal(renderUsage(actions, ["start"]), "Usage: /example start <id>");
});
