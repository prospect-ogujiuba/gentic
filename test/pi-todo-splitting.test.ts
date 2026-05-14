import test from "node:test";
import assert from "node:assert/strict";
import { TodoService, type TodoEventStore } from "../extensions/pi-todo/src/app/service.ts";
import { orderedTodos, readyToClose } from "../extensions/pi-todo/src/app/query.ts";
import { executeTodoAction } from "../extensions/pi-todo/src/pi/actions.ts";
import { assessTodoIntake, splitTitlesAreTooSimilar } from "../extensions/pi-todo/src/domain/splitting.ts";
import type { TodoEvent } from "../extensions/pi-todo/src/domain/types.ts";

class MemoryStore implements TodoEventStore {
  events: TodoEvent[] = [];
  async read() { return this.events; }
  async append(event: TodoEvent) { this.events.push(event); }
}

function actionHarness() {
  const entries: Array<{ type: "custom"; customType: string; data: TodoEvent }> = [];
  let sessionName = "";
  const pi = {
    appendEntry(customType: string, data: TodoEvent) { entries.push({ type: "custom", customType, data }); },
    getSessionName() { return sessionName; },
    setSessionName(value: string) { sessionName = value; },
  };
  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/gentic",
    hasUI: true,
    sessionManager: { getEntries: () => entries },
    ui: { setStatus() {}, setWidget() {}, setTitle() {} },
  };
  return { pi, ctx, entries };
}

test("intake assessment represents atomic input as one workable todo", () => {
  const result = assessTodoIntake({
    title: "Add split-check command",
    acceptanceCriteria: ["todo split_check returns an assessment"],
    scope: { files: ["extensions/pi-todo/index.ts"] },
  });

  assert.equal(result.assessment, "atomic");
  assert.equal(result.organization, "todo");
  assert.equal(result.todo?.title, "Add split-check command");
  assert.equal(result.parent, undefined);
  assert.deepEqual(result.suggestedChildren, []);
});

test("intake assessment represents compound input as a container with child inputs", () => {
  const result = assessTodoIntake({
    title: "Implement mandatory task splitting in pi-todo",
    description: "Touches lifecycle, command behavior, persistence, validation, and tests.",
    acceptanceCriteria: ["Add metadata", "Add split-check", "Block start", "Record override"],
    scope: { paths: ["extensions/pi-todo/src/domain", "extensions/pi-todo/src/app", "extensions/pi-todo/index.ts"] },
  });

  assert.equal(result.assessment, "split_required");
  assert.equal(result.organization, "container");
  assert.equal(result.parent?.workDirectlyAllowed, false);
  assert.ok(result.suggestedChildren.length > 0);
  assert.ok(result.suggestedChildren.every((child) => child.title && child.acceptanceCriteria?.length));
});

test("intake assessment represents vague input as clarification without creation", () => {
  const result = assessTodoIntake({ title: "Improve todo" });

  assert.equal(result.assessment, "too_vague");
  assert.equal(result.organization, "clarify");
  assert.equal(result.todo, undefined);
  assert.equal(result.parent, undefined);
  assert.deepEqual(result.suggestedChildren, []);
  assert.ok(result.clarificationQuestions.length > 0);
});

test("organized create keeps atomic input as one todo", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);

  const result = await service.createOrganized({
    title: "Add split-check command",
    acceptanceCriteria: ["todo split_check returns an assessment"],
    scope: { files: ["extensions/pi-todo/index.ts"] },
  });
  const state = await service.state();

  assert.equal(result.assessment.organization, "todo");
  assert.equal(result.todo?.title, "Add split-check command");
  assert.equal(result.children.length, 0);
  assert.equal(Object.keys(state.todos).length, 1);
});

test("organized create persists compound input as parent and children", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);

  const result = await service.createOrganized({
    title: "Implement mandatory task splitting in pi-todo",
    description: "Touches lifecycle, command behavior, persistence, validation, and tests.",
    acceptanceCriteria: ["Add metadata", "Add split-check", "Block start", "Record override"],
    scope: { paths: ["extensions/pi-todo/src/domain", "extensions/pi-todo/src/app", "extensions/pi-todo/index.ts"] },
  });

  assert.equal(result.assessment.organization, "container");
  assert.equal(result.parent?.workDirectlyAllowed, false);
  assert.ok(result.parent!.children.length > 0);
  assert.equal(result.children.length, result.parent!.children.length);
  assert.ok(result.children.every((child) => child.parentId === result.parent!.id && child.acceptanceCriteria.length > 0));
  assert.deepEqual(store.events.map((event) => event.type), ["todo.created", "todo.split"]);
  await assert.rejects(() => service.start(result.parent!.id), /assessment:epic/);
});

test("organized create returns clarification without persistence for vague input", async () => {
  const store = new MemoryStore();
  const service = new TodoService(store);

  const result = await service.createOrganized({ title: "Improve todo" });

  assert.equal(result.assessment.organization, "clarify");
  assert.equal(result.todo, undefined);
  assert.equal(result.parent, undefined);
  assert.equal(result.children.length, 0);
  assert.equal(store.events.length, 0);
});

test("tool create reports atomic organized intake", async () => {
  const { pi, ctx, entries } = actionHarness();

  const result = await executeTodoAction(pi as never, ctx as never, {
    action: "create",
    title: "Add split-check command",
    acceptanceCriteria: ["todo split_check returns an assessment"],
    scope: { files: ["extensions/pi-todo/index.ts"] },
  });

  assert.match(result.content[0].text, /Created atomic todo/);
  assert.equal(result.details.assessment.organization, "todo");
  assert.equal(entries.length, 1);
});

test("tool create reports compound request organized into parent and children", async () => {
  const { pi, ctx, entries } = actionHarness();

  const result = await executeTodoAction(pi as never, ctx as never, {
    action: "create",
    title: "Implement mandatory task splitting in pi-todo",
    description: "Touches lifecycle, command behavior, persistence, validation, and tests.",
    acceptanceCriteria: ["Add metadata", "Add split-check", "Block start", "Record override"],
    scope: { paths: ["extensions/pi-todo/src/domain", "extensions/pi-todo/src/app", "extensions/pi-todo/index.ts"] },
  });

  assert.match(result.content[0].text, /compound request organized/);
  assert.doesNotMatch(result.content[0].text, /rollback|corrective/i);
  assert.equal(result.details.assessment.organization, "container");
  assert.ok(result.details.parent.workDirectlyAllowed === false);
  assert.ok(result.details.children.length > 0);
  assert.deepEqual(entries.map((entry) => entry.data.type), ["todo.created", "todo.split"]);
});

test("tool create reports clarification for vague intake without persistence", async () => {
  const { pi, ctx, entries } = actionHarness();

  const result = await executeTodoAction(pi as never, ctx as never, { action: "create", title: "Improve todo" });

  assert.match(result.content[0].text, /intake needs clarification/);
  assert.equal(result.details.assessment.organization, "clarify");
  assert.equal(entries.length, 0);
});

test("tool create labels explicit vague fallback separately from atomic intake", async () => {
  const { pi, ctx, entries } = actionHarness();

  const result = await executeTodoAction(pi as never, ctx as never, { action: "create", title: "Improve todo", allowVagueTodo: true });

  assert.match(result.content[0].text, /Created vague todo via explicit fallback/);
  assert.doesNotMatch(result.content[0].text, /atomic/);
  assert.equal(result.details.assessment.organization, "clarify");
  assert.equal(result.details.todo.title, "Improve todo");
  assert.equal(entries.length, 1);
});

test("tool split and split_check still handle already-created tasks", async () => {
  const { pi, ctx } = actionHarness();
  const created = await executeTodoAction(pi as never, ctx as never, {
    action: "create",
    autoOrganize: false,
    title: "Implement existing split path",
    description: "Touches lifecycle and validation.",
  });
  const todoId = created.details.todo.id;

  const checked = await executeTodoAction(pi as never, ctx as never, { action: "split_check", todoId });
  assert.match(checked.content[0].text, /assessment: split_required/);

  const split = await executeTodoAction(pi as never, ctx as never, {
    action: "split",
    todoId,
    children: [{ title: "Add lifecycle guard" }],
    reason: "existing todo needs post-create decomposition",
  });
  assert.match(split.content[0].text, /split .* into 1 children/);
});

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
