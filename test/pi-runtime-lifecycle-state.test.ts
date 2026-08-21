import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_TODO_EVENT_CUSTOM_TYPE,
  PI_TODO_EVENT_VERSION,
  PiTodoEventStore,
  decodeTodoEvent,
} from "../extensions/pi-todo/src/pi/store.ts";
import {
  PI_SWE_STATE_CUSTOM_TYPE,
  decodeSweStateEnvelope,
  reconstructPersistedSweState,
} from "../extensions/pi-swe/src/app/runtime.ts";
import { createSweState, recordVerification } from "../extensions/pi-swe/src/domain/state.ts";
import { createVerificationEvidence } from "../extensions/pi-swe/src/domain/evidence.ts";
import { evaluateSwePolicy } from "../extensions/pi-swe/src/domain/policy.ts";
import { getSessionState, resetSessionState } from "../extensions/pi-context/src/app/session-state.ts";
import { MESSAGE_UPDATE_SAMPLE_RATE, registerPiContext } from "../extensions/pi-context/src/pi/register.ts";

const todoEvent = (id: string) => ({ id, type: "todo.cancelled", at: "2026-08-21T00:00:00.000Z", todoId: id, reason: "test" }) as const;

test("pi-todo reads only decoded events on the active branch", async () => {
  const active = todoEvent("active");
  const abandoned = todoEvent("abandoned");
  const branch = [
    { type: "custom", customType: PI_TODO_EVENT_CUSTOM_TYPE, data: active },
    { type: "custom", customType: PI_TODO_EVENT_CUSTOM_TYPE, data: { version: 99, event: abandoned } },
  ];
  const allEntries = [...branch, { type: "custom", customType: PI_TODO_EVENT_CUSTOM_TYPE, data: { version: PI_TODO_EVENT_VERSION, event: abandoned } }];
  const store = new PiTodoEventStore({ appendEntry() {} } as never, {
    sessionManager: { getBranch: () => branch, getEntries: () => allEntries },
  } as never);

  assert.deepEqual(await store.read(), [active]);
  assert.deepEqual(decodeTodoEvent({ version: PI_TODO_EVENT_VERSION, event: active }), active);
  assert.equal(decodeTodoEvent({ version: 2, event: active }), undefined);
});

test("pi-todo appends a versioned event envelope", async () => {
  const appended: unknown[] = [];
  const event = todoEvent("new");
  const store = new PiTodoEventStore({ appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }) } as never, {
    sessionManager: { getBranch: () => [] },
  } as never);

  await store.append(event);
  assert.deepEqual(appended, [{ customType: PI_TODO_EVENT_CUSTOM_TYPE, data: { version: PI_TODO_EVENT_VERSION, event } }]);
});

test("pi-swe reconstructs required state from the active branch and ignores future versions", () => {
  const active = { version: 1, state: { activePlan: { source: "artifact", marker: " .model-artifacts/todo/demo/phases/03.md " }, activeStage: "implement" } };
  const future = { version: 2, state: { activePlan: { source: "prompt", marker: "abandoned" }, activeStage: "finalize" } };
  const branch = [
    { type: "custom", customType: PI_SWE_STATE_CUSTOM_TYPE, data: active },
    { type: "custom", customType: PI_SWE_STATE_CUSTOM_TYPE, data: future },
  ];

  assert.deepEqual(reconstructPersistedSweState(branch), {
    activePlan: { source: "artifact", marker: ".model-artifacts/todo/demo/phases/03.md" },
    activeStage: "implement",
  });
  assert.equal(decodeSweStateEnvelope(future), undefined);
});

test("pi-context assigns pending input to the next turn, preserves tool paths, and throttles updates", () => {
  resetSessionState("test");
  const handlers = new Map<string, Function>();
  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand() {},
  } as never);
  const ctx = {
    cwd: "/repo",
    model: { id: "mock", provider: "mock", contextWindow: 1000 },
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp",
      getCwd: () => "/repo",
    },
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
  };

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  handlers.get("input")?.({ type: "input", text: "next", source: "interactive" }, ctx);
  assert.deepEqual(getSessionState()?.ledgerEntries.find((entry) => entry.kind === "user")?.turnIds, []);
  handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 2, timestamp: 1 }, ctx);
  assert.deepEqual(getSessionState()?.ledgerEntries.find((entry) => entry.kind === "user")?.turnIds, ["turn-2"]);

  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "call", toolName: "write", args: { path: "src/a.ts", content: "x" } }, ctx);
  handlers.get("tool_result")?.({ type: "tool_result", toolCallId: "call", toolName: "write", input: { path: "src/a.ts", content: "x" }, content: [{ type: "text", text: "ok" }], details: { bytes: 1 }, isError: false }, ctx);
  handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "call", toolName: "write", result: [{ type: "text", text: "ok" }], isError: false }, ctx);
  const tool = getSessionState()?.ledgerEntries.find((entry) => entry.id === "runtime:tool:call");
  assert.deepEqual(tool?.sourceMetadata?.paths, ["src/a.ts"]);
  assert.ok((tool?.sourceMetadata?.argumentByteCount ?? 0) > 0);
  assert.ok((tool?.sourceMetadata?.detailByteCount ?? 0) > 0);

  const message = { role: "assistant", content: [{ type: "text", text: "stream" }], timestamp: 42 };
  for (let index = 0; index < MESSAGE_UPDATE_SAMPLE_RATE - 1; index += 1) {
    handlers.get("message_update")?.({ type: "message_update", message }, ctx);
  }
  assert.equal(getSessionState()?.lifecycleEvents.filter((event) => event.type === "message_update").length, 0);
  handlers.get("message_update")?.({ type: "message_update", message }, ctx);
  assert.equal(getSessionState()?.lifecycleEvents.filter((event) => event.type === "message_update").length, 1);
  handlers.get("message_end")?.({ type: "message_end", message }, ctx);
  assert.equal(getSessionState()?.ledgerEntries.find((entry) => entry.label === "assistant message")?.sourceMetadata?.uncollectedEventCount, MESSAGE_UPDATE_SAMPLE_RATE - 1);

  handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);
  assert.equal(getSessionState()?.active, false);
  assert.deepEqual(getSessionState()?.ledgerEntries, []);
});

test("failed, manual, and unrelated evidence do not satisfy pi-swe verification", () => {
  const finalizing = { ...createSweState(), activeStage: "finalize" as const };
  const failed = recordVerification(finalizing, createVerificationEvidence({ kind: "command", command: "npm test", exitCode: 1, scope: "focused" }));
  const manual = recordVerification(failed, createVerificationEvidence({ kind: "note", note: "looked okay", scope: "manual" }));
  const nearby = recordVerification(manual, createVerificationEvidence({ kind: "command", command: "npm test -- adjacent", exitCode: 0, scope: "nearby" }));
  const successful = recordVerification(nearby, createVerificationEvidence({ kind: "command", command: "npm test -- focused", exitCode: 0, scope: "focused" }));

  assert.equal(evaluateSwePolicy({ state: nearby }).warnings.some((warning) => warning.code === "missing_verification"), true);
  assert.equal(evaluateSwePolicy({ state: successful }).warnings.some((warning) => warning.code === "missing_verification"), false);
});
