import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("blocked todos can be unblocked back to pending", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "external review" });
  await service.block(todo.id, "waiting");
  const unblocked = await service.unblock(todo.id);
  assert.equal(unblocked.status, "pending");
  assert.equal(unblocked.blockedReason, undefined);
});

test("cancelled todos leave the open queue", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "synthetic blocked fixture" });
  const cancelled = await service.cancel(todo.id, "not needed");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await service.next(), undefined);
});
