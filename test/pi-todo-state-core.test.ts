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
