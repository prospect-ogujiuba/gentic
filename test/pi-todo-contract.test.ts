import test from "node:test";
import assert from "node:assert/strict";

import {
  TODO_EXCLUDED_CAPABILITIES,
  TODO_PUBLIC_ACTIONS,
  decideTodoOwnership,
  isTodoPublicAction,
} from "../extensions/pi-todo/src/contract.ts";

test("lightweight todo contract exposes only essential focus-list actions", () => {
  assert.deepEqual(TODO_PUBLIC_ACTIONS, [
    "create",
    "start",
    "finish",
    "block",
    "unblock",
    "list",
  ]);

  for (const legacyAction of [
    "next",
    "begin",
    "claim",
    "renew",
    "release",
    "split",
    "create_artifact",
    "note_artifact",
    "record_artifact",
    "graph",
    "history",
    "open",
  ]) {
    assert.equal(isTodoPublicAction(legacyAction), false, legacyAction);
  }
});

test("lightweight todo contract explicitly excludes legacy orchestration and UI", () => {
  assert.deepEqual(TODO_EXCLUDED_CAPABILITIES, [
    "dependency-scheduling",
    "leases-and-claims",
    "splitting",
    "artifact-writing",
    "startup-filesystem-scans",
    "autonomous-follow-up",
  ]);
});

test("pi-swe ownership precedence is deterministic for every public action", () => {
  for (const action of TODO_PUBLIC_ACTIONS) {
    assert.deepEqual(decideTodoOwnership(action, false), {
      lifecycleOwner: "pi-todo",
      allowed: true,
    });
    assert.deepEqual(decideTodoOwnership(action, true), {
      lifecycleOwner: "pi-swe",
      allowed: action === "list",
    });
  }
});
