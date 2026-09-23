import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { initiativePath } from "../extensions/pi-swe/src/app/store.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-todo-workflow-"));
  const initiative = structuredClone(bootstrap);
  initiative.revision = 1;
  initiative.status = "active";
  initiative.evidence = [];
  initiative.work = initiative.work.map((item: { id: string; kind: string }) => item.kind === "phase" ? item : {
    ...item,
    status: ["W-1", "W-2", "W-3", "W-4"].includes(item.id) ? "complete" : "pending",
  });
  const path = initiativePath(root, initiative.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(initiative, null, 2)}\n`);
  return { root, initiativeId: initiative.id };
}

function legacyTodoBranch() {
  return [{
    type: "custom",
    customType: "gentic.todo.event",
    data: {
      version: 1,
      event: {
        id: "legacy-event",
        type: "todo.created",
        at: "2026-01-01T00:00:00.000Z",
        todo: { id: "standalone", title: "Preserved standalone task", status: "ready" },
      },
    },
  }];
}

test("focused active workflow is projected and todo mutations route only through SweService", async () => {
  const { root, initiativeId } = fixture();
  try {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const branch = legacyTodoBranch();
    const statuses: Array<string | undefined> = [];
    const widgets: unknown[] = [];
    let rejectPresentation = false;
    let appendCount = 0;
    const pi = {
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: unknown) { commands.set(name, command); },
      appendEntry(customType: string) { if (customType === "gentic.todo.event") appendCount += 1; },
      sendMessage() {},
    };
    piSwe(pi as never);
    const ctx = {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      sessionManager: {
        getSessionId: () => "workflow-todo-test",
        getBranch: () => branch,
        getEntries: () => [{ type: "custom", customType: "gentic.swe.focus", data: { initiativeId } }],
      },
      ui: {
        setStatus(_key: string, value: string | undefined) {
          if (rejectPresentation) throw new Error("simulated presentation failure");
          statuses.push(value);
        },
        setWidget(_key: string, value: unknown) { widgets.push(value); },
        notify() {},
      },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);

    const todo = tools.get("todo");
    const execute = (action: string, params: Record<string, unknown> = {}) => todo.execute(
      action,
      { action, ...params },
      new AbortController().signal,
      () => {},
      ctx,
    );

    const projected = await execute("list");
    assert.equal(projected.details.view.provider, "workflow");
    assert.equal(projected.details.view.authorityId, initiativeId);
    assert.match(projected.content[0].text, /W-5/);
    assert.doesNotMatch(projected.content[0].text, /Preserved standalone task/);
    assert.deepEqual(commands.get("todo").getArgumentCompletions("").map((item: any) => item.value), ["open", "list", "start"]);
    assert.deepEqual(commands.get("todo").getArgumentCompletions("start W-").map((item: any) => item.value), ["start W-5"]);

    const swe = tools.get("swe");
    const started = await swe.execute(
      "start-work",
      { action: "start", initiativeId, workId: "W-5" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    const startedWork = started.details.initiative.work.find((item: any) => item.id === "W-5");
    assert.equal(startedWork.status, "active");
    assert.deepEqual(commands.get("todo").getArgumentCompletions("").map((item: any) => item.value), ["open", "list", "finish"]);
    assert.equal(statuses.at(-1), `todo: ${startedWork.title}`);
    assert.ok(Array.isArray(widgets.at(-1)), "SWE mutation must refresh the RPC todo widget");
    assert.deepEqual(commands.get("todo").getArgumentCompletions("finish W-").map((item: any) => item.value), ["finish W-5"]);
    const implemented = await execute("finish", { todoId: "W-5", summary: "must not bypass gates" });
    assert.equal(implemented.details.todo.rawStatus, "implemented");
    assert.equal(new SweService(root).status(initiativeId).initiative.work.find((item) => item.id === "W-5")?.status, "implemented");
    assert.equal(appendCount, 0, "workflow operations must not append standalone todo entries");
    assert.equal(branch.length, 1);

    const structural = await execute("delete", { todoId: "W-5" });
    assert.equal(structural.isError, true);
    assert.equal(structural.details.error.code, "UNSUPPORTED_WORKFLOW_ACTION");
    assert.match(structural.content[0].text, /intentional swe revision/i);

    rejectPresentation = true;
    const paused = await swe.execute(
      "pause-workflow",
      { action: "pause", initiativeId },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(paused.isError, undefined, "presentation failure must not misreport a durable SWE mutation");
    assert.equal(paused.details.initiative.status, "paused");
    rejectPresentation = false;
    const standalone = await execute("list");
    assert.equal(standalone.details.view, undefined);
    assert.equal(standalone.details.state.todos.standalone.title, "Preserved standalone task");
    assert.match(standalone.content[0].text, /Preserved standalone task/);
    assert.equal(branch.length, 1, "backend switching must not synchronize authorities");

    writeFileSync(initiativePath(root, initiativeId), "{malformed\n");
    const unavailable = await execute("create", { title: "must fail closed" });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /malformed/i);
    assert.equal(branch.length, 1, "unreadable focused authority must not fall back to standalone writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
