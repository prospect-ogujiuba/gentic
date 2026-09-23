import test from "node:test";
import assert from "node:assert/strict";

import {
  TODO_EXCLUDED_CAPABILITIES,
  TODO_PUBLIC_ACTIONS,
  isTodoPublicAction,
} from "../extensions/pi-swe/src/todo/contract.ts";

test("lightweight todo contract exposes only essential focus-list actions", () => {
  assert.deepEqual(TODO_PUBLIC_ACTIONS, [
    "create",
    "move",
    "delete",
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

test("todo contract is provider-neutral and contains no peer-extension ownership bridge", () => {
  assert.equal("decideTodoOwnership" in Object.create(null), false);
});
