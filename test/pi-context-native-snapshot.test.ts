import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_SNAPSHOT_LIMITS,
  createNativeContextSnapshot,
  renderNativeContextSummary,
} from "../extensions/pi-context/src/app/index.ts";

const marker = "SENSITIVE_NATIVE_SNAPSHOT_MARKER";

function entry(type: string, value: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, id: `${marker}-id`, parentId: null, timestamp: marker, ...value };
}

function context(overrides: Record<string, unknown> = {}) {
  const calls = { usage: 0, prompt: 0, branch: 0 };
  const branch = overrides.branch ?? [
    entry("message", { message: { role: "user", content: marker } }),
    entry("message", { message: { role: "assistant", content: [{ type: "text", text: marker }] } }),
    entry("message", { message: { role: "toolResult", content: [{ type: "text", text: marker }] } }),
    entry("custom_message", { customType: marker, content: marker, display: true }),
  ];
  const prompt = overrides.prompt ?? {
    cwd: `/private/${marker}`,
    customPrompt: marker,
    appendSystemPrompt: marker,
    promptGuidelines: [marker],
    selectedTools: [marker],
    toolSnippets: { [marker]: marker },
    contextFiles: [{ path: `/private/${marker}`, content: marker }],
    skills: [{ name: marker, description: marker, filePath: marker, baseDir: marker, sourceInfo: {}, disableModelInvocation: false }],
  };

  return {
    calls,
    ctx: {
      getContextUsage: () => {
        calls.usage += 1;
        return overrides.usage ?? { tokens: 750, contextWindow: 1_000, percent: 75 };
      },
      getSystemPromptOptions: () => {
        calls.prompt += 1;
        if (overrides.promptError) throw new Error(`${marker}: prompt failure`);
        return prompt;
      },
      sessionManager: {
        getBranch: () => {
          calls.branch += 1;
          if (overrides.branchError) throw new Error(`${marker}: branch failure`);
          return branch;
        },
      },
    },
  };
}

test("builds remaining-context and broad contributor reporting from native APIs once", () => {
  const fixture = context();
  const snapshot = createNativeContextSnapshot(fixture.ctx as never, { capturedAt: "2026-09-14T02:30:00.000Z" });
  const summary = renderNativeContextSummary(snapshot);

  assert.deepEqual(fixture.calls, { usage: 1, prompt: 1, branch: 1 });
  assert.deepEqual(snapshot.usage, {
    usedTokens: 750,
    contextWindowTokens: 1_000,
    remainingTokens: 250,
    remainingPercent: 25,
  });
  assert.deepEqual(snapshot.contributors.map((contributor) => contributor.kind), [
    "system-prompt",
    "active-tools",
    "context-files",
    "skills",
    "user-messages",
    "assistant-messages",
    "tool-results",
    "other-session",
  ]);
  assert.match(summary, /Remaining: 250 of 1,000 tokens \(25%\)/);
  assert.match(summary, /Context files: .*1 item/);
});

test("pressure-only native snapshots skip prompt and branch contributor scans", () => {
  const fixture = context({ promptError: true, branchError: true });
  const snapshot = createNativeContextSnapshot(fixture.ctx as never, { collectContributors: false });

  assert.deepEqual(fixture.calls, { usage: 1, prompt: 0, branch: 0 });
  assert.deepEqual(snapshot.contributors, []);
  assert.deepEqual(snapshot.branch, { totalEntries: 0, scannedEntries: 0, truncated: false });
  assert.deepEqual(snapshot.diagnostics, []);
  assert.deepEqual(snapshot.pressure, { available: true, level: "warning", remainingPercent: 25 });
});

test("invalid native usage remains unavailable instead of being clamped into pressure", () => {
  const invalidPercent = createNativeContextSnapshot(context({ usage: { percent: 150 } }).ctx as never, { collectContributors: false });
  assert.deepEqual(invalidPercent.usage, {
    usedTokens: undefined,
    contextWindowTokens: undefined,
    remainingTokens: undefined,
    remainingPercent: undefined,
  });
  assert.deepEqual(invalidPercent.pressure, { available: false, level: "unavailable" });
  assert.ok(invalidPercent.diagnostics.includes("usage-unavailable"));

  const invalidTokens = createNativeContextSnapshot(context({
    usage: { tokens: 101, contextWindow: 100, percent: 101 },
  }).ctx as never, { collectContributors: false });
  assert.equal(invalidTokens.usage.remainingTokens, undefined);
  assert.equal(invalidTokens.usage.remainingPercent, undefined);
  assert.deepEqual(invalidTokens.pressure, { available: false, level: "unavailable" });
});

test("snapshot and summary retain only numeric aggregates and fixed labels", () => {
  const fixture = context();
  const snapshot = createNativeContextSnapshot(fixture.ctx as never);
  const output = JSON.stringify({ snapshot, summary: renderNativeContextSummary(snapshot) });

  assert.doesNotMatch(output, new RegExp(marker));
  for (const contributor of snapshot.contributors) {
    assert.deepEqual(Object.keys(contributor).sort(), ["byteCount", "itemCount", "kind", "tokenCount"]);
  }

  const failed = context({ promptError: true, branchError: true });
  const failedSnapshot = createNativeContextSnapshot(failed.ctx as never);
  assert.deepEqual(failedSnapshot.diagnostics, ["prompt-options-unavailable", "branch-unavailable"]);
  assert.doesNotMatch(JSON.stringify(failedSnapshot), new RegExp(marker));
});

test("hostile array lengths are clamped before branch index arithmetic", () => {
  let entryReads = 0;
  const branch = new Proxy([], {
    get(target, key, receiver) {
      if (key === "length") return 1e16;
      if (typeof key === "string" && /^\d+$/.test(key)) {
        entryReads += 1;
        return entry("message", { message: { role: "user", content: marker } });
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const snapshot = createNativeContextSnapshot(context({ branch }).ctx as never);

  assert.deepEqual(snapshot.branch, {
    totalEntries: Number.MAX_SAFE_INTEGER,
    scannedEntries: NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned,
    truncated: true,
  });
  assert.equal(entryReads, NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned);
});

test("caps every input dimension and reports truncation for oversized hostile values", () => {
  const cyclic: Record<string, unknown> = { text: marker.repeat(NATIVE_SNAPSHOT_LIMITS.maxMeasuredCharsPerValue + 1) };
  cyclic.self = cyclic;
  const branch = Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxBranchEntriesScanned + 88 }, () =>
    entry("message", { message: { role: "user", content: Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxContentBlocksPerValue + 1 }, () => cyclic) } }),
  );
  const prompt = {
    cwd: marker,
    promptGuidelines: Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxPromptGuidelinesScanned + 1 }, () => marker),
    selectedTools: Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxToolsScanned + 1 }, (_, index) => `${marker}-${index}`),
    contextFiles: Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxContextFilesScanned + 1 }, () => ({ path: marker, content: marker })),
    skills: Array.from({ length: NATIVE_SNAPSHOT_LIMITS.maxSkillsScanned + 1 }, () => ({ name: marker, description: marker })),
  };
  const fixture = context({ branch, prompt });
  const snapshot = createNativeContextSnapshot(fixture.ctx as never);

  assert.deepEqual(fixture.calls, { usage: 1, prompt: 1, branch: 1 });
  assert.deepEqual(snapshot.branch, { totalEntries: branch.length, scannedEntries: 512, truncated: true });
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "context-files")?.itemCount, 64);
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "skills")?.itemCount, 64);
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "active-tools")?.itemCount, 64);
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "user-messages")?.itemCount, 512);
  assert.ok(snapshot.diagnostics.includes("branch-truncated"));
  assert.ok(snapshot.diagnostics.includes("prompt-options-truncated"));
  assert.ok(snapshot.diagnostics.includes("content-truncated"));
  assert.ok(snapshot.diagnostics.length <= NATIVE_SNAPSHOT_LIMITS.maxDiagnostics);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
});
