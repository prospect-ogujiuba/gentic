import test from "node:test";
import assert from "node:assert/strict";
import { createContextSnapshot } from "../extensions/pi-context/src/domain/index.ts";
import {
  getSessionState,
  recordLedgerEntries,
  resetSessionState,
  startSessionState,
  updateSessionState,
} from "../extensions/pi-context/src/app/index.ts";
import {
  collectRuntimeCompaction,
  collectRuntimeMessage,
  collectRuntimeToolExecutionStart,
  collectRuntimeToolResult,
  registerPiContext,
} from "../extensions/pi-context/src/pi/index.ts";

const at = (second: number) => `2026-05-13T03:00:${String(second).padStart(2, "0")}.000Z`;

test("runtime message updates are de-duplicated and final message data wins", () => {
  resetSessionState("test", at(0));
  startSessionState({ reason: "startup", at: at(1), metadata: { sessionId: "s-runtime" } });
  updateSessionState({ event: "turn_start", at: at(2) });

  const partial = {
    role: "assistant",
    content: [{ type: "text", text: "hel" }],
    api: "mock",
    provider: "mock",
    model: "mock",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: 111,
  } as const;
  const final = { ...partial, content: [{ type: "text", text: "hello world" }], usage: { ...partial.usage, totalTokens: 5 } } as const;

  for (const result of [
    collectRuntimeMessage("message_start", partial, { at: at(3), turnId: "turn-1" }),
    collectRuntimeMessage("message_update", partial, { at: at(4), turnId: "turn-1" }),
    collectRuntimeMessage("message_update", partial, { at: at(5), turnId: "turn-1" }),
    collectRuntimeMessage("message_end", final, { at: at(6), turnId: "turn-1" }),
  ]) recordLedgerEntries({ at: at(6), entries: result.entries, warnings: result.warnings });

  const assistantEntries = getSessionState()?.ledgerEntries.filter((entry) => entry.kind === "session" && entry.label === "assistant message") ?? [];
  assert.equal(assistantEntries.length, 1);
  assert.equal(assistantEntries[0]?.byteCount, "hello world".length);
  assert.equal(assistantEntries[0]?.tokenCount, 5);
  assert.equal(assistantEntries[0]?.sourceMetadata?.eventType, "message_end");
  assert.deepEqual(assistantEntries[0]?.turnIds, ["turn-1"]);
});

test("runtime tool classifiers record status, errors, and path-level file interactions", () => {
  resetSessionState("test", at(0));
  startSessionState({ reason: "startup", at: at(1), metadata: { sessionId: "s-tool" } });

  const start = collectRuntimeToolExecutionStart({ toolCallId: "tc-1", toolName: "read", args: { path: "/repo/src/app.ts" } }, { at: at(2), turnId: "turn-1" });
  const result = collectRuntimeToolResult(
    {
      type: "tool_result",
      toolCallId: "tc-1",
      toolName: "read",
      input: { path: "/repo/src/app.ts" },
      content: [{ type: "text", text: "ERROR: missing\nwarning: fallback" }],
      details: { lines: 2 },
      isError: true,
    },
    { at: at(3), turnId: "turn-1" },
  );
  recordLedgerEntries({ at: at(2), entries: start.entries, warnings: start.warnings });
  recordLedgerEntries({ at: at(3), entries: result.entries, warnings: result.warnings });

  const state = getSessionState();
  const toolEntry = state?.ledgerEntries.find((entry) => entry.id === "runtime:tool:tc-1");
  const fileEntry = state?.ledgerEntries.find((entry) => entry.origin === "/repo/src/app.ts" && entry.kind === "discovered");
  assert.equal(toolEntry?.sourceMetadata?.executionStatus, "error");
  assert.equal(toolEntry?.sourceMetadata?.operation, "read");
  assert.equal((toolEntry?.sourceMetadata?.errorCount ?? 0) >= 1, true);
  assert.equal((toolEntry?.sourceMetadata?.warningCount ?? 0) >= 1, true);
  assert.equal(fileEntry?.sourceMetadata?.operation, "read");
  assert.equal(fileEntry?.sourceMetadata?.pathCount, 1);
  assert.equal(fileEntry?.sourceMetadata?.contentStored, false);
});

test("runtime compaction ledger preserves count and before/after usage after clearing stale entries", () => {
  resetSessionState("test", at(0));
  startSessionState({ reason: "startup", at: at(1), metadata: { sessionId: "s-compact" } });
  recordLedgerEntries({ at: at(2), entries: collectRuntimeMessage("message_end", { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: 222 }, { at: at(2) }).entries });

  updateSessionState({ event: "session_before_compact", at: at(3), usageSnapshot: { tokens: 1200, contextWindow: 2000, percent: 60, tokenConfidence: "estimated" } });
  updateSessionState({ event: "session_compact", at: at(4), usageSnapshot: { tokens: 450, contextWindow: 2000, percent: 22.5, tokenConfidence: "estimated" } });
  const compaction = collectRuntimeCompaction({ at: at(4), count: 1, before: { tokens: 1200, contextWindow: 2000, percent: 60, tokenConfidence: "estimated" }, after: { tokens: 450, contextWindow: 2000, percent: 22.5, tokenConfidence: "estimated" } });
  recordLedgerEntries({ at: at(4), entries: compaction.entries, warnings: compaction.warnings });

  const entries = getSessionState()?.ledgerEntries ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "compaction");
  assert.equal(entries[0]?.sourceMetadata?.compactionCount, 1);
  assert.equal(entries[0]?.sourceMetadata?.beforeTokens, 1200);
  assert.equal(entries[0]?.sourceMetadata?.afterTokens, 450);
  assert.equal(entries[0]?.sourceMetadata?.savedTokens, 750);
});

test("registered runtime handlers accumulate Session and Tools groups during normal work", () => {
  resetSessionState("test", at(0));
  const handlers = new Map<string, Function>();
  const commands = new Map<string, unknown>();
  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
  } as never);
  assert.equal(commands.has("pi-context"), true);
  const ctx = {
    cwd: "/repo",
    model: { id: "m", name: "mock", provider: "mock", contextWindow: 2000 },
    sessionManager: {
      getSessionId: () => "s-registered",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionDir: () => "/tmp",
      getCwd: () => "/repo",
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 2000, percent: 5 }),
  };

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: 1 }, ctx);
  handlers.get("input")?.({ type: "input", text: "please inspect", source: "interactive" }, ctx);
  handlers.get("message_end")?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 333 } }, ctx);
  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "write", args: { path: ".model-artifacts/report.md", content: "hello" } }, ctx);
  handlers.get("tool_result")?.({ type: "tool_result", toolCallId: "tc-2", toolName: "write", input: { path: ".model-artifacts/report.md", content: "hello" }, content: [{ type: "text", text: "ok" }], isError: false }, ctx);

  const snapshot = createContextSnapshot({ entries: getSessionState()?.ledgerEntries ?? [], contextWindowTokens: 2000 });
  assert.equal(snapshot.groups.some((group) => group.label === "Session" && group.entries.length > 0), true);
  assert.equal(snapshot.groups.some((group) => group.label === "Tools" && group.entries.length > 0), true);
  assert.equal(snapshot.groups.some((group) => group.label === "Discovered/Artifacts" && group.entries.some((entry) => entry.origin === ".model-artifacts/report.md")), true);
});
