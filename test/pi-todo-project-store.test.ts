import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectTodoBackend } from "../src/pi-todo/project-backend.ts";
import { PROJECT_TODO_FILE, ProjectTodoStore, ProjectTodoStoreError } from "../src/pi-todo/project-store.ts";
import type { TodoCoreState } from "../src/pi-todo/state-core.ts";
import { registerLightweightTodoSurface } from "../src/pi-todo/thin-surface.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-project-todos-"));
  mkdirSync(join(root, ".git"));
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  return { root, nested, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function state(title = "Persisted project work"): TodoCoreState {
  return {
    order: ["ptodo_one"],
    todos: { ptodo_one: { id: "ptodo_one", title, status: "ready" } },
  };
}

test("project backend persists the complete lightweight lifecycle at repository root", () => {
  const { root, nested, cleanup } = fixture();
  try {
    const first = new ProjectTodoBackend(nested);
    const parent = first.execute({ action: "create", scope: "project", title: "Parent" }).item!;
    const childA = first.execute({ action: "create", scope: "project", title: "Child A", parentTodoId: parent.id }).item!;
    const childB = first.execute({ action: "create", scope: "project", title: "Child B", parentTodoId: parent.id }).item!;
    first.execute({ action: "move", scope: "project", todoId: childB.id, beforeTodoId: childA.id });
    first.execute({ action: "start", scope: "project", todoId: childB.id });
    first.execute({ action: "block", scope: "project", todoId: childB.id, reason: "external dependency" });
    first.execute({ action: "unblock", scope: "project", todoId: childB.id });
    first.execute({ action: "start", scope: "project", todoId: childB.id });
    first.execute({ action: "finish", scope: "project", todoId: childB.id, summary: "done" });
    first.execute({ action: "delete", scope: "project", todoId: childA.id });

    const reloaded = new ProjectTodoBackend(root).view();
    assert.equal(reloaded.scope, "project");
    assert.equal(reloaded.provider, "project");
    assert.deepEqual(reloaded.items.map((item) => [item.title, item.rawStatus]), [["Parent", "ready"], ["Child B", "completed"]]);
    assert.equal(existsSync(join(root, PROJECT_TODO_FILE)), true);
    assert.equal(existsSync(join(nested, PROJECT_TODO_FILE)), false);
    const document = JSON.parse(readFileSync(join(root, PROJECT_TODO_FILE), "utf8"));
    assert.deepEqual(Object.keys(document), ["kind", "schemaVersion", "revision", "updatedAt", "todos"]);
    assert.equal(document.kind, "gentic.project-todos");
    assert.equal(document.schemaVersion, 1);
    assert.ok(document.revision >= 10);
  } finally { cleanup(); }
});

test("project store rejects stale writers, lock contention, malformed state, and symlinks", () => {
  const { root, cleanup } = fixture();
  try {
    const store = new ProjectTodoStore(root);
    const empty = store.read();
    const written = store.write(empty, state());
    assert.throws(() => store.write(empty, state("stale overwrite")), (error: unknown) => error instanceof ProjectTodoStoreError && error.code === "STALE_PROJECT_TODOS");
    writeFileSync(`${written.path}.lock`, "held\n");
    assert.throws(() => store.write(written, state("locked overwrite")), (error: unknown) => error instanceof ProjectTodoStoreError && error.code === "PROJECT_TODOS_LOCKED");
    rmSync(`${written.path}.lock`);

    writeFileSync(written.path, '{"kind":"gentic.project-todos","schemaVersion":1,"revision":2,"updatedAt":"bad","todos":[],"extra":true}\n');
    assert.throws(() => store.read(), (error: unknown) => error instanceof ProjectTodoStoreError && error.code === "MALFORMED_PROJECT_TODOS");

    rmSync(written.path);
    writeFileSync(join(root, "target.json"), "{}\n");
    symlinkSync(join(root, "target.json"), written.path);
    assert.throws(() => store.read(), (error: unknown) => error instanceof ProjectTodoStoreError && error.code === "UNSAFE_PROJECT_TODO_PATH");
  } finally { cleanup(); }
});

test("scope routing isolates session and project authority and rejects cross-scope ids", async () => {
  const { root, cleanup } = fixture();
  try {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const branch: unknown[] = [];
    const notifications: string[] = [];
    const pi = {
      on() {}, registerCommand(name: string, command: unknown) { commands.set(name, command); },
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
      appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    };
    const ctx = { cwd: root, hasUI: false, mode: "json", sessionManager: { getBranch: () => branch }, ui: { notify(message: string) { notifications.push(message); } } };
    registerLightweightTodoSurface(pi as never);
    const tool = tools.get("todo");
    const execute = (action: string, params: Record<string, unknown> = {}) => tool.execute(action, { action, ...params }, new AbortController().signal, () => {}, ctx);

    const session = await execute("create", { scope: "session", title: "Session only" });
    const project = await execute("create", { scope: "project", title: "Project only" });
    assert.match((await execute("list", { scope: "session" })).content[0].text, /Session only/);
    assert.doesNotMatch((await execute("list", { scope: "session" })).content[0].text, /Project only/);
    assert.match((await execute("list", { scope: "project" })).content[0].text, /Project only/);
    assert.doesNotMatch((await execute("list", { scope: "project" })).content[0].text, /Session only/);
    assert.equal((await execute("delete", { scope: "session", todoId: project.details.todo.id })).details.error.code, "TODO_NOT_FOUND");
    assert.equal((await execute("delete", { scope: "project", todoId: session.details.todo.id })).details.error.code, "TODO_NOT_FOUND");
    const all = await execute("list", { scope: "all" });
    assert.match(all.content[0].text, /session:todo_/);
    assert.match(all.content[0].text, /project:ptodo_/);
    assert.equal((await execute("delete", { scope: "all", todoId: project.details.todo.id })).isError, true);

    const command = commands.get("todo");
    assert.deepEqual(command.getArgumentCompletions("").slice(0, 4).map((item: any) => item.value), ["session", "project", "initiative", "all"]);
    await command.handler("project create Command project work", ctx);
    assert.match(notifications.at(-1) ?? "", /Command project work/);
    await command.handler("project list", ctx);
    assert.match(notifications.at(-1) ?? "", /\[project\].*Command project work/);
    assert.deepEqual(command.getArgumentCompletions("all ").map((item: any) => item.value), ["all open", "all list"]);

    assert.equal(branch.length, 1, "project writes must not append session events");
    assert.equal(new ProjectTodoBackend(root).view().items.length, 2, "session writes must not enter project authority");
  } finally { cleanup(); }
});

test("project store publishes atomically, removes interrupted temporary files, and serializes concurrent writers", () => {
  const { root, cleanup } = fixture();
  try {
    const initialStore = new ProjectTodoStore(root);
    const initial = initialStore.write(initialStore.read(), state("original"));
    const rawBefore = readFileSync(initial.path, "utf8");
    const interrupted = new ProjectTodoStore(root, { beforeRename: () => { throw new Error("injected interruption"); } });
    assert.throws(() => interrupted.write(interrupted.read(), state("must not publish")), /injected interruption/);
    assert.equal(readFileSync(initial.path, "utf8"), rawBefore);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(existsSync(`${initial.path}.lock`), false);

    let concurrentError: unknown;
    const concurrent = new ProjectTodoStore(root);
    const contended = new ProjectTodoStore(root, {
      beforeRename: () => {
        try { concurrent.write(concurrent.read(), state("concurrent")); }
        catch (error) { concurrentError = error; }
      },
    });
    contended.write(contended.read(), state("winner"));
    assert.ok(concurrentError instanceof ProjectTodoStoreError);
    assert.equal((concurrentError as ProjectTodoStoreError).code, "PROJECT_TODOS_LOCKED");
    assert.equal(new ProjectTodoStore(root).read().state.todos.ptodo_one?.title, "winner");
  } finally { cleanup(); }
});
