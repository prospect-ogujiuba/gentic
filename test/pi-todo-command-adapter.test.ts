import assert from "node:assert/strict";
import test from "node:test";

import {
  getTodoCommandCompletions,
  renderTodoQuickHelp,
} from "../extensions/pi-todo/src/command-adapter.ts";
import type { TodoCoreState } from "../extensions/pi-todo/src/state-core.ts";

function state(activeTodoId?: string): TodoCoreState {
  return {
    order: ["parent", "child-a", "child-b", "root", "blocked", "done"],
    activeTodoId,
    todos: {
      parent: { id: "parent", title: "Parent delivery", status: "ready" },
      "child-a": { id: "child-a", title: "Active child", status: activeTodoId === "child-a" ? "in_progress" : "ready", parentTodoId: "parent" },
      "child-b": { id: "child-b", title: "Sibling task", status: "completed", parentTodoId: "parent" },
      root: { id: "root", title: "Independent root", status: "ready" },
      blocked: { id: "blocked", title: "Waiting task", status: "external_blocked", blockedReason: "waiting for credentials" },
      done: { id: "done", title: "Completed task", status: "completed" },
    },
  };
}

test("todo adapter preserves prefixes for parent, move, and legal transition candidates", () => {
  const ready = state();
  assert.deepEqual(getTodoCommandCompletions("start ch", ready).map((item) => item.value), ["start child-a"]);
  assert.deepEqual(getTodoCommandCompletions("create Nested work --parent pa", ready).map((item) => item.value), ["create Nested work --parent parent"]);
  assert.ok(!getTodoCommandCompletions("create Nested work --parent ", ready).some((item) => item.label === "done"));

  assert.deepEqual(getTodoCommandCompletions("move child-a ", ready).map((item) => item.value), [
    "move child-a before",
    "move child-a after",
  ]);
  assert.deepEqual(getTodoCommandCompletions("move child-a before ch", ready).map((item) => item.value), ["move child-a before child-b"]);
  assert.deepEqual(getTodoCommandCompletions("move child-a before root", ready), []);
});

test("todo adapter excludes invalid transitions and explains active, hierarchy, and blockers", () => {
  const active = state("child-a");
  assert.deepEqual(getTodoCommandCompletions("start ", active), []);
  assert.deepEqual(getTodoCommandCompletions("finish ", active).map((item) => item.value), ["finish child-a"]);
  assert.match(getTodoCommandCompletions("finish ", active)[0]!.description ?? "", /active · child of parent · Active child/);
  assert.deepEqual(getTodoCommandCompletions("unblock b", active).map((item) => item.value), ["unblock blocked"]);
  assert.match(getTodoCommandCompletions("unblock b", active)[0]!.description ?? "", /blocked: waiting for credentials/);
  assert.ok(!getTodoCommandCompletions("", active).some((item) => item.value === "start"));
  assert.ok(getTodoCommandCompletions("", active).some((item) => item.value === "finish"));
});

test("todo contextual help reports current state and a valid next action", () => {
  const active = state("child-a");
  const help = renderTodoQuickHelp(active);
  assert.match(help, /Active: child-a — Active child/);
  assert.match(help, /Ready: 2/);
  assert.match(help, /Blocked: 1 · blocked — waiting for credentials/);
  assert.match(help, /Next: \/todo finish child-a or \/todo block child-a <reason>/);

  assert.deepEqual(getTodoCommandCompletions("", active, false).map((item) => item.value), ["open", "list"]);
  assert.deepEqual(getTodoCommandCompletions("finish ", active, false), []);
  const owned = renderTodoQuickHelp(active, false);
  assert.match(owned, /Lifecycle owner: pi-swe/);
  assert.match(owned, /Next: \/todo list/);
  assert.doesNotMatch(owned, /Next: \/todo finish/);
});

test("todo adapter tolerates malformed references and bounds maximum state", () => {
  const malformed: TodoCoreState = {
    order: ["cycle", ...Array.from({ length: 1_005 }, (_, index) => `t-${index}`), "missing"],
    todos: {
      cycle: { id: "cycle", title: "Cycle", status: "ready", parentTodoId: "cycle" },
      ...Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [`t-${index}`, { id: `t-${index}`, title: `Todo ${index}`, status: "ready" as const }])),
    },
  };
  assert.doesNotThrow(() => getTodoCommandCompletions("start t-", malformed));
  assert.equal(getTodoCommandCompletions("start t-", malformed).length, 999);
  assert.ok(!getTodoCommandCompletions("", malformed).some((item) => item.value === "create"));
});
