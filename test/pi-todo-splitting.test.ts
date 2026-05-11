import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
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
