import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_TELEMETRY_LIMITS,
  type ContextTelemetrySnapshotInput,
} from "../src/contracts/context-telemetry.ts";
import {
  createContextTelemetrySnapshot,
  sanitizeContextTelemetrySnapshot,
} from "../src/services/context-telemetry.ts";

const marker = "TELEMETRY_SERVICE_SECRET_MARKER";

test("package service builds the bounded content-free context telemetry contract", () => {
  const input = {
    capturedAt: "2026-09-14T05:00:00.000Z",
    usage: { usedTokens: 75, contextWindowTokens: 100, remainingTokens: 25, remainingPercent: 25 },
    pressure: { available: true, level: "warning", remainingPercent: 25 },
    contributorDetail: "degraded",
    contributors: [{ kind: "context-files", itemCount: 2, byteCount: 400, tokenCount: 100 }],
    branch: { totalEntries: 2, scannedEntries: 2, truncated: false },
    diagnostics: ["contributors-degraded"],
  } satisfies ContextTelemetrySnapshotInput;

  const snapshot = createContextTelemetrySnapshot(input);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.contributorDetail, "degraded");
  assert.equal(snapshot.bounds, CONTEXT_TELEMETRY_LIMITS);
  assert.deepEqual(snapshot.contributors, input.contributors);
  assert.doesNotMatch(JSON.stringify(snapshot), /(?:content|prompt|message|path|toolInput)\s*:/i);
});

test("package service bounds untyped consumers and never traverses extra content", () => {
  let secretReads = 0;
  const secret = {};
  Object.defineProperty(secret, "content", {
    enumerable: true,
    get() { secretReads += 1; return marker; },
  });
  const contributors = Array.from({ length: CONTEXT_TELEMETRY_LIMITS.maxContributors + 20 }, () => ({
    kind: "user-messages",
    itemCount: 1,
    byteCount: 4,
    tokenCount: 1,
    secret,
  }));
  const snapshot = sanitizeContextTelemetrySnapshot({
    capturedAt: "2026-09-14T05:00:00.000Z",
    contributorDetail: "degraded",
    contributors,
    diagnostics: Array.from({ length: 20 }, () => "contributors-degraded"),
    secret,
  });

  assert.equal(snapshot.contributors.length, CONTEXT_TELEMETRY_LIMITS.maxContributors);
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(secretReads, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(marker));
});
