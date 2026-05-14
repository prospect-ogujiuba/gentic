import test from "node:test";
import assert from "node:assert/strict";
import { updateTodoWidget } from "../extensions/pi-todo/src/pi/actions.ts";

test("todo widget clears status and widget when no tasks exist", async () => {
  const calls: Array<{ method: string; key: string; value: unknown }> = [];
  const pi = {
    getSessionName: () => undefined,
    setSessionName: () => {},
    appendEntry: () => {},
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getEntries: () => [] },
    ui: {
      setStatus: (key: string, value: unknown) => calls.push({ method: "setStatus", key, value }),
      setWidget: (key: string, value: unknown) => calls.push({ method: "setWidget", key, value }),
      setTitle: () => {},
    },
  };

  await updateTodoWidget(pi as never, ctx as never);

  assert.deepEqual(calls, [
    { method: "setStatus", key: "todo", value: undefined },
    { method: "setWidget", key: "todo", value: undefined },
  ]);
});
