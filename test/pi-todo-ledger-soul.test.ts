import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import { nextTodo } from "../extensions/pi-todo/src/app/query.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("split creates executable children and makes parent ready to close only after children finish", async () => {
  const service = new TodoService(new MemoryStore());
  const parent = await service.create({ title: "ship todo soul" });
  const [child] = await service.split(parent.id, [{ title: "add claims" }], "separation_of_concerns: claim lifecycle is independently verifiable");
  let state = await service.state();
  assert.equal(state.todos[parent.id].children[0], child.id);
  assert.equal(nextTodo(state)?.id, child.id);
  await service.complete(child.id, [{ type: "manual_note", note: "done" }]);
  state = await service.state();
  assert.equal(nextTodo(state)?.id, parent.id);
});

test("claim respects required capabilities and release returns task to ready", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "edit files", requiredCapabilities: ["code_write"] });
  await assert.rejects(() => service.claim(todo.id, ["repo-inspection"]), /missing_capabilities:code_write/);
  const claimed = await service.claim(todo.id, ["code_write"]);
  assert.equal(claimed.status, "claimed");
  const released = await service.release(todo.id, "handoff");
  assert.equal(released.status, "ready");
});

test("verify policy tags, fail, reopen, history and graph are durable ledger actions", async () => {
  const service = new TodoService(new MemoryStore());
  const dep = await service.create({ title: "dependency" });
  const todo = await service.create({ title: "target", scope: { policyTags: ["verify.requires:reviewer"] } });
  await service.linkDependency(todo.id, dep.id);
  await service.fail(todo.id, "needs another pass");
  await service.reopen(todo.id, "fixed plan");
  await service.complete(todo.id, [{ type: "manual_note", note: "implemented" }]);
  await assert.rejects(() => service.verify(todo.id, [{ type: "review", summary: "reviewed" }]), /verify requires capabilities=reviewer/);
  const verified = await service.verify(todo.id, [{ type: "review", summary: "reviewed" }], undefined, ["reviewer"]);
  assert.equal(verified.status, "verified");
  assert.deepEqual((await service.history(todo.id)).map((event) => event.type).filter((type) => type !== "todo.created"), ["todo.dependency_linked", "todo.failed", "todo.reopened", "todo.completed", "todo.verified"]);
  assert.equal((await service.graph(todo.id)).edges.some((edge) => edge.kind === "depends_on" && edge.to === dep.id), true);
});
