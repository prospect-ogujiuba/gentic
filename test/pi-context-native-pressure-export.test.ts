import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  advanceNativeContextPressure,
  createNativeContextSnapshot,
  renderNativeContextJson,
  renderNativeContextMarkdown,
  renderNativeContextSummary,
  writeNativeContextExport,
} from "../extensions/pi-context/src/app/index.ts";
import {
  DEFAULT_CONTEXT_PRESSURE_POLICY,
  createContextPressureState,
} from "../extensions/pi-context/src/domain/index.ts";

const marker = "NATIVE_EXPORT_SECRET_MARKER";

function snapshotAt(remainingPercent: number) {
  return createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 100 - remainingPercent, contextWindow: 100, percent: 100 - remainingPercent }),
    getSystemPromptOptions: () => ({ cwd: `/private/${marker}`, customPrompt: marker }),
    sessionManager: { getBranch: () => [] },
  } as never, { capturedAt: "2026-09-14T03:00:00.000Z" });
}

test("native pressure keeps transition deduplication and hysteresis without retaining content", () => {
  let state = createContextPressureState();
  const notifications: string[] = [];
  let final = snapshotAt(40);

  for (const [remaining, now] of [[25, 1_000], [24, 2_000], [10, 3_000], [16, 4_000], [10, 5_000], [31, 6_000], [25, 7_000]] as const) {
    const transition = advanceNativeContextPressure(snapshotAt(remaining), state, DEFAULT_CONTEXT_PRESSURE_POLICY, now);
    state = transition.state;
    final = transition.snapshot;
    if (transition.notification) notifications.push(transition.notification);
  }

  assert.deepEqual(notifications, ["warning", "critical", "critical", "warning"]);
  assert.deepEqual(final.pressure, { available: true, level: "warning", remainingPercent: 25 });
  assert.doesNotMatch(JSON.stringify({ state, final }), new RegExp(marker));
});

test("content-safe Markdown and JSON are written only by an explicit export call", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-native-export-"));
  const reportDir = path.join(cwd, ".model-artifacts", "system", "reports", "pi-context");
  const snapshot = snapshotAt(25) as any;
  snapshot.secret = marker;
  snapshot.contributors[0].label = marker;
  snapshot.contributors[0].path = `/private/${marker}`;
  snapshot.diagnostics.push(marker);

  const rendered = [
    renderNativeContextSummary(snapshot),
    renderNativeContextMarkdown(snapshot),
    renderNativeContextJson(snapshot),
  ];
  assert.equal(fs.existsSync(reportDir), false, "snapshot creation and rendering have no filesystem side effects");
  for (const output of rendered) assert.doesNotMatch(output, new RegExp(marker));

  const markdown = writeNativeContextExport(snapshot, { cwd, format: "markdown" });
  assert.equal(fs.readdirSync(reportDir).length, 1);
  assert.match(markdown.relativePath, /\.model-artifacts[/\\]system[/\\]reports[/\\]pi-context[/\\].+\.md$/);
  assert.doesNotMatch(fs.readFileSync(markdown.path, "utf8"), new RegExp(marker));

  const json = writeNativeContextExport(snapshot, { cwd, format: "json" });
  assert.equal(fs.readdirSync(reportDir).length, 2);
  const payload = JSON.parse(fs.readFileSync(json.path, "utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["bounds", "branch", "capturedAt", "contributors", "diagnostics", "pressure", "schemaVersion", "usage"]);
  assert.deepEqual(payload.pressure, { available: true, level: "warning", remainingPercent: 25 });
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(marker));
});
