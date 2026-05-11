import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("created todo id resolves immediately and title fallback is unique", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "Remove coordination metadata" });
  assert.equal(await service.resolveId(todo.id), todo.id);
  assert.equal(await service.resolveId(todo.title), todo.id);
});

test("ambiguous title fallback is rejected", async () => {
  const service = new TodoService(new MemoryStore());
  await service.create({ title: "duplicate" });
  await service.create({ title: "duplicate" });
  await assert.rejects(() => service.resolveId("duplicate"), /ambiguous/);
});

test("generated artifacts must live under model artifacts and trace to their todo", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "write report" });
  await assert.rejects(
    () => service.attachEvidence(todo.id, [{ type: "generated_artifact", path: "report.md", summary: "report", createdByTodoId: todo.id }]),
    /under \.model-artifacts\//,
  );
  await assert.rejects(
    () => service.attachEvidence(todo.id, [{ type: "generated_artifact", path: ".model-artifacts/reports/2026-05-11_1200-report.md", summary: "report", createdByTodoId: "other" }]),
    /createdByTodoId must match/,
  );
  await assert.rejects(
    () => service.attachEvidence(todo.id, [{ type: "generated_artifact", path: ".model-artifacts/reports/report.md", summary: "report", createdByTodoId: todo.id }]),
    /filenames must be/,
  );
  const updated = await service.attachEvidence(todo.id, [{ type: "generated_artifact", path: ".model-artifacts/reports/2026-05-11_1200-report.md", summary: "report", createdByTodoId: todo.id }]);
  assert.equal(updated.evidence[0].type, "generated_artifact");
  assert.equal(updated.evidence[0].createdByTodoId, todo.id);
});

test("createArtifact writes a headed markdown artifact and records evidence", async () => {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "pi-todo-artifact-"));
  process.chdir(dir);
  try {
    const service = new TodoService(new MemoryStore());
    const todo = await service.create({ title: "write plan" });
    const result = await service.createArtifact(todo.id, { kind: "plans", shortName: "My Plan!", purpose: "capture plan", content: "- do it" });
    assert.match(result.path, /^\.model-artifacts\/plans\/\d{4}-\d{2}-\d{2}_\d{4}-my-plan\.md$/);
    const text = await readFile(result.path, "utf8");
    assert.match(text, /^# My Plan!\n\nCreated: .+\nPurpose: capture plan\n\n- do it\n$/);
    assert.equal(result.todo.evidence[0].type, "generated_artifact");
    assert.equal(result.todo.evidence[0].createdByTodoId, todo.id);
    assert.equal(result.todo.evidence[0].path, result.path);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
});
