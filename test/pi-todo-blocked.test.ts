import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, TodoWorkflowError, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import { TODO_TRANSITIONS, normalizeStatus } from "../extensions/pi-todo/src/domain/lifecycle.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("external blockers use external_blocked and can be unblocked back to ready", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "external review" });
  const blocked = await service.block(todo.id, "waiting on reviewer");
  assert.equal(blocked.status, "external_blocked");
  assert.equal(blocked.externalBlocker, "waiting on reviewer");
  assert.equal(await service.next(), undefined);

  const unblocked = await service.unblock(todo.id);
  assert.equal(unblocked.status, "ready");
  assert.equal(unblocked.blockedReason, undefined);
  assert.equal(unblocked.externalBlocker, undefined);
});

test("legacy blocked and abandoned statuses normalize to canonical lifecycle", async () => {
  const service = new TodoService(new MemoryStore());
  const blocked = await service.create({ title: "legacy blocked", status: "blocked" });
  const abandoned = await service.create({ title: "legacy abandoned", status: "abandoned" });

  assert.equal(blocked.status, "external_blocked");
  assert.equal(abandoned.status, "cancelled");
  assert.equal(normalizeStatus("blocked"), "external_blocked");
  assert.equal(normalizeStatus("abandoned"), "cancelled");
});

test("terminal lifecycle includes cancelled and superseded", async () => {
  const service = new TodoService(new MemoryStore());
  const cancelledTodo = await service.create({ title: "synthetic fixture" });
  const supersededTodo = await service.create({ title: "old approach" });

  const cancelled = await service.cancel(cancelledTodo.id, "not needed");
  const superseded = await service.supersede(supersededTodo.id, "todo_replacement", "replaced by narrower work");

  assert.equal(cancelled.status, "cancelled");
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededBy, "todo_replacement");
  assert.equal(await service.next(), undefined);
});

test("legal and illegal lifecycle transitions are enforced", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "transition guard" });

  assert.deepEqual(TODO_TRANSITIONS.ready, ["claimed", "in_progress", "external_blocked", "completed", "failed", "cancelled", "superseded"]);

  await service.block(todo.id, "waiting on upstream");
  await assert.rejects(
    () => service.complete(todo.id, [{ type: "manual_note", note: "not actually done" }]),
    (error) => error instanceof TodoWorkflowError && error.code === "ILLEGAL_STATUS_TRANSITION",
  );

  await service.unblock(todo.id);
  await service.start(todo.id, [], undefined, "agent-a");
  const completed = await service.complete(todo.id, [{ type: "manual_note", note: "done" }]);
  assert.equal(completed.status, "completed");

  await assert.rejects(
    () => service.complete(todo.id, [{ type: "manual_note", note: "duplicate" }]),
    (error) => error instanceof TodoWorkflowError && error.code === "ILLEGAL_STATUS_TRANSITION",
  );
  const verified = await service.verify(todo.id);
  assert.equal(verified.status, "verified");
});
