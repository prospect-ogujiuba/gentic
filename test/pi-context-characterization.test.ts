import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createNativeContextSnapshot,
  createPiContextHudSnapshot,
  renderNativeContextJson,
  renderNativeContextMarkdown,
  renderNativeContextSummary,
} from "../extensions/pi-context/src/app/index.ts";

const marker = "CHARACTERIZATION_SECRET_MARKER";

test("retained operator surfaces agree on remaining context, contributors, and pressure", () => {
  const snapshot = createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
    getSystemPromptOptions: () => ({ cwd: marker, contextFiles: [
      { path: marker, content: marker },
      { path: marker, content: marker },
    ] }),
    sessionManager: { getBranch: () => [
      { type: "message", id: marker, parentId: null, timestamp: marker, message: { role: "assistant", content: marker } },
      { type: "message", id: marker, parentId: null, timestamp: marker, message: { role: "assistant", content: marker } },
    ] },
  } as never, { capturedAt: "2026-09-14T04:00:00.000Z" });
  const hud = createPiContextHudSnapshot(snapshot);
  const outputs = [renderNativeContextSummary(snapshot), renderNativeContextMarkdown(snapshot), renderNativeContextJson(snapshot), JSON.stringify(hud)];

  assert.equal(snapshot.usage.remainingTokens, 25);
  assert.equal(snapshot.pressure.level, "warning");
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "context-files")?.itemCount, 2);
  assert.equal(snapshot.contributors.find(({ kind }) => kind === "assistant-messages")?.itemCount, 2);
  assert.equal(hud.remainingTokens, 25);
  assert.equal(hud.pressure.level, "warning");
  for (const output of outputs) assert.doesNotMatch(output, new RegExp(marker));
});

test("forensic ledger collectors identified by characterization are removed", () => {
  for (const path of [
    "extensions/pi-context/src/app/session-state.ts",
    "extensions/pi-context/src/domain/ledger.ts",
    "extensions/pi-context/src/pi/runtime-ledger.ts",
    "extensions/pi-context/src/pi/static-inventory.ts",
  ]) assert.equal(fs.existsSync(path), false, path);
});
