import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BranchTodoCore,
  TodoCoreError,
  type TodoBranchEntry,
} from "../extensions/pi-todo/src/state-core.ts";

function harness(initial: TodoBranchEntry[] = []) {
  const branch = structuredClone(initial);
  let branchReads = 0;
  let sequence = 0;
  const core = new BranchTodoCore({
    getBranch: () => { branchReads += 1; return branch; },
    appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
    now: () => "2026-09-14T00:00:00.000Z",
    createId: (prefix) => `${prefix}-${++sequence}`,
  });
  return { branch, core, branchReads: () => branchReads };
}

test("branch core reconstructs current state from only the active branch", () => {
  const h = harness();
  const created = h.core.create("Branch task");
  h.core.start(created.id);
  const activeBranch = structuredClone(h.branch);
  h.core.finish(created.id, "future completion");
  assert.equal(h.core.state().todos[created.id].status, "completed");

  h.branch.splice(0, h.branch.length, ...activeBranch);
  const reconstructed = h.core.state();
  assert.equal(reconstructed.todos[created.id].status, "in_progress");
  assert.equal(reconstructed.activeTodoId, created.id);
});

test("branch core enforces one active todo during mutation and reconstruction", () => {
  const h = harness();
  const first = h.core.create("First");
  const second = h.core.create("Second");
  h.core.start(first.id);
  assert.throws(
    () => h.core.start(second.id),
    (error) => error instanceof TodoCoreError && error.code === "ACTIVE_TODO_EXISTS",
  );

  const secondStart = {
    version: 1,
    event: { id: "manual-start", type: "todo.started", at: "2026-09-14T00:00:01.000Z", todoId: second.id },
  };
  h.branch.push({ type: "custom", customType: "gentic.todo.event", data: secondStart });
  const reconstructed = h.core.state();
  assert.equal(reconstructed.activeTodoId, second.id);
  assert.equal(reconstructed.todos[first.id].status, "ready");
  assert.equal(reconstructed.todos[second.id].status, "in_progress");
  assert.equal(Object.values(reconstructed.todos).filter((todo) => todo.status === "in_progress").length, 1);
});

test("subtasks reconstruct as a tree, reorder among siblings, and gate parent completion", () => {
  const h = harness();
  const parent = h.core.create("Parent");
  const first = h.core.create("First child", parent.id);
  const second = h.core.create("Second child", parent.id);
  const grandchild = h.core.create("Grandchild", first.id);

  h.core.move(second.id, first.id);
  let state = h.core.state();
  assert.equal(state.todos[first.id].parentTodoId, parent.id);
  assert.equal(state.todos[grandchild.id].parentTodoId, first.id);
  assert.ok(state.order.indexOf(second.id) < state.order.indexOf(first.id));
  assert.throws(() => h.core.move(grandchild.id, undefined, second.id), (error) =>
    error instanceof TodoCoreError && error.code === "INVALID_TRANSITION");

  h.core.start(parent.id);
  assert.throws(() => h.core.finish(parent.id), /3 open subtasks/);
  h.core.block(parent.id, "working through children");
  for (const todo of [second, grandchild, first]) {
    h.core.start(todo.id);
    h.core.finish(todo.id);
  }
  h.core.unblock(parent.id);
  h.core.start(parent.id);
  h.core.finish(parent.id);
  state = h.core.state();
  assert.equal(state.todos[parent.id].status, "completed");
  assert.equal(state.todos[first.id].status, "completed");
  assert.throws(() => h.core.create("Too late", parent.id), /completed todo/);

  const moved = h.branch.findLast((entry) => (entry.data as { event?: { type?: string } })?.event?.type === "todo.moved");
  assert.ok(moved);
});

test("delete removes a leaf or complete parent subtree and clears active descendants", () => {
  const h = harness();
  const unrelated = h.core.create("Unrelated");
  const parent = h.core.create("Parent");
  const first = h.core.create("First child", parent.id);
  const second = h.core.create("Second child", parent.id);
  const grandchild = h.core.create("Grandchild", first.id);

  const leafDeletion = h.core.delete(second.id);
  assert.equal(leafDeletion.todo.id, second.id);
  assert.equal(leafDeletion.deletedCount, 1);
  let state = h.core.state();
  assert.equal(state.todos[second.id], undefined);
  assert.deepEqual(state.order, [unrelated.id, parent.id, first.id, grandchild.id]);

  h.core.start(grandchild.id);
  const branchLength = h.branch.length;
  const subtreeDeletion = h.core.delete(parent.id);
  assert.equal(subtreeDeletion.todo.id, parent.id);
  assert.equal(subtreeDeletion.deletedCount, 3);
  assert.equal(h.branch.length, branchLength + 1);
  assert.equal((h.branch.at(-1)?.data as { event?: { type?: string } })?.event?.type, "todo.deleted");

  state = h.core.state();
  assert.deepEqual(state.order, [unrelated.id]);
  assert.deepEqual(Object.keys(state.todos), [unrelated.id]);
  assert.equal(state.activeTodoId, undefined);
});

test("delete replay ignores later lifecycle events and permits explicit recreation", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const event = (id: string, value: Record<string, unknown>): TodoBranchEntry => ({
    type: "custom",
    customType: "gentic.todo.event",
    data: { version: 1, event: { id, at, ...value } },
  });
  const h = harness([
    event("create", { type: "todo.created", todo: { id: "target", title: "Target", status: "ready" } }),
    event("delete", { type: "todo.deleted", todoId: "target" }),
    event("late-start", { type: "todo.started", todoId: "target" }),
  ]);
  assert.deepEqual(h.core.state(), { todos: {}, order: [], activeTodoId: undefined });

  h.branch.push(event("recreate", { type: "todo.created", todo: { id: "target", title: "Recreated", status: "ready" } }));
  assert.equal(h.core.state().todos.target.title, "Recreated");
  assert.throws(() => h.core.delete("missing"), (error) =>
    error instanceof TodoCoreError && error.code === "TODO_NOT_FOUND");
});

test("replay preserves the parent completion invariant across rollback-era events", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const event = (id: string, value: Record<string, unknown>): TodoBranchEntry => ({
    type: "custom",
    customType: "gentic.todo.event",
    data: { version: 1, event: { id, at, ...value } },
  });
  const h = harness([
    event("create-parent", { type: "todo.created", todo: { id: "parent", title: "Parent", status: "ready" } }),
    event("create-child", { type: "todo.created", todo: { id: "child", title: "Child", status: "ready", parentTodoId: "parent" } }),
    event("old-reader-completion", { type: "todo.completed", todoId: "parent" }),
    event("create-completed-parent", { type: "todo.created", todo: { id: "done-parent", title: "Done parent", status: "completed" } }),
    event("late-child", { type: "todo.created", todo: { id: "late-child", title: "Late child", status: "ready", parentTodoId: "done-parent" } }),
    event("forward-child", { type: "todo.created", todo: { id: "forward-child", title: "Forward child", status: "ready", parentTodoId: "future-parent" } }),
    event("future-parent", { type: "todo.created", todo: { id: "future-parent", title: "Future parent", status: "completed" } }),
  ]);

  const state = h.core.state();
  assert.equal(state.todos.parent.status, "ready");
  assert.equal(state.todos.child.parentTodoId, "parent");
  assert.equal(state.todos["done-parent"].status, "completed");
  assert.equal(state.todos["late-child"].parentTodoId, undefined);
  assert.equal(state.todos["future-parent"].status, "ready");
  assert.equal(state.todos["forward-child"].parentTodoId, "future-parent");
});

test("minimal core reads essential legacy events and writes rollback-compatible envelopes", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const legacy = (event: Record<string, unknown>): TodoBranchEntry => ({
    type: "custom",
    customType: "gentic.todo.event",
    data: { version: 1, event: { id: String(event.type), at, ...event } },
  });
  const h = harness([
    legacy({ type: "todo.created", todo: { id: "legacy", title: "Legacy task", status: "ready", evidence: [], dependsOn: [] } }),
    legacy({ type: "todo.external_blocked", todoId: "legacy", reason: "legacy blocker" }),
    legacy({ type: "todo.unblocked", todoId: "legacy" }),
    legacy({ type: "todo.started", todoId: "legacy" }),
  ]);
  assert.equal(h.core.state().todos.legacy.status, "in_progress");
  h.core.finish("legacy", "migrated");
  const envelope = (h.branch.at(-1) as { data: { event: { type: string; evidence?: unknown[] } } }).data;
  assert.equal(envelope.event.type, "todo.completed");
  assert.deepEqual(envelope.event.evidence, []);
  assert.equal(h.core.state().todos.legacy.status, "completed");
});

test("legacy status aliases normalize without violating the active invariant", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const entry = (id: string, status: string, blockedReason?: string): TodoBranchEntry => ({
    type: "custom",
    customType: "gentic.todo.event",
    data: { id: `event-${id}`, type: "todo.created", at, todo: { id, title: id, status, blockedReason } },
  });
  const h = harness([
    entry("pending", "pending"),
    entry("done", "done"),
    entry("blocked", "blocked", "legacy wait"),
    entry("active", "ready"),
    entry("cancelled", "ready"),
    { type: "custom", customType: "gentic.todo.event", data: { id: "cancel", type: "todo.cancelled", at, todoId: "cancelled" } },
    { type: "custom", customType: "gentic.todo.event", data: { id: "start", type: "todo.started", at, todoId: "active" } },
    { type: "custom", customType: "gentic.todo.event", data: { id: "unblock", type: "todo.unblocked", at, todoId: "active" } },
  ]);

  const state = h.core.state();
  assert.equal(state.todos.pending.status, "ready");
  assert.equal(state.todos.done.status, "completed");
  assert.equal(state.todos.blocked.status, "external_blocked");
  assert.equal(state.todos.blocked.blockedReason, "legacy wait");
  assert.equal(state.todos.active.status, "ready");
  assert.equal(state.todos.cancelled.status, "completed");
  assert.equal(state.activeTodoId, undefined);
});

test("public mutations reject oversized text and legacy replay bounds hostile lines", () => {
  const h = harness();
  assert.throws(() => h.core.create("x".repeat(257)), /256/);
  const todo = h.core.create("safe title");
  assert.throws(() => h.core.block(todo.id, "x".repeat(2_049)), /2048/);

  const hostile = harness([{
    type: "custom",
    customType: "gentic.todo.event",
    data: {
      version: 1,
      event: {
        id: "legacy-event",
        type: "todo.created",
        at: "2026-01-01T00:00:00.000Z",
        todo: {
          id: "legacy-safe",
          title: `${"T".repeat(400)}\nINJECTED`,
          status: "blocked",
          blockedReason: `${"R".repeat(3_000)}\nINJECTED`,
        },
      },
    },
  }]);
  const replayed = hostile.core.state().todos["legacy-safe"]!;
  assert.ok(replayed.title.length <= 256);
  assert.ok((replayed.blockedReason?.length ?? 0) <= 2_048);
  assert.doesNotMatch(`${replayed.title}${replayed.blockedReason}`, /[\r\n\u0000-\u001f\u007f]/);
});

test("branch reconstruction and create bound the public todo collection", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const entries: TodoBranchEntry[] = Array.from({ length: 1_001 }, (_, index) => ({
    type: "custom",
    customType: "gentic.todo.event",
    data: {
      version: 1,
      event: { id: `event-${index}`, type: "todo.created", at, todo: { id: `todo-${index}`, title: `todo ${index}`, status: "ready" } },
    },
  }));
  const h = harness(entries);
  const state = h.core.state();
  assert.equal(state.order.length, 1_000);
  assert.equal(Object.keys(state.todos).length, 1_000);
  assert.equal(state.todos["todo-1000"], undefined);
  assert.throws(() => h.core.create("overflow"), /todo limit/i);
});

test("branch reconstruction is a single bounded pass and ignores unrelated entries", () => {
  const unrelated = Array.from({ length: 10_000 }, (_, index) => ({
    type: "custom" as const,
    customType: "other.extension",
    data: { index },
  }));
  const h = harness(unrelated);
  const before = h.branchReads();
  assert.deepEqual(h.core.state(), { todos: {}, order: [], activeTodoId: undefined });
  assert.equal(h.branchReads() - before, 1);
});

test("state core has no filesystem scan or autonomous follow-up mechanism", async () => {
  const source = await readFile(new URL("../extensions/pi-todo/src/state-core.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|readdir|glob|walk\s*\(/);
  assert.doesNotMatch(source, /setTimeout|setInterval|sendMessage|agent_settled|turn_end/);
});
