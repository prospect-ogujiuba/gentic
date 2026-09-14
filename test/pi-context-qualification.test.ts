import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCLUDED_RUNTIME_LEDGER_EVENTS,
  NATIVE_SNAPSHOT_LIMITS,
  createNativeContextSnapshot,
  createPiContextHudSnapshot,
  renderNativeContextJson,
  renderNativeContextMarkdown,
  renderNativeContextSummary,
} from "../extensions/pi-context/src/app/index.ts";
import { registerPiContext } from "../extensions/pi-context/src/pi/index.ts";

const marker = "QUALIFICATION_SECRET_MARKER";

function hostileObject(): object {
  return new Proxy({}, {
    ownKeys() { throw new Error(marker); },
    getOwnPropertyDescriptor() { throw new Error(marker); },
    get() { throw new Error(marker); },
  });
}

test("hostile usage and public snapshot accessors fail closed without exposing errors", () => {
  const throwing = new Proxy({}, {
    get() { throw new Error(marker); },
    ownKeys() { throw new Error(marker); },
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });
  const snapshot = createNativeContextSnapshot({
    getContextUsage: () => throwing,
    getSystemPromptOptions: () => ({}),
    sessionManager: { getBranch: () => [] },
  } as never, { capturedAt: "2026-09-14T03:00:00.000Z" });
  assert.ok(snapshot.diagnostics.includes("usage-unavailable"));

  for (const key of ["usage", "pressure", "branch", "contributors", "diagnostics"] as const) {
    const hostile = { ...snapshot, [key]: throwing };
    const outputs = [
      renderNativeContextSummary(hostile as never),
      renderNativeContextMarkdown(hostile as never),
      renderNativeContextJson(hostile as never),
      JSON.stringify(createPiContextHudSnapshot(hostile as never)),
    ];
    for (const output of outputs) assert.doesNotMatch(output, new RegExp(marker));
  }
});

test("qualified snapshot, HUD, exports, and registration stay bounded and content-safe", () => {
  const registrations: string[] = [];
  registerPiContext({
    on: (event: string) => registrations.push(event),
    registerCommand: () => undefined,
  } as never);

  const oversized = marker.repeat(NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue + 1);
  let propertyReads = 0;
  const manyProperties: Record<string, unknown> = {};
  for (let index = 0; index < NATIVE_SNAPSHOT_LIMITS.maxObjectPropertiesPerValue + 100; index += 1) {
    Object.defineProperty(manyProperties, `${marker}-${index}`, {
      enumerable: true,
      get() { propertyReads += 1; return marker; },
    });
  }
  const invalidLengthArray = new Proxy([], {
    get(target, key, receiver) { return key === "length" ? Symbol(marker) : Reflect.get(target, key, receiver); },
  });
  const branch = Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned + 100 }, (_, index) => {
    if (index === 100) return new Proxy({}, { get() { throw new Error(marker); } });
    return {
      type: "message",
      id: `${marker}-${index}`,
      parentId: marker,
      timestamp: marker,
      message: {
        role: index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult",
        content: index === 101
          ? hostileObject()
          : index === 102
            ? manyProperties
            : index === 103
              ? invalidLengthArray
              : [{ type: marker, text: oversized, toolCallId: marker, arguments: marker }],
      },
    };
  });
  const promptOptions: Record<string, unknown> = {
    cwd: `/private/${marker}`,
    appendSystemPrompt: marker,
    promptGuidelines: Array.from({ length: 65 }, () => marker),
    selectedTools: Array.from({ length: 65 }, (_, index) => `${marker}-${index}`),
    toolSnippets: hostileObject(),
    contextFiles: Array.from({ length: 65 }, () => ({ path: marker, content: oversized })),
    skills: Array.from({ length: 65 }, () => ({ name: marker, description: oversized, filePath: marker })),
  };
  Object.defineProperty(promptOptions, "customPrompt", { enumerable: true, get() { throw new Error(marker); } });
  const snapshot = createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
    getSystemPromptOptions: () => promptOptions,
    sessionManager: { getBranch: () => branch },
  } as never, { capturedAt: "2026-09-14T03:00:00.000Z" });

  const hud = createPiContextHudSnapshot(snapshot, { topContributors: Number.POSITIVE_INFINITY });
  const outputs = [
    JSON.stringify(snapshot),
    renderNativeContextSummary(snapshot),
    JSON.stringify(hud),
    renderNativeContextMarkdown(snapshot),
    renderNativeContextJson(snapshot),
  ];

  assert.deepEqual(registrations, ["session_start", "turn_end", "session_compact", "session_shutdown"]);
  assert.equal(EXCLUDED_RUNTIME_LEDGER_EVENTS.some((event) => registrations.includes(event)), false);
  assert.deepEqual(snapshot.branch, { totalEntries: branch.length, scannedEntries: 512, truncated: true });
  assert.ok(snapshot.contributors.length <= NATIVE_SNAPSHOT_LIMITS.maxContributors);
  assert.ok(snapshot.diagnostics.length <= NATIVE_SNAPSHOT_LIMITS.maxDiagnostics);
  assert.ok(snapshot.diagnostics.includes("content-truncated"));
  assert.equal(propertyReads, NATIVE_SNAPSHOT_LIMITS.maxObjectPropertiesPerValue);
  assert.ok(hud.contributors.length <= 5);
  assert.ok(hud.warnings.length <= NATIVE_SNAPSHOT_LIMITS.maxDiagnostics);
  for (const output of outputs) assert.doesNotMatch(output, new RegExp(marker));
});
