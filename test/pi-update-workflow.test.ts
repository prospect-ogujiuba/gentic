import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { analyzePiUpdate, renderPiUpdateReport } from "../scripts/pi-update.ts";
import { PI_CONTRACT_SOURCE } from "../src/pi-contract.ts";

const root = new URL("..", import.meta.url).pathname;

test("Pi update analysis reports event, method, declaration, and changelog drift", () => {
  const current = `interface ExtensionAPI {\n on(event: "session_start", handler: unknown): void;\n registerTool(value: unknown): void;\n}`;
  const target = `interface ExtensionAPI {\n on(event: "session_start", handler: unknown): void;\n on(event: "release_event", handler: unknown): void;\n registerTool(value: unknown): void;\n registerFeature(value: unknown): void;\n}`;
  const analysis = analyzePiUpdate({ currentVersion: "0.84.2", targetVersion: "0.85.0", currentDeclarations: current, targetDeclarations: target, changelog: "# 0.85.0\n- Added release event" });
  assert.equal(analysis.driftDetected, true);
  assert.deepEqual(analysis.events.added, ["release_event"]);
  assert.deepEqual(analysis.extensionApiMethods.added, ["registerFeature"]);
  assert.match(renderPiUpdateReport(analysis, [], "dry-run"), /Node: v\d+/);
  assert.match(renderPiUpdateReport(analysis, [], "dry-run"), /Added release event/);
});

test("Pi update workflow dry-runs a newer fixture without changing pins", () => {
  const fixture = mkdtempSync(join(tmpdir(), "gentic-pi-fixture-"));
  const report = join(fixture, "report.md");
  try {
    const packageRoot = join(fixture, "candidate");
    const declarationsPath = join(packageRoot, PI_CONTRACT_SOURCE.declarations);
    mkdirSync(dirname(declarationsPath), { recursive: true });
    const currentDeclarations = readFileSync(join(root, "node_modules", PI_CONTRACT_SOURCE.package, PI_CONTRACT_SOURCE.declarations), "utf8");
    const targetDeclarations = currentDeclarations.replace(
      /on\(event: "session_start"/,
      `on(event: "fixture_release_event", handler: ExtensionEventHandler<unknown>): void;\n\ton(event: "session_start"`,
    );
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: PI_CONTRACT_SOURCE.package, version: "0.85.0" }));
    writeFileSync(declarationsPath, targetDeclarations);
    writeFileSync(join(packageRoot, "CHANGELOG.md"), "# 0.85.0\n\n- Fixture release event.\n");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pi-update.ts", "--fixture", packageRoot, "--report", report], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(readFileSync(report, "utf8"), /fixture_release_event/);
    assert.match(readFileSync(report, "utf8"), /Drift detected: yes/);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
