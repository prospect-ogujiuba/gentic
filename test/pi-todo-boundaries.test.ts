import test from "node:test";
import assert from "node:assert/strict";
import { TodoLedger, type TodoEventStore } from "../extensions/pi-todo/src/app/ledger.ts";
import { TodoService } from "../extensions/pi-todo/src/app/service.ts";
import { todoTuiProjection } from "../extensions/pi-todo/src/app/projection.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("ledger-only create and append work without policy enforcement", async () => {
  const ledger = new TodoLedger(new MemoryStore());
  const todo = await ledger.create({ title: "ledger boundary", requiredCapabilities: ["specialist"], dependsOn: ["missing"] });
  const state = await ledger.state();

  assert.equal(state.todos[todo.id].status, "ready");
  assert.deepEqual(state.todos[todo.id].requiredCapabilities, ["specialist"]);
  assert.deepEqual(state.todos[todo.id].dependsOn, ["missing"]);
});

test("policy decisions cannot mutate state without lifecycle append", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);
  const todo = await service.create({ title: "guarded", requiredCapabilities: ["fs"] });
  await assert.rejects(() => service.start(todo.id), /missing_capabilities:fs/);

  const state = await service.state();
  assert.equal(state.todos[todo.id].status, "ready");
  assert.equal(store.events.filter((event) => event.type === "todo.started" || event.type === "todo.claimed").length, 0);
});

test("TUI projection derives counts and warnings from canonical task data", async () => {
  const service = new TodoService(new MemoryStore());
  const dependency = await service.create({ title: "dependency" });
  const child = await service.create({ title: "child", dependsOn: [dependency.id] });
  const state = await service.state();

  const projection = todoTuiProjection(state, [child]);
  assert.equal(projection.counts.total, 2);
  assert.equal(projection.counts.open, 2);
  assert.equal(projection.counts.active, 0);
  assert.equal(projection.counts.blockedExternal, 0);
  assert.equal(projection.counts.completedHistory, 0);
  assert.deepEqual(projection.warnings, [{ todoId: child.id, kind: "open_dependencies", count: 1 }]);
});

test("TUI projection separates actionable open, external blockers, active work, and history", async () => {
  const service = new TodoService(new MemoryStore());
  const active = await service.create({ title: "active implementation" });
  const blocked = await service.create({ title: "waiting on external decision" });
  const done = await service.create({ title: "completed history" });
  const superseded = await service.create({ title: "old superseded plan" });

  await service.start(active.id, [], undefined, "agent-a");
  await service.block(blocked.id, "waiting on user decision");
  await service.complete(done.id, [{ type: "manual_note", note: "done" }]);
  await service.supersede(superseded.id, done.id, "covered by completed work");
  const projection = todoTuiProjection(await service.state(), []);

  assert.equal(projection.counts.total, 4);
  assert.equal(projection.counts.open, 1);
  assert.equal(projection.counts.active, 1);
  assert.equal(projection.counts.blockedExternal, 1);
  assert.equal(projection.counts.completedHistory, 2);
  assert.equal(projection.counts.byStatus.external_blocked, 1);
  assert.equal(projection.counts.byStatus.superseded, 1);
});
