import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { applyWorkflowMigration, applyWorkflowMigrationBatch, inventoryWorkflowMigrations, planWorkflowMigration, recoverWorkflowMigration, rollbackWorkflowMigration, workflowMigrationReceiptPath } from "../extensions/pi-swe/src/migration.ts";
import { WorkflowMutationService } from "../extensions/pi-swe/src/service.ts";
import { createWorkflow, reduceWorkflow } from "../extensions/pi-swe/src/workflow.ts";

const at = "2026-02-01T00:00:00.000Z";
const migrationCorpus = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-migration/corpus.json", import.meta.url), "utf8")) as { schemaVersion: number; cases: Array<{ id: string; kind: string; expected: string }> };

function repository(prefix = "pi-swe-migration-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(cwd: string, path: string, value: unknown): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function workflow(topic: string, version: number, status = "paused"): Record<string, unknown> {
  if (version === 1) {
    return {
      version, topic, revision: 3, status, goal: "legacy workflow", updatedAt: at,
      tasks: [{ id: "T1", title: "task", status: status === "complete" ? "complete" : "pending", dependsOn: [], acceptance: [], approaches: [], verification: [], evidence: [] }],
    };
  }
  return createWorkflow({
    topic,
    goal: "current workflow",
    now: at,
    tasks: [{ id: "T1", title: "task", writeScope: ["src/**"], nonGoals: [], approaches: [], verification: [{ command: "npm", args: ["test"] }] }],
  });
}

function legacyManifest(topic: string, status = "active"): Record<string, unknown> {
  const contractRoot = `.model-artifacts/initiatives/${topic}/plans/revisions/r1`;
  return {
    schemaVersion: 2, topic, status, updatedAt: at,
    activePlan: { revision: 1, path: `${contractRoot}/plan.md`, contractRoot },
  };
}

test("inventory deterministically classifies native, historical, complete, and unsupported workflows without writes", () => {
  const cwd = repository();
  writeJson(cwd, ".model-artifacts/initiatives/current/workflow.json", workflow("current", 2));
  writeJson(cwd, ".model-artifacts/initiatives/native-v1/workflow.json", workflow("native-v1", 1));
  writeJson(cwd, ".model-artifacts/initiatives/done/workflow.json", workflow("done", 1, "complete"));
  writeJson(cwd, ".model-artifacts/initiatives/historical/specs/manifest.json", legacyManifest("historical"));
  writeJson(cwd, ".model-artifacts/initiatives/historical/plans/revisions/r1/plan.md", { title: "Plan" });
  writeFileSync(join(cwd, ".model-artifacts/initiatives/historical/plans/revisions/r1/task.md"), "# T1: task\n\n## Acceptance criteria\n\n- remains bounded\n");
  writeJson(cwd, ".model-artifacts/initiatives/historical/plans/revisions/r1/contracts.json", { contracts: [{ id: "T1", kind: "subphase", status: "pending", path: ".model-artifacts/initiatives/historical/plans/revisions/r1/task.md" }] });
  writeJson(cwd, ".model-artifacts/initiatives/unsupported/workflow.json", { version: 99, token: "do-not-report" });
  writeJson(cwd, ".model-artifacts/initiatives/Bad_Topic/workflow.json", { version: 1, secret: "do-not-report" });

  const tracked = [
    ".model-artifacts/initiatives/current/workflow.json",
    ".model-artifacts/initiatives/native-v1/workflow.json",
    ".model-artifacts/initiatives/done/workflow.json",
    ".model-artifacts/initiatives/historical/specs/manifest.json",
    ".model-artifacts/initiatives/historical/plans/revisions/r1/contracts.json",
    ".model-artifacts/initiatives/unsupported/workflow.json",
    ".model-artifacts/initiatives/Bad_Topic/workflow.json",
  ];
  const before = tracked.map((path) => readFileSync(join(cwd, path), "utf8"));
  const first = inventoryWorkflowMigrations(cwd);
  const second = inventoryWorkflowMigrations(cwd);

  assert.deepEqual(first, second);
  assert.deepEqual(tracked.map((path) => readFileSync(join(cwd, path), "utf8")), before);
  assert.deepEqual(first.entries.filter((entry) => entry.classification !== "unsupported-topic").map(({ topic, classification, action }) => [topic, classification, action]), [
    ["current", "current-v2", "none"],
    ["done", "native-v1-complete", "decide-completed-workflow"],
    ["historical", "historical-contracts", "import-historical"],
    ["native-v1", "native-v1", "migrate-native-v1"],
    ["unsupported", "unsupported-workflow", "block"],
  ]);
  const invalid = first.entries.find((entry) => entry.classification === "unsupported-topic")!;
  assert.match(invalid.topic, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(invalid).includes("Bad_Topic"), false);
  assert.equal(first.complete, false);
  assert.equal(JSON.stringify(first).includes("do-not-report"), false);
  assert.match(first.entries.find((entry) => entry.topic === "native-v1")!.contentHash!, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Object.values(first.totals).every((count) => Number.isSafeInteger(count)));
});

test("inventory reports canonical, kind-first, and mixed-layout ownership without taking pi-artifacts authority", () => {
  const cwd = repository();
  writeJson(cwd, ".model-artifacts/initiatives/mixed/workflow.json", workflow("mixed", 1));
  writeJson(cwd, ".model-artifacts/specs/mixed/2026-02-01_0000-spec.md", { note: "legacy" });
  writeJson(cwd, ".model-artifacts/plans/artifact-only/2026-02-01_0000-plan.md", { note: "legacy" });

  const report = inventoryWorkflowMigrations(cwd);
  const mixed = report.entries.find((entry) => entry.topic === "mixed")!;
  const artifactOnly = report.entries.find((entry) => entry.topic === "artifact-only")!;
  assert.equal(mixed.classification, "layout-conflict");
  assert.equal(mixed.action, "block");
  assert.equal(mixed.blocker, "canonical-and-kind-first-layouts");
  assert.equal(artifactOnly.classification, "kind-first-artifacts");
  assert.equal(artifactOnly.action, "run-pi-artifacts-migration");
  assert.match(artifactOnly.guidance!, /pi-artifacts/);
});

test("inventory fails closed for malformed data, symlinks, oversized files, and traversal limits", () => {
  const malformed = repository();
  writeJson(malformed, ".model-artifacts/initiatives/broken/workflow.json", { version: 1 });
  const malformedEntry = inventoryWorkflowMigrations(malformed).entries[0]!;
  assert.equal(malformedEntry.classification, "malformed");
  assert.equal(malformedEntry.action, "block");

  const emptyHistorical = repository();
  writeJson(emptyHistorical, ".model-artifacts/initiatives/empty/specs/manifest.json", legacyManifest("empty"));
  writeJson(emptyHistorical, ".model-artifacts/initiatives/empty/plans/revisions/r1/contracts.json", { contracts: [] });
  assert.equal(inventoryWorkflowMigrations(emptyHistorical).entries[0]!.blocker, "malformed-historical-contracts");

  const oversized = repository();
  const oversizedPath = join(oversized, ".model-artifacts/initiatives/large/workflow.json");
  mkdirSync(dirname(oversizedPath), { recursive: true });
  writeFileSync(oversizedPath, "x".repeat(129));
  assert.throws(() => inventoryWorkflowMigrations(oversized, { maxFileBytes: 128 }), /file byte limit/);

  const linked = repository();
  mkdirSync(join(linked, ".model-artifacts/initiatives"), { recursive: true });
  symlinkSync(tmpdir(), join(linked, ".model-artifacts/initiatives/linked"));
  assert.throws(() => inventoryWorkflowMigrations(linked), /symlink/);

  const broad = repository();
  mkdirSync(join(broad, ".model-artifacts/initiatives"), { recursive: true });
  for (let index = 0; index < 3; index += 1) mkdirSync(join(broad, `.model-artifacts/initiatives/topic-${index}`));
  assert.throws(() => inventoryWorkflowMigrations(broad, { maxEntriesPerDirectory: 2 }), /directory entry limit/);

  const deep = repository();
  writeJson(deep, ".model-artifacts/initiatives/one/two/three/workflow.json", workflow("one/two/three", 1));
  assert.throws(() => inventoryWorkflowMigrations(deep, { maxDepth: 2 }), /depth limit/);
});

test("inventory bounds aggregate work, topic count, and metadata-only report size", () => {
  const cwd = repository();
  for (let index = 0; index < 3; index += 1) writeJson(cwd, `.model-artifacts/initiatives/topic-${index}/workflow.json`, workflow(`topic-${index}`, 1));
  assert.throws(() => inventoryWorkflowMigrations(cwd, { maxTopics: 2 }), /topic limit/);
  assert.throws(() => inventoryWorkflowMigrations(cwd, { maxFiles: 2 }), /file limit/);
  assert.throws(() => inventoryWorkflowMigrations(cwd, { maxBytes: 2 }), /byte limit/);
  assert.throws(() => inventoryWorkflowMigrations(cwd, { maxReportBytes: 64 }), /report byte limit/);
  const report = inventoryWorkflowMigrations(cwd);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 64 * 1024);
  assert.ok(report.entries.every((entry) => !Reflect.has(entry, "workflow") && !Reflect.has(entry, "payload")));
});

test("qualification corpus enumerates every supported state and adversarial recovery boundary deterministically", () => {
  assert.equal(migrationCorpus.schemaVersion, 1);
  assert.deepEqual(migrationCorpus.cases.map((item) => item.id), [...migrationCorpus.cases.map((item) => item.id)].sort((a, b) => {
    const order = ["draft", "active", "blocked", "complete-reopen", "complete-grandfather", "historical-import", "layout-conflict", "corrupt-json", "unknown-version", "crash-after-postimage", "concurrent-writer", "rollback-edited-postimage", "rollback-exact-postimage"];
    return order.indexOf(a) - order.indexOf(b);
  }));
  for (const required of ["native-v1", "historical-contracts", "canonical-and-kind-first", "malformed", "unsupported", "fault", "cas", "rollback"]) assert.ok(migrationCorpus.cases.some((item) => item.kind === required), required);
  assert.ok(migrationCorpus.cases.every((item) => item.expected.length > 0));
});

test("policy requires explicit completed-workflow disposition and preserves historical tasks without accepting them as fresh v2 evidence", () => {
  const cwd = repository();
  writeJson(cwd, ".model-artifacts/initiatives/done/workflow.json", workflow("done", 1, "complete"));
  const blocked = planWorkflowMigration(cwd, "done", { decidedBy: "operator-a", now: at });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.disposition, "operator-review");
  const reopen = planWorkflowMigration(cwd, "done", { disposition: "reopen", decidedBy: "operator-a", now: at });
  assert.equal(reopen.eligible, true);
  const postimage = JSON.parse(reopen.postimage!);
  assert.equal(postimage.status, "paused");
  assert.equal(postimage.orchestration.phase, "initiative-acceptance");
  assert.equal(postimage.tasks[0].status, "complete");
  assert.equal(postimage.tasks[0].phase, "historical");
  assert.equal(postimage.tasks[0].evidence.length, 0);
  assert.equal(postimage.initiativeAcceptance, undefined);
  assert.equal(postimage.migration.preimageHash, reopen.preimageHash);
});

test("apply is preimage-bound, atomic, idempotent, guarded from ordinary mutation, and rollback is compare-and-restore", async () => {
  const cwd = repository();
  const path = ".model-artifacts/initiatives/legacy/workflow.json";
  writeJson(cwd, path, workflow("legacy", 1));
  const before = readFileSync(join(cwd, path), "utf8");
  const service = new WorkflowMutationService(cwd);
  const compatibility = service.read("legacy")!.workflow;
  await assert.rejects(() => service.mutate("legacy", compatibility.revision, (current) => reduceWorkflow(current, { type: "start" }, at)), /requires explicit migration/);

  const plan = planWorkflowMigration(cwd, "legacy", { disposition: "continue", decidedBy: "operator-a", now: at });
  const applied = await applyWorkflowMigration(cwd, plan);
  assert.equal(applied.status, "applied");
  assert.ok(existsSync(join(cwd, workflowMigrationReceiptPath("legacy"))));
  assert.equal(inventoryWorkflowMigrations(cwd).entries.find((entry) => entry.topic === "legacy")!.classification, "current-v2");
  const restartedService = new WorkflowMutationService(cwd);
  assert.equal(restartedService.read("legacy", false)!.storedVersion, 2);
  assert.equal((await applyWorkflowMigration(cwd, plan)).status, "already-applied");
  const migrated = service.read("legacy", false)!.workflow;
  assert.equal(migrated.version, 2);
  assert.equal(migrated.tasks[0]!.evidence.length, 0);
  assert.equal(migrated.orchestration.activeRun, undefined);

  writeFileSync(join(cwd, path), `${readFileSync(join(cwd, path), "utf8")} `);
  await assert.rejects(() => rollbackWorkflowMigration(cwd, "legacy"), /intervening edits/);
  writeFileSync(join(cwd, path), plan.postimage!);
  assert.equal((await rollbackWorkflowMigration(cwd, "legacy")).status, "rolled-back");
  assert.equal(readFileSync(join(cwd, path), "utf8"), before);
  assert.equal((await rollbackWorkflowMigration(cwd, "legacy")).status, "already-rolled-back");
});

test("batch apply requires explicit unique selections and reports each topic without hiding partial failure", async () => {
  const cwd = repository();
  writeJson(cwd, ".model-artifacts/initiatives/good/workflow.json", workflow("good", 1));
  writeJson(cwd, ".model-artifacts/initiatives/stale-batch/workflow.json", workflow("stale-batch", 1));
  const good = planWorkflowMigration(cwd, "good", { decidedBy: "operator-a", now: at });
  const stale = planWorkflowMigration(cwd, "stale-batch", { decidedBy: "operator-a", now: at });
  writeJson(cwd, ".model-artifacts/initiatives/stale-batch/workflow.json", { ...workflow("stale-batch", 1), revision: 9 });
  const results = await applyWorkflowMigrationBatch(cwd, [good, stale]);
  assert.deepEqual(results.map(({ topic, status }) => [topic, status]), [["good", "applied"], ["stale-batch", "failed"]]);
  assert.match(results[1]!.error!, /stale migration plan/);
  await assert.rejects(() => applyWorkflowMigrationBatch(cwd, [good, good]), /unique topics/);
});

test("SWE apply refuses active pi-artifacts claims and retained transaction recovery bundles", async () => {
  for (const blocker of ["active.claim.json", "fixture-transaction"] as const) {
    const cwd = repository();
    writeJson(cwd, ".model-artifacts/initiatives/exclusive/workflow.json", workflow("exclusive", 1));
    const plan = planWorkflowMigration(cwd, "exclusive", { decidedBy: "operator-a", now: at });
    const path = join(cwd, ".model-artifacts/system/logs/model-artifact-migration", blocker);
    if (blocker.endsWith("-transaction")) mkdirSync(path, { recursive: true });
    else writeJson(cwd, `.model-artifacts/system/logs/model-artifact-migration/${blocker}`, { ownerToken: "other" });
    await assert.rejects(() => applyWorkflowMigration(cwd, plan), /pi-artifacts migration/);
    assert.equal(JSON.parse(readFileSync(join(cwd, ".model-artifacts/initiatives/exclusive/workflow.json"), "utf8")).version, 1);
  }
});

test("apply rejects stale plans and interrupted publication is recovered from the exact postimage", async () => {
  const stale = repository();
  const stalePath = ".model-artifacts/initiatives/stale/workflow.json";
  writeJson(stale, stalePath, workflow("stale", 1));
  const stalePlan = planWorkflowMigration(stale, "stale", { decidedBy: "operator-a", now: at });
  writeJson(stale, stalePath, { ...workflow("stale", 1), revision: 4 });
  await assert.rejects(() => applyWorkflowMigration(stale, stalePlan), /stale migration plan/);

  const interrupted = repository();
  writeJson(interrupted, ".model-artifacts/initiatives/crash/workflow.json", workflow("crash", 1));
  const plan = planWorkflowMigration(interrupted, "crash", { decidedBy: "operator-a", now: at });
  await assert.rejects(() => applyWorkflowMigration(interrupted, plan, { fault: (stage) => { if (stage === "workflow-written") throw new Error("power loss"); } }), /power loss/);
  const recovered = await recoverWorkflowMigration(interrupted, "crash");
  assert.equal(recovered.status, "recovered");
  assert.match(recovered.nextAction, /committed/);
  assert.equal((await applyWorkflowMigration(interrupted, plan)).status, "already-applied");
});

test("grandfathered completion remains immutable through all normal mutation entry points", async () => {
  const cwd = repository();
  writeJson(cwd, ".model-artifacts/initiatives/archive/workflow.json", workflow("archive", 1, "complete"));
  const plan = planWorkflowMigration(cwd, "archive", { disposition: "grandfather-read-only", decidedBy: "operator-a", now: at });
  await applyWorkflowMigration(cwd, plan);
  const service = new WorkflowMutationService(cwd);
  const current = service.read("archive", false)!.workflow;
  await assert.rejects(() => service.mutate("archive", current.revision, (value) => reduceWorkflow(value, { type: "pause" }, at)), /grandfathered read-only/);
});
