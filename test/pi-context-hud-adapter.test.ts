import test from "node:test";
import assert from "node:assert/strict";

import { createPiContextHudSnapshot } from "../extensions/pi-context/src/app/index.ts";
import { normalizeLedgerEntry } from "../extensions/pi-context/src/domain/index.ts";
import { renderPiContextLedgerDetails, renderPiContextLedgerSummary } from "../extensions/pi-hud/components/context.ts";
import type { Theme } from "../extensions/pi-hud/types.ts";

const theme: Theme = { fg: (_color: unknown, text: string) => text };
const at = (second: number) => `2026-05-13T04:00:${String(second).padStart(2, "0")}.000Z`;

function activeState(entries: ReturnType<typeof normalizeLedgerEntry>[]) {
  return {
    active: true,
    generation: 1,
    startedAt: at(0),
    lastUpdatedAt: at(9),
    metadata: { contextWindow: 1000 },
    ledgerEntries: entries,
    usageSnapshots: [],
    lifecycleEvents: [],
    beforeFirstProviderRequest: false,
    warnings: ["one", "two", "three", "four"],
  };
}

test("hud adapter returns bounded stable summary without raw paths or prompts", () => {
  const snapshot = createPiContextHudSnapshot(
    activeState([
      normalizeLedgerEntry({ id: "path", kind: "discovered", label: "/home/user/private/file.ts", origin: "/home/user/private/file.ts", byteCount: 400, seenAt: at(1), sourceMetadata: { displayPath: "/home/user/private/file.ts", pathCount: 1, contentStored: false } }),
      normalizeLedgerEntry({ id: "prompt", kind: "system", label: "secret prompt args preview", byteCount: 300, seenAt: at(2), redaction: { redacted: true, reason: "content is not stored", originalByteCount: 300 } }),
      normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool execution", byteCount: 200, tokenCount: 50, tokenConfidence: "exact", seenAt: at(3), sourceMetadata: { toolName: "bash", argumentByteCount: 200, resultByteCount: 300 } }),
      normalizeLedgerEntry({ id: "small", kind: "session", label: "assistant message", byteCount: 16, seenAt: at(4) }),
    ]),
    { capturedAt: at(10), topContributors: 2 },
  );

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.contributors.length, 2);
  assert.deepEqual(snapshot.contributors.map((entry) => entry.label), ["Discovered/Artifacts", "System"]);
  assert.equal(JSON.stringify(snapshot).includes("/home/user/private"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret prompt args preview"), false);
  assert.equal(snapshot.warnings.length, 3);
  assert.equal(snapshot.truncatedWarnings >= 1, true);
});

test("hud adapter clamps top contributors and keeps compaction totals", () => {
  const entries = Array.from({ length: 10 }, (_value, index) => normalizeLedgerEntry({ id: `tool-${index}`, kind: "tool", label: `tool ${index}`, byteCount: 20 + index, seenAt: at(index) }));
  entries.push(normalizeLedgerEntry({ id: "compact", kind: "compaction", label: "compaction 1", byteCount: 0, tokenCount: 0, tokenConfidence: "estimated", seenAt: at(8), sourceMetadata: { resourceType: "compaction", beforeTokens: 900, afterTokens: 300, savedTokens: 600 } }));

  const snapshot = createPiContextHudSnapshot(activeState(entries), { topContributors: 99 });

  assert.equal(snapshot.contributors.length, 5);
  assert.equal(snapshot.recentCompaction?.savedTokens, 600);
  assert.equal(snapshot.largestGroup?.label, "Tools");
});

test("pi-hud renders pi-context pressure from shared adapter", () => {
  const piContext = createPiContextHudSnapshot(activeState([normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool output", byteCount: 400, seenAt: at(1) })]));
  const hud = { worktreeId: ".", usage: { contextTokens: 100, contextWindow: 1000, contextPct: 10 }, piContext, activeTools: [], toolCounts: {}, recentEvents: [] };

  assert.match(renderPiContextLedgerSummary(hud, theme), /ledger 100 left 900 hot Tools/);
  assert.match(renderPiContextLedgerDetails(hud, theme).join("\n"), /contributors/);
});
