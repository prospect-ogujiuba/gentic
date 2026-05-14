import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createPiContextReportSnapshot,
  parsePiContextReportArgs,
  renderPiContextJson,
  renderPiContextMarkdown,
  renderPiContextSummary,
  resetSessionState,
  startSessionState,
  recordLedgerEntries,
  writePiContextReportArtifact,
} from "../extensions/pi-context/src/app/index.ts";
import { normalizeLedgerEntry } from "../extensions/pi-context/src/domain/index.ts";
import { registerPiContext } from "../extensions/pi-context/src/pi/index.ts";

const at = (minute: number) => `2026-05-13T02:${String(minute).padStart(2, "0")}:00.000Z`;

test("report summary keeps grouped order and estimate labels", () => {
  const snapshot = createPiContextReportSnapshot(
    {
      active: true,
      generation: 1,
      startedAt: at(0),
      lastUpdatedAt: at(3),
      metadata: { contextWindow: 1000 },
      ledgerEntries: [
        normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool output", byteCount: 40, seenAt: at(2) }),
        normalizeLedgerEntry({ id: "system", kind: "system", label: "system prompt", byteCount: 20, tokenCount: 5, tokenConfidence: "exact", seenAt: at(1) }),
        normalizeLedgerEntry({ id: "extension", kind: "extension", label: "skill", byteCount: 12, tokenCount: 3, tokenConfidence: "exact", seenAt: at(1) }),
      ],
      usageSnapshots: [],
      lifecycleEvents: [],
      beforeFirstProviderRequest: false,
      warnings: [],
    },
    { capturedAt: at(4) },
  );

  const text = renderPiContextSummary(snapshot);
  assert.match(text, /Total: 18 tokens estimated/);
  assert.match(text, /Warnings:[\s\S]*ledger token totals include deterministic estimates/);
  assert.ok(text.indexOf("- System:") < text.indexOf("- Extensions:"));
  assert.ok(text.indexOf("- Extensions:") < text.indexOf("- Tools:"));
});

test("report uses exact current usage for context and remaining", () => {
  const snapshot = createPiContextReportSnapshot(
    {
      active: true,
      generation: 1,
      startedAt: at(0),
      lastUpdatedAt: at(2),
      metadata: { contextWindow: 1000 },
      ledgerEntries: [normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool output", byteCount: 400, seenAt: at(1) })],
      usageSnapshots: [{ capturedAt: at(2), event: "context", tokens: 123, contextWindow: 1000, percent: 12.3, tokenConfidence: "exact" }],
      lifecycleEvents: [],
      beforeFirstProviderRequest: false,
      warnings: [],
    },
    { capturedAt: at(3) },
  );

  const text = renderPiContextSummary(snapshot);
  assert.match(text, /Context: 123 of 1,000 tokens exact/);
  assert.match(text, /Remaining: 877 of 1,000 tokens exact/);
  assert.match(text, /Ledger inventory: 100 tokens estimated/);
  assert.match(renderPiContextMarkdown(snapshot), /Current context: 123 of 1,000 tokens exact/);
});

test("report filters only requested groups", () => {
  const request = parsePiContextReportArgs("summary tools extensions");
  assert.equal(request.mode, "summary");
  assert.deepEqual(request.groups, ["tool", "extension"]);

  const snapshot = createPiContextReportSnapshot(
    {
      active: true,
      generation: 1,
      startedAt: at(0),
      lastUpdatedAt: at(2),
      metadata: { contextWindow: 1000 },
      ledgerEntries: [
        normalizeLedgerEntry({ id: "system", kind: "system", label: "system prompt", byteCount: 4, tokenCount: 1, tokenConfidence: "exact", seenAt: at(1) }),
        normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool output", byteCount: 8, tokenCount: 2, tokenConfidence: "exact", seenAt: at(1) }),
      ],
      usageSnapshots: [],
      lifecycleEvents: [],
      beforeFirstProviderRequest: false,
      warnings: [],
    },
    { capturedAt: at(3) },
  );

  const text = renderPiContextSummary(snapshot, request);
  assert.doesNotMatch(text, /- System:/);
  assert.match(text, /- Tools:/);
});

test("artifact writer creates deterministic markdown and json paths", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-report-"));
  const snapshot = createPiContextReportSnapshot(undefined, { capturedAt: "2026-05-13T02:05:06.000Z" });

  const markdown = writePiContextReportArtifact(snapshot, { artifactFormat: "markdown" }, { cwd });
  const json = writePiContextReportArtifact(snapshot, { artifactFormat: "json" }, { cwd });

  assert.equal(markdown.relativePath, path.join(".model-artifacts", "todo", "pi-context", "reports", "pi-context-2026-05-13T02-05-06-000Z.md"));
  assert.equal(json.relativePath, path.join(".model-artifacts", "todo", "pi-context", "reports", "pi-context-2026-05-13T02-05-06-000Z.json"));
  assert.match(fs.readFileSync(markdown.path, "utf8"), /# pi-context report/);
  assert.equal(JSON.parse(fs.readFileSync(json.path, "utf8")).schemaVersion, 1);
});

test("markdown and json reports include details safe for todo evidence", () => {
  resetSessionState("test", at(0));
  startSessionState({ reason: "test", at: at(0), metadata: { contextWindow: 1000 } });
  const state = recordLedgerEntries({
    at: at(1),
    entries: [normalizeLedgerEntry({ id: "artifact", kind: "artifact", label: "phase note", byteCount: 16, tokenCount: 4, tokenConfidence: "exact", seenAt: at(1), sourceMetadata: { displayPath: ".model-artifacts/todo/pi-context/phases/06.md", resourceType: "artifact" } })],
  });
  const snapshot = createPiContextReportSnapshot(state, { capturedAt: at(2) });

  assert.match(renderPiContextMarkdown(snapshot), /phase note/);
  assert.match(renderPiContextMarkdown(snapshot), /\.model-artifacts\/todo\/pi-context\/phases\/06\.md/);
  const payload = JSON.parse(renderPiContextJson(snapshot));
  assert.equal(payload.groups[0].label, "Discovered/Artifacts");
});

test("registered command writes json artifact from maintained snapshot", async () => {
  resetSessionState("test", at(0));
  startSessionState({ reason: "test", at: at(0), metadata: { contextWindow: 1000 } });
  recordLedgerEntries({
    at: at(1),
    entries: [normalizeLedgerEntry({ id: "tool", kind: "tool", label: "tool result", byteCount: 8, tokenCount: 2, tokenConfidence: "exact", seenAt: at(1) })],
  });

  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  registerPiContext({ on: () => undefined, registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command) } as never);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-command-"));
  const notifications: Array<{ text: string; type: string }> = [];

  await commands.get("pi-context")?.handler("json tools", {
    cwd,
    model: { id: "m", name: "mock", provider: "mock", contextWindow: 1000 },
    sessionManager: { getSessionId: () => "s-report", getSessionFile: () => undefined, getSessionDir: () => cwd, getCwd: () => cwd },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: { notify: (text: string, type: string) => notifications.push({ text, type }) },
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.text ?? "", /Artifact: \.model-artifacts/);
  const reportDir = path.join(cwd, ".model-artifacts", "todo", "pi-context", "reports");
  const reportFile = fs.readdirSync(reportDir).find((name) => name.endsWith(".json"));
  assert.ok(reportFile);
  const payload = JSON.parse(fs.readFileSync(path.join(reportDir, reportFile), "utf8"));
  assert.deepEqual(payload.groups.map((group: { label: string }) => group.label), ["Tools"]);
});
