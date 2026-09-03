import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import {
  completeCanonicalContract,
  completionClaimPath,
  completionJournalPath,
  deriveCompletionRequestId,
  recoverCanonicalCompletion,
  type CompleteCanonicalContractRequest,
  type CompletionFaultPoint,
} from "../extensions/pi-swe/src/completion.ts";
import { CORE_SPECIALIST_IDS } from "../extensions/pi-swe/src/domain/readiness.ts";
import { inspectCanonicalInitiative } from "../extensions/pi-swe/src/planning.ts";

test("pi-swe completion records require an indexed complete disposition", () => {
  for (const status of ["pending", "in_progress", "blocked"]) {
    const fixture = writeCompletionFixture();
    const record = completionRecord(fixture.request, {
      initiativeState: "executing",
      activeContractId: "02",
      readyContractIds: ["02"],
    });
    fixture.index.contracts[0].status = status;
    fixture.index.completionRecords = { "01": record };
    fixture.writeIndex();
    const invalid = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
    assert.ok(invalid.diagnostics.some((diagnostic) =>
      diagnostic.code === "contract_index_invalid" && diagnostic.field === "completionRecords.01"
    ), status);
  }

  const fixture = writeCompletionFixture();
  fixture.index.contracts[0].status = "complete";
  fixture.index.completionRecords = { "01": completionRecord(fixture.request, {
    initiativeState: "executing",
    activeContractId: "02",
    readyContractIds: ["02"],
  }) };
  fixture.writeIndex();
  const valid = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.completionRecords["01"]?.requestId, deriveCompletionRequestId(fixture.request));
});

test("pi-swe completes an exact reviewed contract and repeats without writes after reload", () => {
  const fixture = writeCompletionFixture();
  const result = completeCanonicalContract(fixture.request);

  assert.equal(result.status, "completed");
  assert.equal(result.contractId, "01");
  assert.deepEqual(result.readyContractIds, ["02"]);
  const inspected = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.deepEqual(inspected.diagnostics, []);
  assert.equal(inspected.contracts.find((contract) => contract.id === "01")?.status, "complete");
  assert.equal(inspected.manifest?.activeContract?.id, "02");
  assert.equal(inspected.completionRecords["01"]?.review.decision, "approve");
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
  assert.equal(existsSync(join(fixture.cwd, fixture.contractPath)), true);
  assert.equal(existsSync(join(fixture.cwd, `${fixture.contractPath} [COMPLETE]`)), false);

  const beforeManifest = readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8");
  const beforeIndex = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");
  const repeated = completeCanonicalContract(fixture.request);
  assert.equal(repeated.status, "already-complete");
  assert.deepEqual(repeated.recordedNextState.readyContractIds, ["02"]);
  assert.deepEqual(repeated.currentReadyContractIds, ["02"]);
  assert.equal(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);

  const conflict = completeCanonicalContract({
    ...fixture.request,
    verification: { ...fixture.request.verification, contentHash: `sha256:${"0".repeat(64)}` },
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);
});

test("pi-swe completes without advancing when the next contract is explicitly blocked", () => {
  const fixture = writeCompletionFixture();
  fixture.index.contracts[1].status = "blocked";
  fixture.writeIndex();
  const result = completeCanonicalContract(fixture.request);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.readyContractIds, []);
  assert.equal(result.activeContractId, null);
  const inspected = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.equal(inspected.contracts[0]?.status, "complete");
  assert.equal(inspected.manifest?.activeContract, undefined);
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
});

test("pi-swe rejects a deferral with missing evidence before completion mutation", () => {
  const fixture = writeCompletionFixture();
  const thirdPath = ".model-artifacts/initiatives/demo/plans/revisions/r1/contracts/03.md";
  const third = "# contract 03\n";
  write(fixture.cwd, thirdPath, third);
  fixture.index.contracts.push({ kind: "phase", id: "03", dependsOn: ["02"], planRevision: 1, path: thirdPath, status: "pending", contentHash: sha256(third) });
  fixture.index.contractFacts["02"] = { ...fixture.index.contractFacts["02"], entryInputsAvailable: false, deferral: { approved: true, evidencePath: ".model-artifacts/initiatives/demo/reports/missing-deferral.md" } };
  fixture.index.contractFacts["03"] = { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true };
  fixture.writeIndex();
  const before = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");

  const result = completeCanonicalContract(fixture.request);
  assert.equal(result.status, "rejected");
  assert.equal(result.artifact, ".model-artifacts/initiatives/demo/reports/missing-deferral.md");
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), before);
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
});

test("pi-swe exact repeats are idempotent after active pointer clear and semantics mismatches conflict", () => {
  const fixture = writeCompletionFixture();
  const clearRequest = { ...fixture.request, nextActiveContract: "clear" as const };
  assert.equal(completeCanonicalContract(clearRequest).status, "completed");
  const beforeManifest = readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8");
  const beforeIndex = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");
  const repeated = completeCanonicalContract(clearRequest);
  assert.equal(repeated.status, "already-complete");
  assert.equal(repeated.recordedNextState.activeContractId, null);
  assert.equal(completeCanonicalContract(fixture.request).status, "conflict");
  assert.equal(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);
});

test("pi-swe rejects stale hashes, missing evidence, and wrong active contracts without writes", () => {
  const fixture = writeCompletionFixture();
  const beforeManifest = readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8");
  const beforeIndex = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");

  const stale = completeCanonicalContract({ ...fixture.request, expectedPreCompletionContentHash: `sha256:${"0".repeat(64)}` });
  assert.equal(stale.status, "rejected");
  const escaping = completeCanonicalContract({
    ...fixture.request,
    review: { ...fixture.request.review, path: "../implementation-review.md" },
  });
  assert.equal(escaping.status, "rejected");
  rmSync(join(fixture.cwd, fixture.verificationPath));
  const missing = completeCanonicalContract(fixture.request);
  assert.equal(missing.status, "rejected");
  fixture.manifest.activeContract = { id: "02", path: fixture.secondContractPath };
  fixture.writeManifest();
  const wrong = completeCanonicalContract(fixture.request);
  assert.equal(wrong.status, "rejected");
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);
  assert.notEqual(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
});

test("pi-swe rejects unrelated pass reports and plan reviews as completion evidence", () => {
  const fixture = writeCompletionFixture();
  const unrelatedVerification = `# Verification\n\nPi-SWE-Evidence: ${JSON.stringify({
    schemaVersion: 1,
    mode: "verification",
    topic: "demo",
    contractId: "99",
    contractPath: ".model-artifacts/initiatives/demo/plans/revisions/r1/contracts/99.md",
    planRevision: 1,
    contractContentHash: fixture.request.expectedPreCompletionContentHash,
    outcome: "pass",
    gaps: "none",
  })}\n\nOutcome: pass\n`;
  write(fixture.cwd, fixture.verificationPath, unrelatedVerification);
  write(fixture.cwd, fixture.implementationReviewPath, "# Plan review\n\nDecision: approve\n");
  const exploited = completeCanonicalContract({
    ...fixture.request,
    verification: { path: fixture.verificationPath, contentHash: sha256(unrelatedVerification) },
    review: { path: fixture.implementationReviewPath, contentHash: sha256("# Plan review\n\nDecision: approve\n"), decision: "approve" },
  });
  assert.equal(exploited.status, "rejected");
  assert.equal(inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" }).contracts[0]?.status, "in_progress");
});

test("pi-swe grants one exclusive local completion owner", () => {
  const fixture = writeCompletionFixture();
  let loser: ReturnType<typeof completeCanonicalContract> | undefined;
  const winner = completeCanonicalContract(fixture.request, {
    faultInjector(point) {
      if (point === "after-stage-prepared") loser = completeCanonicalContract(fixture.request);
    },
  });
  assert.equal(winner.status, "completed");
  assert.equal(loser?.status, "conflict");
  assert.match(loser?.message ?? "", /another local completion transaction/);
  assert.equal(existsSync(join(fixture.cwd, completionClaimPath("demo"))), false);
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
});

test("pi-swe treats incomplete and aged claim owners as busy without auto-reaping", async () => {
  const fixture = writeCompletionFixture();
  const lockPath = join(fixture.cwd, completionClaimPath("demo"));
  mkdirSync(dirname(lockPath), { recursive: true });
  const partialScript = `
    import { closeSync, openSync, rmSync } from 'node:fs';
    const fd = openSync(process.env.LOCK, 'wx', 0o600);
    console.log('CLAIM_VISIBLE');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    closeSync(fd);
    rmSync(process.env.LOCK, { force: true });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", partialScript], { env: { ...process.env, LOCK: lockPath }, stdio: ["ignore", "pipe", "pipe"] });
  await waitForOutput(child, "CLAIM_VISIBLE");
  assert.equal(completeCanonicalContract(fixture.request).status, "conflict");
  assert.equal(existsSync(lockPath), true);
  const [partialExit] = await once(child, "exit");
  assert.equal(partialExit, 0);

  const aged = { schemaVersion: 1, token: "aged-live", pid: process.pid, requestId: "request", createdAt: "2000-01-01T00:00:00.000Z" };
  writeFileSync(lockPath, `${JSON.stringify(aged)}\n`, { flag: "wx" });
  assert.equal(completeCanonicalContract(fixture.request).status, "conflict");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "aged-live");
  rmSync(lockPath);

  const dead = { ...aged, token: "dead-owner", pid: 2147483647 };
  writeFileSync(lockPath, `${JSON.stringify(dead)}\n`, { flag: "wx" });
  assert.equal(completeCanonicalContract(fixture.request).status, "conflict");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "dead-owner");
  rmSync(lockPath);
});

test("pi-swe binds every journal and target mutation to the held claim token", () => {
  const fixture = writeCompletionFixture();
  const lockPath = join(fixture.cwd, completionClaimPath("demo"));
  assert.throws(() => completeCanonicalContract(fixture.request, {
    faultInjector(point) {
      if (point !== "after-stage-prepared") return;
      const claim = JSON.parse(readFileSync(lockPath, "utf8"));
      claim.token = "replacement-owner";
      writeFileSync(lockPath, `${JSON.stringify(claim)}\n`, "utf8");
    },
  }), /completion claim ownership changed/);
  const index = JSON.parse(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"));
  assert.equal(index.contracts[0].status, "in_progress");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "replacement-owner");
  rmSync(lockPath);
  assert.equal(recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" }).status, "rolled-back");
});

test("pi-swe allows only one winner across separate local processes", async () => {
  const fixture = writeCompletionFixture();
  const moduleUrl = new URL("../extensions/pi-swe/src/completion.ts", import.meta.url).href;
  const childScript = `
    import { completeCanonicalContract } from ${JSON.stringify(moduleUrl)};
    const request = JSON.parse(process.env.REQUEST);
    const result = completeCanonicalContract(request, { faultInjector(point) {
      if (point === 'after-stage-prepared') {
        console.log('WINNER_CLAIMED');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }});
    console.log('WINNER_RESULT:' + JSON.stringify(result));
  `;
  let output = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childScript], {
    env: { ...process.env, REQUEST: JSON.stringify(fixture.request) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitForOutput(child, "WINNER_CLAIMED", () => output);
  const loser = completeCanonicalContract(fixture.request);
  assert.equal(loser.status, "conflict");
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, output);
  assert.match(output, /WINNER_RESULT:.*"status":"completed"/);
  assert.equal(inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" }).contracts[0]?.status, "complete");
});

test("pi-swe recovers consumed prepared sources by rolling back verified backup copies", () => {
  const fixture = writeCompletionFixture();
  const beforeManifest = readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8");
  const beforeIndex = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");
  assert.throws(
    () => completeCanonicalContract(fixture.request, faultAt("after-contract-index-rename")),
    /injected completion fault/,
  );
  const pending = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.ok(pending.diagnostics.some((diagnostic) => diagnostic.code === "completion_transaction_pending"));

  const recovery = recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" });
  assert.equal(recovery.status, "rolled-back");
  assert.equal(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
});

test("pi-swe blocks recovery when a pre-validated backup is corrupt", () => {
  const fixture = writeCompletionFixture();
  assert.throws(
    () => completeCanonicalContract(fixture.request, faultAt("after-contract-index-rename")),
    /injected completion fault/,
  );
  const journal = JSON.parse(readFileSync(join(fixture.cwd, completionJournalPath("demo")), "utf8"));
  writeFileSync(join(fixture.cwd, journal.roles.manifest.preimageBackupPath), "corrupt\n", "utf8");

  const recovery = recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" });
  assert.equal(recovery.status, "blocked-recovery");
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), true);
});

test("pi-swe rolls back a hash-valid manifest-installed snapshot that violates nextState", () => {
  const fixture = writeCompletionFixture();
  assert.throws(() => completeCanonicalContract(fixture.request, faultAt("after-manifest-installed")), /injected completion fault/);
  const journalPath = join(fixture.cwd, completionJournalPath("demo"));
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const manifestPath = join(fixture.cwd, fixture.manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.activeContract;
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, bytes, "utf8");
  journal.roles.manifest.preparedHash = sha256(bytes);
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

  assert.equal(recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" }).status, "rolled-back");
  assert.equal(inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" }).contracts[0]?.status, "in_progress");
});

test("pi-swe rolls forward manifest-installed and partial cleanup crashes", () => {
  const installed = writeCompletionFixture();
  assert.throws(
    () => completeCanonicalContract(installed.request, faultAt("after-manifest-installed")),
    /injected completion fault/,
  );
  const committed = recoverCanonicalCompletion({ cwd: installed.cwd, topic: "demo" });
  assert.equal(committed.status, "committed-cleanup");
  assert.equal(inspectCanonicalInitiative({ cwd: installed.cwd, topic: "demo" }).contracts[0]?.status, "complete");

  const cleanup = writeCompletionFixture();
  assert.throws(
    () => completeCanonicalContract(cleanup.request, faultAt("after-cleanup-stage")),
    /injected completion fault/,
  );
  const journal = JSON.parse(readFileSync(join(cleanup.cwd, completionJournalPath("demo")), "utf8"));
  rmSync(join(cleanup.cwd, journal.roles["contract-index"].preimageBackupPath), { force: true });
  const resumed = recoverCanonicalCompletion({ cwd: cleanup.cwd, topic: "demo" });
  assert.equal(resumed.status, "committed-cleanup");
  assert.equal(existsSync(join(cleanup.cwd, completionJournalPath("demo"))), false);
});

test("pi-swe recovers every durable install/commit stage boundary", () => {
  const cases: Array<[CompletionFaultPoint, "rolled-back" | "committed-cleanup"]> = [
    ["after-stage-prepared", "rolled-back"],
    ["after-contract-index-rename", "rolled-back"],
    ["after-contract-index-installed", "rolled-back"],
    ["after-manifest-rename", "rolled-back"],
    ["after-manifest-installed", "committed-cleanup"],
    ["after-validated", "committed-cleanup"],
    ["after-cleanup-stage", "committed-cleanup"],
  ];
  for (const [point, expected] of cases) {
    const fixture = writeCompletionFixture();
    assert.throws(() => completeCanonicalContract(fixture.request, faultAt(point)), /injected completion fault/, point);
    assert.equal(recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" }).status, expected, point);
  }
});

test("pi-swe resumes rollback without consuming either preimage backup", () => {
  const fixture = writeCompletionFixture();
  assert.throws(() => completeCanonicalContract(fixture.request, faultAt("after-contract-index-rename")), /injected completion fault/);
  assert.throws(
    () => recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" }, faultAt("after-restore-contract-index")),
    /injected completion fault/,
  );
  const journal = JSON.parse(readFileSync(join(fixture.cwd, completionJournalPath("demo")), "utf8"));
  assert.equal(journal.stage, "rollback");
  assert.equal(existsSync(join(fixture.cwd, journal.roles["contract-index"].preimageBackupPath)), true);
  assert.equal(existsSync(join(fixture.cwd, journal.roles.manifest.preimageBackupPath)), true);
  assert.equal(recoverCanonicalCompletion({ cwd: fixture.cwd, topic: "demo" }).status, "rolled-back");
});

test("pi-swe rejects impossible consumed-source combinations and safely retries pre-journal faults", () => {
  const impossible = writeCompletionFixture();
  assert.throws(() => completeCanonicalContract(impossible.request, faultAt("after-stage-prepared")), /injected completion fault/);
  const journal = JSON.parse(readFileSync(join(impossible.cwd, completionJournalPath("demo")), "utf8"));
  rmSync(join(impossible.cwd, journal.roles["contract-index"].preparedPath));
  assert.equal(recoverCanonicalCompletion({ cwd: impossible.cwd, topic: "demo" }).status, "blocked-recovery");

  for (const point of ["after-contract-index-prepared", "after-contract-index-backup", "after-manifest-prepared", "after-manifest-backup", "after-prepared-files"] as CompletionFaultPoint[]) {
    const fixture = writeCompletionFixture();
    assert.throws(() => completeCanonicalContract(fixture.request, faultAt(point)), /injected completion fault/, point);
    assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
    assert.equal(completeCanonicalContract(fixture.request).status, "completed", point);
  }
});

test("/swe complete invokes the explicit guarded action and reports status", async () => {
  const fixture = writeCompletionFixture();
  const commands = new Map<string, { handler: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    capabilities: new Map(),
    on() {},
    registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
    getCommands: () => [],
    getAllTools: () => [],
  };
  piSwe(pi as never, { cwd: fixture.cwd } as never);
  const request = fixture.request;
  const args = [
    "complete", request.topic, request.contractId, String(request.expectedPlanRevision), request.expectedContractPath,
    request.expectedPreCompletionContentHash, request.verification.path, request.verification.contentHash,
    request.review.path, request.review.contentHash, "approve", request.nextActiveContract,
  ].join(" ");
  await commands.get("swe")?.handler(args, { cwd: fixture.cwd, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } });
  assert.equal(notifications[0]?.type, "info");
  assert.match(notifications[0]?.message ?? "", /status: completed/);
  assert.match(notifications[0]?.message ?? "", /phase progress:/);
});

test("pi-swe validates same-snapshot next state but accepts historical advancement", () => {
  const fixture = writeCompletionFixture();
  assert.equal(completeCanonicalContract(fixture.request).status, "completed");
  const stored = JSON.parse(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"));
  stored.completionRecords["01"].nextState.readyContractIds = [];
  writeFileSync(join(fixture.cwd, fixture.indexPath), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  stored.contracts[1].status = "complete";
  writeFileSync(join(fixture.cwd, fixture.indexPath), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  const manifest = JSON.parse(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"));
  delete manifest.activeContract;
  manifest.initiativeState = "finalizing";
  writeFileSync(join(fixture.cwd, fixture.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const historical = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.deepEqual(historical.diagnostics, []);

  stored.completionRecords["01"].nextState.readyContractIds = ["missing"];
  writeFileSync(join(fixture.cwd, fixture.indexPath), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  const invalid = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.field?.startsWith("completionRecords.01")));
});

test("pi-swe atomically normalizes a CSR-style legacy index, completes P1.1, and advances to P1.2", () => {
  const fixture = writeLegacyCompatibilityFixture();
  const inspected = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.deepEqual(inspected.diagnostics, []);
  assert.equal(inspected.migrationRequired, true);
  assert.equal(inspected.manifest?.approval.decision, "approved");
  assert.equal(inspected.manifest?.specialists["accessibility-ux"]?.status, "not-required");
  assert.deepEqual(inspected.readyIds, ["P1.1"]);

  const evidenceBefore = [
    readFileSync(join(fixture.cwd, fixture.verificationPath), "utf8"),
    readFileSync(join(fixture.cwd, fixture.implementationReviewPath), "utf8"),
  ];
  const result = completeCanonicalContract(fixture.request);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.readyContractIds, ["P1.2"]);
  assert.equal(result.activeContractId, "P1.2");
  const index = JSON.parse(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"));
  const manifest = JSON.parse(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.migration.requestId, result.requestId);
  assert.equal(index.contracts.find((contract: any) => contract.id === "P1.1").status, "complete");
  assert.equal(index.contracts.find((contract: any) => contract.id === "P1.2").dependsOn[0], "P1.1");
  assert.equal("dependencies" in index.contracts[0], false);
  assert.equal("canonicalPath" in index.contracts[0], false);
  assert.equal(manifest.approval.decision, "approved");
  assert.equal(manifest.specialists.accessibilityUx, undefined);
  assert.equal(manifest.activeContract.id, "P1.2");
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
  assert.deepEqual([
    readFileSync(join(fixture.cwd, fixture.verificationPath), "utf8"),
    readFileSync(join(fixture.cwd, fixture.implementationReviewPath), "utf8"),
  ], evidenceBefore);

  const beforeRetry = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");
  const repeated = completeCanonicalContract(fixture.request);
  assert.equal(repeated.status, "already-complete");
  assert.equal(repeated.requestId, result.requestId);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeRetry);
});

test("pi-swe records manifest-only normalization without claiming a contract-index migration", () => {
  const fixture = writeCompletionFixture();
  fixture.index.schemaVersion = 2;
  fixture.manifest.approval.decision = "approve";
  fixture.manifest.specialists.accessibilityUx = fixture.manifest.specialists["accessibility-ux"];
  delete fixture.manifest.specialists["accessibility-ux"];
  fixture.writeIndex();
  fixture.writeManifest();

  const result = completeCanonicalContract(fixture.request);
  assert.equal(result.status, "completed");
  const index = JSON.parse(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"));
  const manifest = JSON.parse(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"));
  assert.equal(index.migration, undefined);
  assert.deepEqual(manifest.piSweMigration.fields, ["approval.decision", "specialists.accessibility-ux"]);
});

test("pi-swe reports all ambiguous legacy index fields against contracts.json without mutation", () => {
  const fixture = writeLegacyCompatibilityFixture();
  const malformed = JSON.parse(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"));
  malformed.contracts[0].dependsOn = ["different"];
  malformed.contracts[1].path = ".model-artifacts/initiatives/demo/plans/revisions/r1/wrong.md";
  malformed.contracts[1].status = "unknown-legacy-state";
  writeFileSync(join(fixture.cwd, fixture.indexPath), `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
  const beforeManifest = readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8");
  const beforeIndex = readFileSync(join(fixture.cwd, fixture.indexPath), "utf8");

  const rejected = completeCanonicalContract(fixture.request);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.artifact, fixture.indexPath);
  assert.match(rejected.message, /contracts\[0\]\.dependsOn/);
  assert.match(rejected.message, /contracts\[1\]\.path/);
  assert.match(rejected.message, /contracts\[1\]\.status/);
  assert.equal(readFileSync(join(fixture.cwd, fixture.manifestPath), "utf8"), beforeManifest);
  assert.equal(readFileSync(join(fixture.cwd, fixture.indexPath), "utf8"), beforeIndex);
  assert.equal(existsSync(join(fixture.cwd, completionJournalPath("demo"))), false);
});

async function waitForOutput(child: ReturnType<typeof spawn>, marker: string, getOutput?: () => string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let observed = "";
    const timeout = setTimeout(() => rejectPromise(new Error(`timed out waiting for child output: ${marker}\n${observed}`)), 5000);
    const onData = (chunk: unknown) => {
      observed += String(chunk);
      if (!(getOutput?.() ?? observed).includes(marker)) return;
      clearTimeout(timeout);
      resolvePromise();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("exit", (code) => {
      if (!(getOutput?.() ?? observed).includes(marker)) {
        clearTimeout(timeout);
        rejectPromise(new Error(`child exited ${String(code)} before ${marker}: ${observed}`));
      }
    });
  });
}

function faultAt(point: CompletionFaultPoint) {
  return { faultInjector: (candidate: CompletionFaultPoint) => {
    if (candidate === point) throw new Error(`injected completion fault: ${point}`);
  } };
}

function writeCompletionFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-completion-"));
  const manifestPath = ".model-artifacts/initiatives/demo/specs/manifest.json";
  const specPath = ".model-artifacts/initiatives/demo/specs/spec.md";
  const planPath = ".model-artifacts/initiatives/demo/plans/plan.md";
  const contractRoot = ".model-artifacts/initiatives/demo/plans/revisions/r1";
  const contractPath = `${contractRoot}/contracts/01.md`;
  const secondContractPath = `${contractRoot}/contracts/02.md`;
  const indexPath = `${contractRoot}/contracts.json`;
  const planReviewPath = ".model-artifacts/initiatives/demo/reports/plan-review.md";
  const verificationPath = ".model-artifacts/initiatives/demo/reports/verification.md";
  const implementationReviewPath = ".model-artifacts/initiatives/demo/reports/implementation-review.md";
  const spec = "# exact spec\n";
  const plan = "# exact plan\n";
  const firstContract = "# contract 01\n";
  const secondContract = "# contract 02\n";
  const verificationEnvelope = {
    schemaVersion: 1,
    mode: "verification",
    topic: "demo",
    contractId: "01",
    contractPath,
    planRevision: 1,
    contractContentHash: sha256(firstContract),
    outcome: "pass",
    gaps: "none",
  };
  const verification = `# Verification\n\nPi-SWE-Evidence: ${JSON.stringify(verificationEnvelope)}\n\nOutcome: pass\n`;
  const reviewEnvelope = {
    schemaVersion: 1,
    mode: "implementation-review",
    topic: "demo",
    contractId: "01",
    contractPath,
    planRevision: 1,
    contractContentHash: sha256(firstContract),
    decision: "approve",
    blockingFindings: 0,
    verification: { path: verificationPath, contentHash: sha256(verification) },
  };
  const review = `# Implementation review\n\nPi-SWE-Evidence: ${JSON.stringify(reviewEnvelope)}\n\nMode: implementation review\nDecision: approve\n`;
  write(cwd, specPath, spec);
  write(cwd, planPath, plan);
  write(cwd, contractPath, firstContract);
  write(cwd, secondContractPath, secondContract);
  write(cwd, planReviewPath, "# Plan review\n\nDecision: approve\n");
  write(cwd, verificationPath, verification);
  write(cwd, implementationReviewPath, review);
  const specialists = Object.fromEntries(CORE_SPECIALIST_IDS.map((id) => [id, { status: "not-required", rationale: `${id} is not consequential.` }]));
  const manifest: any = {
    schemaVersion: 2,
    initiativeId: "demo",
    topic: "demo",
    initiativeState: "executing",
    activeSpec: { revision: 1, path: specPath, contentHash: sha256(spec) },
    activePlan: { revision: 1, path: planPath, contractRoot, contentHash: sha256(plan) },
    approval: {
      decision: "approved",
      planRevision: 1,
      planPath,
      planContentHash: sha256(plan),
      reviewPath: planReviewPath,
      approvedAt: "2026-08-31T20:00:00.000Z",
      blockingFindings: 0,
    },
    activeContract: { id: "01", path: contractPath },
    specialists,
    updatedAt: "2026-08-31T20:00:00.000Z",
  };
  const index: any = {
    schemaVersion: 1,
    contracts: [
      { kind: "phase", id: "01", dependsOn: [], planRevision: 1, path: contractPath, status: "in_progress", contentHash: sha256(firstContract) },
      { kind: "phase", id: "02", dependsOn: ["01"], planRevision: 1, path: secondContractPath, status: "pending", contentHash: sha256(secondContract) },
    ],
    contractFacts: {
      "01": { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true },
      "02": { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true },
    },
    consequentialSpecialists: [],
  };
  const writeManifest = () => write(cwd, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const writeIndex = () => write(cwd, indexPath, `${JSON.stringify(index, null, 2)}\n`);
  writeManifest();
  writeIndex();
  const request: CompleteCanonicalContractRequest = {
    cwd,
    topic: "demo",
    contractId: "01",
    expectedPlanRevision: 1,
    expectedContractPath: contractPath,
    expectedPreCompletionContentHash: sha256(firstContract),
    verification: { path: verificationPath, contentHash: sha256(verification) },
    review: { path: implementationReviewPath, contentHash: sha256(review), decision: "approve" },
    nextActiveContract: "advance",
    completedAt: "2026-08-31T20:30:00.000Z",
  };
  return {
    cwd,
    manifestPath,
    contractPath,
    secondContractPath,
    indexPath,
    verificationPath,
    implementationReviewPath,
    manifest,
    index,
    request,
    writeManifest,
    writeIndex,
  };
}

function writeLegacyCompatibilityFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-legacy-completion-"));
  const manifestPath = ".model-artifacts/initiatives/demo/specs/manifest.json";
  const specPath = ".model-artifacts/initiatives/demo/specs/spec.md";
  const planPath = ".model-artifacts/initiatives/demo/plans/plan.md";
  const contractRoot = ".model-artifacts/initiatives/demo/plans/revisions/r1";
  const phasePath = `${contractRoot}/phases/phase-1/phase.md`;
  const contractPath = `${contractRoot}/phases/phase-1/p1.1.md`;
  const secondContractPath = `${contractRoot}/phases/phase-1/p1.2.md`;
  const indexPath = `${contractRoot}/contracts.json`;
  const planReviewPath = ".model-artifacts/initiatives/demo/reports/plan-review.md";
  const verificationPath = ".model-artifacts/initiatives/demo/reports/verification.md";
  const implementationReviewPath = ".model-artifacts/initiatives/demo/reports/implementation-review.md";
  const spec = "# exact spec\n";
  const plan = "# exact plan\n";
  const phase = "# phase P1\n";
  const firstContract = "# contract P1.1\n";
  const secondContract = "# contract P1.2\n";
  const verificationEnvelope = { schemaVersion: 1, mode: "verification", topic: "demo", contractId: "P1.1", contractPath, planRevision: 1, contractContentHash: sha256(firstContract), outcome: "pass", gaps: "none" };
  const verification = `# Verification\n\nPi-SWE-Evidence: ${JSON.stringify(verificationEnvelope)}\n`;
  const reviewEnvelope = { schemaVersion: 1, mode: "implementation-review", topic: "demo", contractId: "P1.1", contractPath, planRevision: 1, contractContentHash: sha256(firstContract), decision: "approve", blockingFindings: 0, verification: { path: verificationPath, contentHash: sha256(verification) } };
  const review = `# Implementation review\n\nPi-SWE-Evidence: ${JSON.stringify(reviewEnvelope)}\n`;
  for (const [path, content] of [[specPath, spec], [planPath, plan], [phasePath, phase], [contractPath, firstContract], [secondContractPath, secondContract], [planReviewPath, "# approved\n"], [verificationPath, verification], [implementationReviewPath, review]] as const) write(cwd, path, content);
  const specialists: any = Object.fromEntries(CORE_SPECIALIST_IDS.filter((id) => id !== "accessibility-ux").map((id) => [id, { status: "not-required", rationale: `${id} is not consequential.` }]));
  specialists.accessibilityUx = { status: "not-required", rationale: "No user interface." };
  const manifest = {
    schemaVersion: 2, initiativeId: "demo", topic: "demo", initiativeState: "executing",
    activeSpec: { revision: 1, path: specPath, contentHash: sha256(spec) },
    activePlan: { revision: 1, path: planPath, contractRoot, contentHash: sha256(plan) },
    approval: { decision: "approve", planRevision: 1, planPath, planContentHash: sha256(plan), reviewPath: planReviewPath, approvedAt: "2026-09-03T18:00:00.000Z", blockingFindings: 0 },
    activeContract: { id: "P1.1", path: contractPath }, specialists, updatedAt: "2026-09-03T18:00:00.000Z",
  };
  const index = {
    schemaVersion: 1, topic: "demo", planRevision: 1,
    contracts: [
      { kind: "phase", id: "P1", dependencies: [], planRevision: 1, canonicalPath: phasePath, status: "approved_not_started", contentHash: sha256(phase) },
      { kind: "subphase", id: "P1.1", dependencies: [], planRevision: 1, canonicalPath: contractPath, status: "in_progress", contentHash: sha256(firstContract), readiness: { entryInputs: true, capabilities: true, applicability: false, acceptance: true, verification: true, approvedDeferrals: [] }, consequentialSpecialistIds: ["TDD", "SECURITY", "ACCESSIBILITY_UX"] },
      { kind: "subphase", id: "P1.2", dependencies: ["P1.1"], planRevision: 1, canonicalPath: secondContractPath, status: "awaiting_dependency", contentHash: sha256(secondContract), readiness: { entryInputs: false, capabilities: true, applicability: false, acceptance: true, verification: true, approvedDeferrals: [] }, consequentialSpecialistIds: ["TDD"] },
    ],
  };
  write(cwd, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  write(cwd, indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const request: CompleteCanonicalContractRequest = {
    cwd, topic: "demo", contractId: "P1.1", expectedPlanRevision: 1, expectedContractPath: contractPath,
    expectedPreCompletionContentHash: sha256(firstContract),
    verification: { path: verificationPath, contentHash: sha256(verification) },
    review: { path: implementationReviewPath, contentHash: sha256(review), decision: "approve" },
    nextActiveContract: "advance", completedAt: "2026-09-03T18:30:00.000Z",
  };
  return { cwd, manifestPath, indexPath, verificationPath, implementationReviewPath, request };
}

function completionRecord(request: CompleteCanonicalContractRequest, nextState: { initiativeState: "executing" | "finalizing"; activeContractId: string | null; readyContractIds: string[] }) {
  return {
    schemaVersion: 1,
    requestId: deriveCompletionRequestId(request),
    planRevision: request.expectedPlanRevision,
    contractPath: ".model-artifacts/initiatives/demo/plans/revisions/r1/contracts/01.md",
    preCompletionContentHash: request.expectedPreCompletionContentHash,
    verification: request.verification,
    review: request.review,
    completedAt: request.completedAt,
    nextState,
  };
}

function write(cwd: string, path: string, content: string): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
