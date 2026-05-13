import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCompactionStats,
  calculateTotals,
  createContextSnapshot,
  groupLedgerEntries,
  normalizeLedgerEntry,
  upsertLedgerEntry,
} from "../extensions/pi-context/src/domain/index.ts";
import type { ContextLedgerEntry } from "../extensions/pi-context/src/domain/index.ts";

const at = (minute: number) => `2026-05-13T00:${String(minute).padStart(2, "0")}:00.000Z`;

test("ledger entries represent requested report groups", () => {
  const kinds = ["system", "user", "project", "extension", "session", "tool", "artifact", "discovered"] as const;
  const groups = groupLedgerEntries(
    kinds.map((kind, index) =>
      normalizeLedgerEntry({ id: kind, kind, label: kind, byteCount: index + 1, tokenCount: index + 1, tokenConfidence: "exact", seenAt: at(index) }),
    ),
  );

  assert.deepEqual(
    groups.map((group) => group.label),
    ["System", "User", "Project", "Extensions", "Session", "Tools", "Discovered/Artifacts"],
  );
  assert.equal(groups.at(-1)?.entries.length, 2, "artifact and discovered entries share the report group");
});

test("duplicate source updates merge identity and keep latest counts", () => {
  let entries: ContextLedgerEntry[] = [];
  entries = upsertLedgerEntry(entries, { id: "project-readme", kind: "project", label: "README", byteCount: 40, tokenCount: 10, tokenConfidence: "exact", seenAt: at(1), turnId: "turn-1" });
  entries = upsertLedgerEntry(entries, { id: "project-readme", kind: "project", label: "README", byteCount: 80, seenAt: at(2), messageId: "msg-2" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.byteCount, 80);
  assert.equal(entries[0]?.tokenCount, 20);
  assert.equal(entries[0]?.tokenConfidence, "estimated");
  assert.equal(entries[0]?.firstSeenAt, at(1));
  assert.equal(entries[0]?.lastSeenAt, at(2));
  assert.deepEqual(entries[0]?.turnIds, ["turn-1"]);
  assert.deepEqual(entries[0]?.messageIds, ["msg-2"]);
});

test("grouped totals preserve exact and estimated token confidence", () => {
  const entries = [
    normalizeLedgerEntry({ id: "sys", kind: "system", byteCount: 8, tokenCount: 2, tokenConfidence: "exact", seenAt: at(1) }),
    normalizeLedgerEntry({ id: "tool", kind: "tool", byteCount: 12, seenAt: at(2) }),
  ];

  const totals = calculateTotals(entries);
  const groups = groupLedgerEntries(entries);

  assert.deepEqual(totals, {
    byteCount: 20,
    tokenCount: 5,
    exactTokenCount: 2,
    estimatedTokenCount: 3,
    unknownTokenEntries: 0,
    tokenConfidence: "estimated",
  });
  assert.equal(groups.find((group) => group.kind === "tool")?.tokenConfidence, "estimated");
});

test("snapshot handles unknown context window without inventing remaining tokens", () => {
  const snapshot = createContextSnapshot({
    entries: [normalizeLedgerEntry({ id: "session", kind: "session", byteCount: 16, seenAt: at(1) })],
    capturedAt: at(3),
  });

  assert.equal(snapshot.contextWindowTokens, undefined);
  assert.equal(snapshot.remaining.totalTokens, undefined);
  assert.equal(snapshot.remaining.remainingTokens, undefined);
  assert.match(snapshot.warnings.join("\n"), /context window is unknown/);
  assert.match(snapshot.warnings.join("\n"), /token totals include deterministic estimates/);
});

test("compaction deltas report saved tokens", () => {
  assert.deepEqual(calculateCompactionStats(1200, 450), {
    beforeTokens: 1200,
    afterTokens: 450,
    deltaTokens: -750,
    savedTokens: 750,
    tokenConfidence: "exact",
  });
  assert.deepEqual(calculateCompactionStats(undefined, 450), {
    beforeTokens: undefined,
    afterTokens: 450,
    deltaTokens: undefined,
    savedTokens: undefined,
    tokenConfidence: "unknown",
  });
});
