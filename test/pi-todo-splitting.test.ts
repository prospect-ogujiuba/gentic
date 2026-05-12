import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import { orderedTodos, readyToClose } from "../extensions/pi-todo/src/app/query.ts";
import { splitTitlesAreTooSimilar } from "../extensions/pi-todo/src/domain/splitting.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("split-check classifies atomic tasks and records metadata", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({
    title: "Add split-check command",
    acceptanceCriteria: ["todo split_check returns an assessment"],
    scope: { files: ["extensions/pi-todo/index.ts"] },
  });

  const result = await service.splitCheck(todo.id);
  const checked = await service.get(todo.id);

  assert.equal(result.assessment, "atomic");
  assert.equal(result.splitPolicySatisfied, true);
  assert.equal(checked.splitAssessment, "atomic");
  assert.equal(checked.splitPolicySatisfied, true);
});

test("required split policy blocks broad tasks until they are split or overridden", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({
    title: "Implement mandatory task splitting in pi-todo",
    description: "Touches lifecycle, command behavior, persistence, validation, and tests.",
    acceptanceCriteria: ["Add metadata", "Add split-check", "Block start", "Record override"],
    scope: { paths: ["extensions/pi-todo/src/domain", "extensions/pi-todo/src/app", "extensions/pi-todo/index.ts"] },
  });

  await assert.rejects(() => service.start(todo.id), /blocked: task requires splitting; assessment:split_required/);

  const overridden = await service.start(todo.id, [], undefined, "agent-a", { splitOverrideReason: "small enough after inspection" });
  assert.equal(overridden.status, "in_progress");
  assert.equal(overridden.splitOverrideReason, "small enough after inspection");
});

test("too vague tasks are blocked with a clarification assessment", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "Improve todo" });

  const result = await service.splitCheck(todo.id);

  assert.equal(result.assessment, "too_vague");
  await assert.rejects(() => service.start(todo.id), /assessment:too_vague/);
});

test("split parents become containers that cannot be started directly", async () => {
  const service = new TodoService(new MemoryStore());
  const parent = await service.create({ title: "Implement todo lifecycle changes", description: "Touches lifecycle and validation." });
  const [child] = await service.split(parent.id, [{ title: "Add lifecycle guard" }], "parent is too broad to work directly");

  const splitParent = await service.get(parent.id);
  assert.equal(splitParent.workDirectlyAllowed, false);
  assert.equal(splitParent.splitAssessment, "epic");
  assert.equal(child.parentId, parent.id);
  await assert.rejects(() => service.start(parent.id), /assessment:epic/);
});

test("split-check suggestions avoid parent-like child titles", async () => {
  const service = new TodoService(new MemoryStore());
  const parent = await service.create({
    title: "Implement mandatory task splitting in pi-todo",
    description: "Touches lifecycle, command behavior, persistence, validation, and tests.",
    acceptanceCriteria: ["Add metadata", "Add split-check", "Block start", "Record override"],
    scope: { paths: ["extensions/pi-todo/src/domain", "extensions/pi-todo/src/app", "extensions/pi-todo/index.ts"] },
  });

  const result = await service.splitCheck(parent.id);

  assert.ok(result.suggestedChildren.length > 0);
  assert.equal(result.suggestedChildren.some((child) => splitTitlesAreTooSimilar(parent.title, child.title)), false);
});

test("split rejects parent-like and sibling-like child titles", async () => {
  const service = new TodoService(new MemoryStore());
  const parent = await service.create({ title: "Implement mandatory task splitting in pi-todo", description: "Touches lifecycle and validation." });

  await assert.rejects(
    () => service.split(parent.id, [{ title: "Implement mandatory task splitting in pi-todo" }], "parent is too broad"),
    /too similar to parent.*make each child title\/scope more specific/,
  );

  await assert.rejects(
    () => service.split(parent.id, [{ title: "Add lifecycle guard" }, { title: "Add lifecycle guards" }], "parent is too broad"),
    /child titles are too similar.*make each child title\/scope more specific/,
  );
});

test("split accepts distinct children and terminal children stay out of the open docket", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);
  const parent = await service.create({ title: "Implement todo lifecycle changes", description: "Touches lifecycle and validation." });
  const unrelated = await service.create({ title: "Verify release notes" });
  const [child] = await service.split(parent.id, [{ title: "Add lifecycle guard" }], "parent is too broad to work directly");
  const started = await service.start(child.id, [], 1, "agent-a");
  const claimId = started.activeClaimId;

  await service.complete(child.id, [{ type: "manual_note", note: "implemented lifecycle guard" }], "done");
  await store.append({ id: "evt_stale_claim", type: "todo.claim_expired", at: new Date(Date.now() + 10).toISOString(), todoId: child.id, claimId: claimId!, reason: "lease_expired" });
  const state = await service.state();
  const openTitles = orderedTodos(state, false).map((todo) => todo.title);

  assert.equal(state.todos[child.id].status, "completed");
  assert.equal(state.todos[child.id].activeClaimId, null);
  assert.equal(readyToClose(state.todos[parent.id], state), true);
  assert.equal(openTitles.includes(child.title), false);
  assert.equal(openTitles.includes(unrelated.title), true);
});
