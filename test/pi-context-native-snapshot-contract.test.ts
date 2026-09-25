import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  EXCLUDED_RUNTIME_LEDGER_EVENTS,
  NATIVE_SNAPSHOT_LIMITS,
  NATIVE_SNAPSHOT_SOURCES,
  createNativeContextSnapshot,
  type NativeContextSnapshot,
  type NativeSnapshotContext,
} from "../extensions/pi-context/src/app/index.ts";
import { registerPiContext } from "../extensions/pi-context/src/pi/index.ts";

test("native snapshot design is limited to command-safe Pi sources", () => {
  assert.deepEqual(NATIVE_SNAPSHOT_SOURCES, [
    "ctx.getContextUsage()",
    "ctx.getSystemPromptOptions()",
    "ctx.sessionManager.getBranch()",
  ]);

  const compileTimeContextContract = (_ctx: NativeSnapshotContext): void => undefined;
  assert.equal(typeof compileTimeContextContract, "function");
});

test("native snapshot work and retained output have explicit constant bounds", () => {
  assert.deepEqual(NATIVE_SNAPSHOT_LIMITS, {
    maxBranchEntriesScanned: 512,
    maxContextFilesScanned: 64,
    maxSkillsScanned: 64,
    maxToolsScanned: 64,
    maxPromptGuidelinesScanned: 64,
    maxContentBlocksPerValue: 64,
    maxMeasuredCharsPerValue: 65_536,
    maxContributors: 8,
    maxDiagnostics: 4,
  });
  assert.equal(Object.isFrozen(NATIVE_SNAPSHOT_LIMITS), true);

  const maximumInspectedItems =
    NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned
    + NATIVE_SNAPSHOT_LIMITS.maxContextFilesScanned
    + NATIVE_SNAPSHOT_LIMITS.maxSkillsScanned
    + NATIVE_SNAPSHOT_LIMITS.maxToolsScanned
    + NATIVE_SNAPSHOT_LIMITS.maxPromptGuidelinesScanned;
  assert.equal(maximumInspectedItems, 768);
});

test("public snapshot schema contains aggregates and fixed diagnostics, not sensitive content", () => {
  const snapshot = {
    schemaVersion: 1,
    capturedAt: "2026-09-14T02:03:00.000Z",
    usage: { usedTokens: 750, contextWindowTokens: 1_000, remainingTokens: 250, remainingPercent: 25 },
    pressure: { available: true, level: "warning", remainingPercent: 25 },
    contributorDetail: "degraded",
    contributors: [{ kind: "context-files", itemCount: 2, byteCount: 400, tokenCount: 100 }],
    branch: { totalEntries: 900, scannedEntries: 512, truncated: true },
    diagnostics: ["contributors-degraded", "branch-truncated"],
    bounds: NATIVE_SNAPSHOT_LIMITS,
  } satisfies NativeContextSnapshot;

  assert.deepEqual(Object.keys(snapshot).sort(), ["bounds", "branch", "capturedAt", "contributorDetail", "contributors", "diagnostics", "pressure", "schemaVersion", "usage"]);
  assert.deepEqual(Object.keys(snapshot.contributors[0]!).sort(), ["byteCount", "itemCount", "kind", "tokenCount"]);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /"(?:content|prompt|preview|path|credential|secret|messageId|toolCallId|sessionId|providerId)"\s*:/i,
  );
});

test("native compatibility input reports contributor degradation explicitly", () => {
  const snapshot = createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 50, contextWindow: 100, percent: 50 }),
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "/private/secret", content: "secret" }] }),
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "secret" } }] },
  } as never, { capturedAt: "2026-09-14T02:03:00.000Z" });

  assert.equal(snapshot.contributorDetail, "degraded");
  assert.ok(snapshot.diagnostics.includes("contributors-degraded"));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private/);
});

test("native adapter has no arbitrary-object traversal machinery", () => {
  const source = fs.readFileSync(new URL("../extensions/pi-context/src/app/native-snapshot.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:measureValue|WeakSet|Object\.keys)\b|for\s*\(\s*const\s+\w+\s+in\s+/);
  assert.match(source, /createContextTelemetrySnapshot/);
});

test("runtime meets the design target for streaming and per-tool subscriptions", () => {
  const registered = new Set<string>();
  registerPiContext({ on: (event: string) => registered.add(event), registerCommand: () => undefined } as never);

  assert.equal(registered.size, 4, "reduced from the measured 26-subscription legacy baseline");
  assert.equal(EXCLUDED_RUNTIME_LEDGER_EVENTS.length, 7);
  assert.equal(EXCLUDED_RUNTIME_LEDGER_EVENTS.some((event) => registered.has(event)), false);
  assert.deepEqual(
    EXCLUDED_RUNTIME_LEDGER_EVENTS.filter((event) => event.endsWith("_update")),
    ["message_update", "tool_execution_update"],
  );
});
