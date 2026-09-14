import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  advanceNativeContextPressure,
  createNativeContextSnapshot,
  createPiContextHudSnapshot,
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
const CUSTOM_POLICY = Object.freeze({
  warningPercent: 20,
  criticalPercent: 8,
  hysteresisPercent: 3,
});

function snapshotAt(remainingPercent: number, pressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY) {
  return createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 100 - remainingPercent, contextWindow: 100, percent: 100 - remainingPercent }),
    getSystemPromptOptions: () => ({ cwd: `/private/${marker}`, customPrompt: marker }),
    sessionManager: { getBranch: () => [] },
  } as never, { capturedAt: "2026-09-14T03:00:00.000Z", pressurePolicy });
}

test("configured policy is consistent across native summary, export, and HUD data", () => {
  const snapshot = snapshotAt(20, CUSTOM_POLICY);
  const summary = renderNativeContextSummary(snapshot);
  const exported = JSON.parse(renderNativeContextJson(snapshot));
  const hud = createPiContextHudSnapshot(snapshot);

  assert.deepEqual(snapshot.pressure, { available: true, level: "warning", remainingPercent: 20 });
  assert.match(summary, /Remaining: 20 of 100 tokens \(20%\)/);
  assert.match(summary, /Pressure: warning \(20% remaining\)/);
  assert.deepEqual(exported.pressure, snapshot.pressure);
  assert.deepEqual(hud.pressure, snapshot.pressure);
  assert.equal(hud.tokenConfidence, "estimated");
});

test("native pressure keeps transition deduplication and hysteresis without retaining content", () => {
  let state = createContextPressureState();
  const notifications: string[] = [];
  let final = snapshotAt(40);

  for (const [remaining, now] of [[25, 1_000], [24, 2_000], [10, 3_000], [16, 4_000], [10, 5_000], [31, 6_000], [25, 7_000]] as const) {
    const transition = advanceNativeContextPressure(snapshotAt(remaining), state, DEFAULT_CONTEXT_PRESSURE_POLICY);
    state = transition.state;
    final = transition.snapshot;
    if (transition.notification) notifications.push(transition.notification);
  }

  assert.deepEqual(notifications, ["warning", "critical", "critical", "warning"]);
  assert.deepEqual(final.pressure, { available: true, level: "warning", remainingPercent: 25 });
  assert.doesNotMatch(JSON.stringify({ state, final }), new RegExp(marker));
});

test("explicit export rejects symlinked report ancestors and destinations", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-export-containment-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-export-outside-"));
  try {
    const reportParent = path.join(cwd, ".model-artifacts", "system", "reports");
    fs.mkdirSync(reportParent, { recursive: true });
    fs.symlinkSync(outside, path.join(reportParent, "pi-context"), "dir");
    assert.throws(() => writeNativeContextExport(snapshotAt(25), { cwd, format: "markdown" }), /symlink|containment/i);
    assert.deepEqual(fs.readdirSync(outside), []);

    fs.rmSync(path.join(reportParent, "pi-context"));
    fs.mkdirSync(path.join(reportParent, "pi-context"));
    const outsideFile = path.join(outside, "protected.md");
    fs.writeFileSync(outsideFile, marker);
    const destination = path.join(reportParent, "pi-context", "2026-09-14_0300-pi-context-00-000.md");
    fs.symlinkSync(outsideFile, destination, "file");
    assert.throws(() => writeNativeContextExport(snapshotAt(25), { cwd, format: "markdown" }), /exist|symlink|containment/i);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), marker);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
  assert.match(markdown.relativePath, /\.model-artifacts[/\\]system[/\\]reports[/\\]pi-context[/\\]\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
  assert.doesNotMatch(fs.readFileSync(markdown.path, "utf8"), new RegExp(marker));

  const json = writeNativeContextExport(snapshot, { cwd, format: "json" });
  assert.equal(fs.readdirSync(reportDir).length, 2);
  const payload = JSON.parse(fs.readFileSync(json.path, "utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["bounds", "branch", "capturedAt", "contributors", "diagnostics", "pressure", "schemaVersion", "usage"]);
  assert.deepEqual(payload.pressure, { available: true, level: "warning", remainingPercent: 25 });
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(marker));
});
