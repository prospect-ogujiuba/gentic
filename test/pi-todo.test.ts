import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoService, TodoWorkflowError, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

const layoutV2 = JSON.parse(await readFile(new URL("./fixtures/model-artifacts-layout-v2.json", import.meta.url), "utf8"));

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

test("legacy created records load with defaults and preserved history", async () => {
  const store = new MemoryStore();
  store.events.push({
    id: "evt-legacy",
    type: "todo.created",
    at: "2026-01-01T00:00:00.000Z",
    todo: {
      id: "legacy-1",
      title: "legacy blocked",
      status: "blocked",
      blockedReason: "waiting on design",
      evidence: [{ type: "manual_note", note: "old verification" }],
    } as TodoEvent extends { todo: infer T } ? T : never,
  });
  const service = new TodoService(store);
  const todo = await service.get("legacy-1");
  assert.equal(todo.status, "external_blocked");
  assert.equal(todo.scope.paths.length, 0);
  assert.deepEqual(todo.blockers, ["waiting on design"]);
  assert.equal(todo.evidence.length, 1);
});

test("legacy ceremonial blockers can be cancelled or superseded without losing reason", async () => {
  const store = new MemoryStore();
  store.events.push({
    id: "evt-legacy-cancelled",
    type: "todo.created",
    at: "2026-01-01T00:00:00.000Z",
    todo: { id: "legacy-cancelled", title: "legacy abandoned", status: "abandoned", blockedReason: "stale scaffold" } as TodoEvent extends { todo: infer T } ? T : never,
  });
  store.events.push({
    id: "evt-legacy-superseded",
    type: "todo.created",
    at: "2026-01-01T00:00:00.000Z",
    todo: { id: "legacy-superseded", title: "legacy superseded", status: "blocked", externalBlocker: "replaced by child" } as TodoEvent extends { todo: infer T } ? T : never,
  });
  const service = new TodoService(store);
  const cancelled = await service.get("legacy-cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.notes.includes("legacy blocker: stale scaffold"));
  const superseded = await service.supersede("legacy-superseded", "new-task", "old split scaffold replaced");
  assert.equal(superseded.status, "superseded");
  assert.ok(superseded.notes.includes("old split scaffold replaced"));
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

test("todo create idempotency keys and dependency cycle checks are deterministic", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);
  const first = await service.create({ title: "first", commandId: "create-1" });
  const retry = await service.create({ title: "ignored retry title", commandId: "create-1" });
  assert.equal(retry.id, first.id);
  assert.equal(store.events.filter((event) => event.type === "todo.created").length, 1);

  const second = await service.create({ title: "second" });
  const third = await service.create({ title: "third" });
  await assert.rejects(() => service.linkDependency(first.id, first.id), /cannot depend on itself/);
  await service.linkDependency(first.id, second.id);
  await service.linkDependency(second.id, third.id);
  await assert.rejects(() => service.linkDependency(third.id, first.id), /create a cycle/);
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

test("pi-todo emits layout-v2 initiative artifact paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-layout-v2-"));
  try {
    const service = new TodoService(new MemoryStore(), undefined, root);
    const todo = await service.create({ title: "write demo report", tags: ["demo"] });
    const result = await service.createArtifact(todo.id, { kind: "reports", category: "demo", shortName: "Verification", purpose: "verify", content: "pass" });
    assert.match(result.path, /^\.model-artifacts\/initiatives\/demo\/reports\/\d{4}-\d{2}-\d{2}_\d{4}-verification\.md$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi-todo treats layout-v1 evidence as migration-required rather than writable authority", async () => {
  const service = new TodoService(new MemoryStore());
  const todo = await service.create({ title: "legacy evidence" });
  const legacyPath = layoutV2.legacyReadOnly.find((path: string) => path.includes("/reports/"));
  await assert.rejects(
    () => service.attachEvidence(todo.id, [{ type: "generated_artifact", path: legacyPath, summary: "legacy", createdByTodoId: todo.id }]),
    /migration required/i,
  );
});

test("createArtifact rejects collisions and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-safe-artifact-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-todo-outside-"));
  try {
    const service = new TodoService(new MemoryStore(), undefined, root);
    const todo = await service.create({ title: "safe artifact", tags: ["safe"] });
    const input = { kind: "plans" as const, category: "safe", shortName: "same", purpose: "test", content: "x" };
    await service.createArtifact(todo.id, input);
    await assert.rejects(() => service.createArtifact(todo.id, input), (error: NodeJS.ErrnoException) => error.code === "EEXIST");

    await mkdir(join(root, ".model-artifacts/findings"), { recursive: true });
    await symlink(outside, join(root, ".model-artifacts/findings/escape"));
    await assert.rejects(
      () => service.createArtifact(todo.id, { kind: "findings", category: "escape", shortName: "bad", purpose: "test", content: "x" }),
      /outside ctx.cwd/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
