import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("todo completion requires evidence", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "implement reducer" });
  await assert.rejects(() => service.complete(todo.id, []), /evidence is required/);
});

test("max one in-progress todo is enforced", async () => {
  const service = new TodoService(new MemoryStore());
  const first = await service.create({ title: "first" });
  const second = await service.create({ title: "second" });
  await service.start(first.id);
  await assert.rejects(() => service.start(second.id), /max in-progress/);
});

test("dependency must be done before start", async () => {
  const service = new TodoService(new MemoryStore());
  const dep = await service.create({ title: "dependency" });
  const child = await service.create({ title: "child", dependsOn: [dep.id] });
  await assert.rejects(() => service.start(child.id), /dependency not done/);
  await service.complete(dep.id, [{ type: "manual_note", note: "verified" }]);
  const started = await service.start(child.id);
  assert.equal(started.status, "in_progress");
});
