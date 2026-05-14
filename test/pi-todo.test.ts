import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoService, TodoWorkflowError, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

test("todo completion requires evidence", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "implement reducer" });
  await assert.rejects(() => service.complete(todo.id, []), /EVIDENCE_REQUIRED|evidence is required/);
});

test("completion can use previously attached evidence", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "implement reducer" });
  await service.attachEvidence(todo.id, [{ type: "manual_note", note: "verified" }]);
  const completed = await service.complete(todo.id, [], "done");
  assert.equal(completed.status, "completed");
  assert.equal(completed.evidence.length, 1);
});

test("begin starts next ready todo and is idempotent while active", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "small task" });
  const started = await service.begin([], undefined, "agent-a");
  assert.equal(started.id, todo.id);
  assert.equal(started.status, "in_progress");
  const again = await service.begin([], undefined, "agent-a");
  assert.equal(again.id, todo.id);
});

test("finish completes active todo using existing evidence", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "small task" });
  await service.start(todo.id, [], undefined, "agent-a");
  await service.attachEvidence(todo.id, [{ type: "manual_note", note: "verified" }]);
  const finished = await service.finish(undefined, [], "done", "agent-a");
  assert.equal(finished.id, todo.id);
  assert.equal(finished.status, "completed");
});

test("max one in-progress todo is enforced", async () => {
  const service = new TodoService(new MemoryStore());
  const first = await service.create({ title: "first" });
  const second = await service.create({ title: "second" });
  await service.start(first.id);
  await assert.rejects(() => service.start(second.id), (error) => {
    assert.ok(error instanceof TodoWorkflowError);
    assert.equal(error.code, "MAX_IN_PROGRESS");
    assert.deepEqual(error.repair, { action: "get", params: { todoId: first.id } });
    return true;
  });
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
    /topic directory|filename must be/,
  );
  await assert.rejects(
    () => service.attachEvidence(todo.id, [{ type: "generated_artifact", path: ".model-artifacts/reports/2026-05-11_1200-report.md", summary: "report", createdByTodoId: todo.id }]),
    /topic directory/,
  );
  const updated = await service.attachEvidence(todo.id, [{ type: "generated_artifact", path: ".model-artifacts/reports/gentic/2026-05-11_1200-report.md", summary: "report", createdByTodoId: todo.id }]);
  assert.equal(updated.evidence[0].type, "generated_artifact");
  assert.equal(updated.evidence[0].createdByTodoId, todo.id);
});

test("compat statuses normalize to canonical lifecycle", async () => {
  const service = new TodoService(new MemoryStore());
  const pending = await service.create({ title: "legacy pending", status: "pending" });
  const done = await service.create({ title: "legacy done", status: "done" });
  assert.equal(pending.status, "ready");
  assert.equal(done.status, "completed");
});

test("completed tasks can be verified or reopened but are not scheduled", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "review me" });
  await service.complete(todo.id, [{ type: "manual_note", note: "done" }]);
  assert.equal(await service.next(), undefined);
  const reopened = await service.reopen(todo.id, "needs fixes");
  assert.equal(reopened.status, "ready");
  await service.complete(todo.id, [{ type: "manual_note", note: "fixed" }]);
  const verified = await service.verify(todo.id);
  assert.equal(verified.status, "verified");
});

test("start implicitly claims and enforces capabilities", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "guarded", requiredCapabilities: ["fs"] });
  await assert.rejects(() => service.start(todo.id), /missing_capabilities:fs/);
  const started = await service.start(todo.id, ["fs"], undefined, "agent-a");
  assert.equal(started.status, "in_progress");
  assert.equal(started.owner, "agent-a");
  assert.ok(started.activeClaimId);
});

test("max in-progress is scoped per owner", async () => {
  const service = new TodoService(new MemoryStore());
  const first = await service.create({ title: "first" });
  const second = await service.create({ title: "second" });
  const third = await service.create({ title: "third" });
  await service.start(first.id, [], undefined, "agent-a");
  await assert.rejects(() => service.start(second.id, [], undefined, "agent-a"), /max in-progress/);
  const started = await service.start(third.id, [], undefined, "agent-b");
  assert.equal(started.status, "in_progress");
});

test("expired claims do not block new work and emit claim_expired", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);
  const todo = await service.create({ title: "leased" });
  await service.claim(todo.id, [], -1, "agent-a");
  const started = await service.start(todo.id, [], undefined, "agent-b");
  assert.equal(started.status, "in_progress");
  assert.ok(store.events.some((event) => event.type === "todo.claim_expired"));
});

test("createArtifact writes a headed markdown artifact and records evidence", async () => {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "pi-todo-artifact-"));
  process.chdir(dir);
  try {
    const service = new TodoService(new MemoryStore());
    const todo = await service.create({ title: "write pi-swe plan", tags: ["pi-swe"] });
    const result = await service.createArtifact(todo.id, { kind: "plans", shortName: "My Plan!", purpose: "capture plan", content: "- do it" });
    assert.match(result.path, /^\.model-artifacts\/plans\/pi-swe\/\d{4}-\d{2}-\d{2}_\d{4}-my-plan\.md$/);
    const text = await readFile(result.path, "utf8");
    assert.match(text, /^# My Plan!\n\nCreated: .+\nPurpose: capture plan\n\n- do it\n$/);
    assert.equal(result.todo.evidence[0].type, "generated_artifact");
    assert.equal(result.todo.evidence[0].createdByTodoId, todo.id);
    assert.equal(result.todo.evidence[0].path, result.path);

    const phase = await service.createArtifact(todo.id, { kind: "todo", category: "pi-swe", subcategory: "pi-swe-phases", shortName: "Reconnaissance Contract", purpose: "phase plan", content: "- inspect" });
    assert.match(phase.path, /^\.model-artifacts\/todo\/pi-swe\/pi-swe-phases\/\d{4}-\d{2}-\d{2}_\d{4}-reconnaissance-contract\.md$/);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
});
