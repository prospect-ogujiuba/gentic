import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { evaluateAutonomousRunnerStep, PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS, PI_SWE_LIFECYCLE_STATES, PI_SWE_LIFECYCLE_TRANSITIONS, reconstructAutonomousWorkState, validateLifecycleTransition, type PiSweBlockedCase, type PiSweLifecycleState } from "../extensions/pi-swe/src/lifecycle.ts";
import { inspectOrchestrationArtifacts, LegacyPlanInspector, recommendOrchestrationTransition } from "../extensions/pi-swe/src/orchestrate.ts";
import { inspectCanonicalInitiative, resolveInitiative } from "../extensions/pi-swe/src/planning.ts";
import { createRuntime, persistRepositoryRuntime, PI_SWE_STATE_DIAGNOSTIC_PATH_MAX_LENGTH, readRepositoryRuntime, reloadBranchRuntime, repositoryStatePath, validateActiveInitiative } from "../extensions/pi-swe/src/app/runtime.ts";
import { CORE_SPECIALIST_IDS } from "../extensions/pi-swe/src/domain/readiness.ts";

test("pi-swe lifecycle allows every defined transition and blocks undefined transitions deterministically", () => {
  for (const [state, nextStates] of Object.entries(PI_SWE_LIFECYCLE_TRANSITIONS) as Array<[PiSweLifecycleState, readonly PiSweLifecycleState[]]>) {
    for (const nextState of nextStates) {
      assert.deepEqual(validateLifecycleTransition({ state, nextState }), { allowed: true, state, nextState });
    }
  }

  const result = validateLifecycleTransition({
    state: "intake",
    nextState: "verify",
    outputs: { workOrder: ".model-artifacts/todo/demo/autonomous/work-order.md" },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "unknown-transition");
  assert.deepEqual(result.allowedNextStates, ["classify"]);
});

test("pi-swe reconstructs autonomous active state and next action from stable document paths", () => {
  const fixture = writeAutonomousFixture("implement");

  const reconstructed = reconstructAutonomousWorkState({ cwd: fixture.cwd, statePath: fixture.statePath });

  assert.equal(reconstructed.state, "implement");
  assert.equal(reconstructed.topic, "demo");
  assert.deepEqual(reconstructed.artifactPaths, {
    state: fixture.statePath,
    activePhase: fixture.paths.activePhase,
    workOrder: fixture.paths.workOrder,
    phaseIndex: fixture.paths.phaseIndex,
    diagnosisFinding: fixture.paths.diagnosisFinding,
    dsaDecision: fixture.paths.dsaDecision,
    implementationNote: fixture.paths.implementationNote,
    verificationReport: fixture.paths.verificationReport,
    reviewReport: fixture.paths.reviewReport,
    finalHandoff: fixture.paths.finalHandoff,
  });
  assert.deepEqual(reconstructed.nextAction, {
    stage: "implement",
    prompt: "swe-implement",
    readPaths: [fixture.statePath, fixture.paths.workOrder, fixture.paths.phaseIndex, fixture.paths.activePhase],
    writePath: fixture.paths.implementationNote,
    allowedNextStates: ["verify"],
  });
});

test("pi-swe inspects missing, partial, and complete orchestration artifact contracts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-orchestrate-artifacts-"));

  assert.deepEqual(inspectOrchestrationArtifacts({ cwd, topic: "demo" }), {
    topic: "demo",
    readiness: "missing",
    artifacts: {},
    missingRequired: ["workOrder", "plan", "implementation", "verification", "finalHandoff"],
  });

  const partialWorkOrder = ".model-artifacts/specs/demo/2026-05-14_1200-work-order.md";
  mkdirSync(dirname(join(cwd, partialWorkOrder)), { recursive: true });
  writeFileSync(join(cwd, partialWorkOrder), "# work order\n", "utf8");

  assert.deepEqual(inspectOrchestrationArtifacts({ cwd, topic: "demo" }), {
    topic: "demo",
    readiness: "partial",
    artifacts: { workOrder: partialWorkOrder },
    missingRequired: ["plan", "implementation", "verification", "finalHandoff"],
  });

  const completePaths = {
    plan: ".model-artifacts/plans/demo/2026-05-14_1210-plan.md",
    implementation: ".model-artifacts/logs/demo/2026-05-14_1220-implementation.md",
    verification: ".model-artifacts/reports/demo/2026-05-14_1230-verification.md",
    finalHandoff: ".model-artifacts/reports/demo/2026-05-14_1240-handoff.md",
  };
  for (const relativePath of Object.values(completePaths)) {
    mkdirSync(dirname(join(cwd, relativePath)), { recursive: true });
    writeFileSync(join(cwd, relativePath), `# ${relativePath}\n`, "utf8");
  }

  assert.deepEqual(inspectOrchestrationArtifacts({ cwd, topic: "demo" }), {
    topic: "demo",
    readiness: "complete",
    artifacts: { workOrder: partialWorkOrder, ...completePaths },
    missingRequired: [],
  });
});

test("pi-swe canonical inspector resolves an exact manifest and bounded contract index", () => {
  const fixture = writeCanonicalFixture();
  const result = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });

  assert.equal(result.sourceMode, "canonical");
  assert.equal(result.manifestPath, ".model-artifacts/specs/demo/manifest.json");
  assert.deepEqual(result.contracts.map((contract) => contract.id), ["01"]);
  assert.deepEqual(result.readyIds, ["01"]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.gates.find((gate) => gate.id === "plan-approved")?.ready, true);
});

test("pi-swe validates and atomically persists canonical runtime cursors", () => {
  const fixture = writeCanonicalFixture();
  const contractPath = ".model-artifacts/plans/demo/revisions/r1/contracts/01.md";
  fixture.manifest.activeContract = { id: "01", path: contractPath };
  fixture.writeManifest();
  const active = {
    topic: "demo",
    manifestPath: fixture.manifestPath,
    manifestSchemaVersion: 1,
    planRevision: 1,
    planPath: fixture.manifest.activePlan.path,
    contractId: "01",
    contractPath,
    lifecycle: { initiativeState: "approved" as const, contractStatus: "pending" as const },
    gates: { readyIds: ["stale-cache"], blockerCodes: ["stale-cache"] },
  };

  const valid = validateActiveInitiative(fixture.cwd, active);
  assert.deepEqual(valid.diagnostics, []);
  assert.deepEqual(valid.activeInitiative?.gates.readyIds, ["01"]);
  assert.deepEqual(persistRepositoryRuntime(fixture.cwd, valid.activeInitiative!), []);
  assert.equal(existsSync(join(fixture.cwd, repositoryStatePath("demo"))), true);
  const recovered = readRepositoryRuntime(fixture.cwd);
  assert.equal(recovered.state.activeInitiative?.topic, "demo");
  assert.equal(recovered.state.activeInitiative?.contractId, "01");
  assert.deepEqual(recovered.diagnostics, []);

  const escapingTopic = "../../../pi-swe-review-escape";
  const escapedPath = resolve(fixture.cwd, repositoryStatePath(escapingTopic));
  const escaped = persistRepositoryRuntime(fixture.cwd, { ...active, topic: escapingTopic });
  assert.equal(escaped[0]?.code, "invalid_state");
  assert.equal(existsSync(escapedPath), false);
  const oversizedTopic = persistRepositoryRuntime(fixture.cwd, { ...active, topic: "a".repeat(10_000) });
  assert.ok((oversizedTopic[0]?.path.length ?? 0) <= PI_SWE_STATE_DIAGNOSTIC_PATH_MAX_LENGTH);

  const symlinkCwd = mkdtempSync(join(tmpdir(), "pi-swe-state-symlink-"));
  const symlinkTarget = mkdtempSync(join(tmpdir(), "pi-swe-state-outside-"));
  mkdirSync(join(symlinkCwd, ".model-artifacts"));
  symlinkSync(symlinkTarget, join(symlinkCwd, ".model-artifacts/logs"), "dir");
  assert.equal(persistRepositoryRuntime(symlinkCwd, active)[0]?.code, "invalid_state");
  assert.equal(existsSync(join(symlinkTarget, "demo/state.json")), false);
  writeFixtureFile(symlinkTarget, "demo/state.json", "{}\n");
  const symlinkRead = readRepositoryRuntime(symlinkCwd);
  assert.equal(symlinkRead.diagnostics[0]?.code, "state_read_error");
  assert.equal(symlinkRead.diagnostics[0]?.path, ".model-artifacts/logs");

  const blockedCwd = mkdtempSync(join(tmpdir(), "pi-swe-state-write-failure-"));
  writeFileSync(join(blockedCwd, ".model-artifacts"), "not a directory", "utf8");
  assert.equal(persistRepositoryRuntime(blockedCwd, active)[0]?.code, "state_write_error");

  const stale = validateActiveInitiative(fixture.cwd, { ...active, planRevision: 2 });
  assert.equal(stale.activeInitiative, undefined);
  assert.equal(stale.diagnostics[0]?.code, "stale_plan_revision");

  const mismatchedContract = validateActiveInitiative(fixture.cwd, { ...active, contractPath: `${contractPath}.wrong` });
  assert.equal(mismatchedContract.activeInitiative?.contractId, undefined);
  assert.equal(mismatchedContract.diagnostics[0]?.code, "mismatched_contract_path");

  const omittedContract = validateActiveInitiative(fixture.cwd, { ...active, contractId: undefined, contractPath: undefined });
  assert.equal(omittedContract.activeInitiative?.contractId, undefined);
  assert.equal(omittedContract.diagnostics[0]?.code, "missing_contract");

  rmSync(join(fixture.cwd, contractPath));
  const missingContract = validateActiveInitiative(fixture.cwd, active);
  assert.equal(missingContract.activeInitiative?.contractId, undefined);
  assert.equal(missingContract.diagnostics[0]?.code, "missing_contract");

  rmSync(join(fixture.cwd, fixture.manifestPath));
  const missing = validateActiveInitiative(fixture.cwd, active);
  assert.equal(missing.activeInitiative, undefined);
  assert.equal(missing.diagnostics[0]?.code, "missing_manifest");
});

test("pi-swe invalidates cursors for stale plan and contract artifacts", () => {
  const stalePlan = writeCanonicalFixture();
  const stalePlanActive = activateCanonicalContract(stalePlan);
  writeFixtureFile(stalePlan.cwd, stalePlanActive.planPath, "# changed approved plan\n");
  const planResult = validateActiveInitiative(stalePlan.cwd, stalePlanActive);
  assert.equal(planResult.activeInitiative, undefined);
  assert.equal(planResult.diagnostics[0]?.code, "missing_plan");

  const staleContract = writeCanonicalFixture();
  const staleContractActive = activateCanonicalContract(staleContract);
  writeFixtureFile(staleContract.cwd, staleContractActive.contractPath, "# changed contract\n");
  const contractResult = validateActiveInitiative(staleContract.cwd, staleContractActive);
  assert.equal(contractResult.activeInitiative?.contractId, undefined);
  assert.equal(contractResult.diagnostics[0]?.code, "missing_contract");

  const staleRevision = writeCanonicalFixture({ contractPlanRevision: 2 });
  const staleRevisionActive = activateCanonicalContract(staleRevision);
  const revisionResult = validateActiveInitiative(staleRevision.cwd, staleRevisionActive);
  assert.equal(revisionResult.activeInitiative?.contractId, undefined);
  assert.equal(revisionResult.diagnostics[0]?.code, "missing_contract");
});

test("pi-swe clears a stale session stage before repository initiative fallback", () => {
  const fixture = writeCanonicalFixture();
  const active = activateCanonicalContract(fixture);
  assert.deepEqual(persistRepositoryRuntime(fixture.cwd, active), []);
  const staleSession = {
    ...active,
    topic: "missing",
    manifestPath: ".model-artifacts/specs/missing/manifest.json",
    planPath: ".model-artifacts/plans/missing/plan.md",
    contractPath: ".model-artifacts/plans/missing/revisions/r1/contracts/01.md",
  };
  const branch = [{
    type: "custom",
    customType: "gentic.swe.state",
    data: { version: 2, state: { activeInitiative: staleSession, activeStage: "implement" } },
  }];
  const ctx = {
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => branch },
    ui: { setWidget() {}, theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } },
  };
  const runtime = createRuntime(ctx as never);

  reloadBranchRuntime(runtime, ctx as never);

  assert.equal(runtime.state.activeInitiative?.topic, "demo");
  assert.equal(runtime.state.activeStage, undefined);
});

test("pi-swe reports bounded repository state discovery truncation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-state-scan-limit-"));
  for (let index = 0; index < 100; index += 1) {
    writeFixtureFile(cwd, `.model-artifacts/logs/topic-${index}/state.json`, "{}\n");
  }

  const result = readRepositoryRuntime(cwd);

  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "state_scan_limit"));
  assert.ok(result.diagnostics.length <= 20);
});

test("pi-swe canonical inspector never falls through from an invalid manifest to a legacy phase tree", () => {
  const fixture = writeCanonicalFixture();
  writeFixtureFile(fixture.cwd, ".model-artifacts/plans/demo/phases/99-valid-looking.md", "# legacy fallback bait\n");
  fixture.manifest.schemaVersion = 2;
  fixture.writeManifest();

  const result = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });
  assert.deepEqual(result.contracts, []);
  assert.deepEqual(result.readyIds, []);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_version" && diagnostic.path === fixture.manifestPath));
});

test("pi-swe canonical inspector reports missing links and exact topic mismatches", () => {
  const missing = writeCanonicalFixture();
  missing.manifest.activeSpec.path = ".model-artifacts/specs/demo/missing.md";
  missing.writeManifest();
  const missingResult = inspectCanonicalInitiative({ cwd: missing.cwd, topic: "demo" });
  assert.ok(missingResult.diagnostics.some((diagnostic) => diagnostic.code === "artifact_missing" && diagnostic.path.endsWith("missing.md")));
  assert.ok(missingResult.blockers.some((blocker) => blocker.code === "spec-artifact-missing"));

  const mismatch = writeCanonicalFixture();
  mismatch.manifest.topic = "other";
  mismatch.manifest.initiativeId = "other";
  mismatch.manifest.activeSpec.path = ".model-artifacts/specs/other/spec.md";
  mismatch.manifest.activePlan.path = ".model-artifacts/plans/other/plan.md";
  mismatch.manifest.activePlan.contractRoot = ".model-artifacts/plans/other/revisions/r1";
  mismatch.manifest.approval.planPath = mismatch.manifest.activePlan.path;
  mismatch.manifest.approval.reviewPath = ".model-artifacts/findings/other/review.md";
  mismatch.writeManifest();
  const mismatchResult = inspectCanonicalInitiative({ cwd: mismatch.cwd, topic: "demo" });
  assert.ok(mismatchResult.diagnostics.some((diagnostic) => diagnostic.code === "manifest_invalid" && diagnostic.field === "topic"));
  assert.deepEqual(mismatchResult.readyIds, []);
});

test("pi-swe canonical inspector exposes stale approval and wrong plan revision outcomes", () => {
  const stale = writeCanonicalFixture();
  stale.manifest.approval.planContentHash = `sha256:${"0".repeat(64)}`;
  stale.writeManifest();
  const staleResult = inspectCanonicalInitiative({ cwd: stale.cwd, topic: "demo" });
  assert.ok(staleResult.diagnostics.some((diagnostic) => diagnostic.code === "manifest_invalid" && diagnostic.field === "approval.planContentHash"));

  const wrongRevision = writeCanonicalFixture({ contractPlanRevision: 2 });
  const revisionResult = inspectCanonicalInitiative({ cwd: wrongRevision.cwd, topic: "demo" });
  assert.ok(revisionResult.blockers.some((blocker) => blocker.code === "contract-revision-stale" && blocker.contractId === "01"));
  assert.deepEqual(revisionResult.readyIds, []);
});

test("pi-swe canonical inspector rejects malformed deferral metadata without a ready result", () => {
  const fixture = writeCanonicalFixture({ deferral: { approved: "yes", evidencePath: "../escape" } });
  const result = inspectCanonicalInitiative({ cwd: fixture.cwd, topic: "demo" });

  assert.deepEqual(result.readyIds, []);
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "contract_index_invalid"
    && diagnostic.field === "contractFacts.01.deferral",
  ));
});

test("pi-swe canonical inspector accepts a symlinked cwd and diagnoses an unavailable cwd", () => {
  const fixture = writeCanonicalFixture();
  const symlinkCwd = `${fixture.cwd}-link`;
  symlinkSync(fixture.cwd, symlinkCwd, "dir");

  const result = inspectCanonicalInitiative({ cwd: symlinkCwd, topic: "demo" });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.readyIds, ["01"]);

  const missingCwd = `${fixture.cwd}-missing`;
  const unavailable = inspectCanonicalInitiative({ cwd: missingCwd, topic: "demo" });
  assert.deepEqual(unavailable.readyIds, []);
  assert.ok(unavailable.diagnostics.some((diagnostic) => diagnostic.code === "read_error" && diagnostic.path === missingCwd));
});

test("pi-swe orchestration retains its legacy API through an injectable inspector", () => {
  const expected = { topic: "demo", readiness: "complete", artifacts: { plan: "canonical" }, missingRequired: [] } as const;
  const result = inspectOrchestrationArtifacts(
    { cwd: "/unused", topic: "demo" },
    { inspect: () => ({ ...expected, missingRequired: [...expected.missingRequired] }) },
  );
  assert.deepEqual(result, expected);
});

test("pi-swe legacy adapter detects todo-phase plans only as legacy-unverified", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-legacy-inspector-"));
  writeFixtureFile(cwd, ".model-artifacts/todo/demo/phases/00-phase-index.md", "# legacy phase index\n");

  const result = new LegacyPlanInspector().inspect({ cwd, topic: "demo" });
  assert.equal(result.sourceMode, "legacy");
  assert.equal(result.status, "legacy-unverified");
  if (result.status !== "legacy-unverified") return;
  assert.equal(result.planPath, ".model-artifacts/todo/demo/phases/00-phase-index.md");
  assert.equal(result.nextAction, "adopt-legacy-plan");
  assert.deepEqual(result.adoptionRequirements, [
    "create a schema-v1 canonical manifest",
    "normalize the legacy plan into canonical plan revision r1",
    "validate the contract DAG and applicability",
    "complete plan review",
    "approve the reviewed canonical plan",
  ]);
  assert.equal("gates" in result, false);

  const nestedCwd = mkdtempSync(join(tmpdir(), "pi-swe-nested-legacy-inspector-"));
  writeFixtureFile(nestedCwd, ".model-artifacts/todo/team/demo/phases/00-phase-index.md", "# nested legacy phase index\n");
  const nested = resolveInitiative({ cwd: nestedCwd });
  assert.equal(nested.sourceMode, "legacy");
  assert.equal("topic" in nested ? nested.topic : undefined, "team/demo");
});

test("pi-swe initiative resolver honors selection, reports ambiguity, and never falls through malformed canonical state", () => {
  const fixture = writeCanonicalFixture();
  writeFixtureFile(fixture.cwd, ".model-artifacts/todo/demo/phases/00-phase-index.md", "# legacy plan\n");
  writeFixtureFile(fixture.cwd, ".model-artifacts/specs/other/manifest.json", "{}");

  const ambiguous = resolveInitiative({ cwd: fixture.cwd });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidateTopics, ["demo", "other"]);
  assert.ok("remediation" in ambiguous && ambiguous.remediation.includes("select one"));

  const persisted = resolveInitiative({ cwd: fixture.cwd, persistedTopic: "demo" });
  assert.equal(persisted.sourceMode, "canonical");
  assert.equal(persisted.sourceMode === "canonical" ? persisted.selectionSource : undefined, "persisted");

  const selected = resolveInitiative({ cwd: fixture.cwd, explicitTopic: "demo" });
  assert.equal(selected.sourceMode, "canonical");
  assert.equal(selected.status, "canonical");
  if (selected.sourceMode !== "canonical") return;
  assert.equal(selected.selectionSource, "explicit");
  assert.equal(selected.inspection.gates.find((gate) => gate.id === "plan-approved")?.ready, true);

  fixture.manifest.schemaVersion = 2;
  fixture.writeManifest();
  const malformed = resolveInitiative({ cwd: fixture.cwd, explicitTopic: "demo" });
  assert.equal(malformed.sourceMode, "canonical");
  if (malformed.sourceMode !== "canonical") return;
  assert.ok(malformed.inspection.diagnostics.some((diagnostic) => diagnostic.code === "unsupported_version"));
});

test("pi-swe todo canonical link enriches resolution without granting approval and no peer remains valid", () => {
  const completed = writeCanonicalFixture();
  completed.manifest.initiativeState = "complete";
  completed.writeManifest();
  const todoSelected = resolveInitiative({ cwd: completed.cwd, activeTodo: { canonicalInitiative: { topic: "demo" } } });
  assert.equal(todoSelected.sourceMode, "canonical");
  assert.equal(todoSelected.sourceMode === "canonical" ? todoSelected.selectionSource : undefined, "todo");

  const fixture = writeCanonicalFixture();
  fixture.manifest.initiativeState = "planning";
  delete fixture.manifest.approval;
  fixture.writeManifest();

  const noPeer = resolveInitiative({ cwd: fixture.cwd });
  assert.equal(noPeer.sourceMode, "canonical");
  assert.deepEqual("warnings" in noPeer ? noPeer.warnings : [], []);

  const linked = resolveInitiative({
    cwd: fixture.cwd,
    activeTodo: {
      id: "todo-1",
      canonicalInitiative: {
        topic: "demo",
        contractId: "01",
        contractPath: ".model-artifacts/plans/demo/revisions/r1/contracts/01.md",
        planRevision: 1,
        dependencies: [],
      },
    },
  });
  assert.equal(linked.sourceMode, "canonical");
  if (linked.sourceMode !== "canonical") return;
  assert.equal(linked.todoLink?.contractId, "01");
  assert.equal(linked.inspection.gates.find((gate) => gate.id === "plan-approved")?.ready, false);

  const conflictingPeer = resolveInitiative({ cwd: fixture.cwd, activeTodo: { canonicalInitiative: { topic: "other" } } });
  assert.equal(conflictingPeer.status, "ambiguous");
  assert.deepEqual(conflictingPeer.candidateTopics, ["demo", "other"]);

  const malformedPeer = resolveInitiative({ cwd: fixture.cwd, activeTodo: { canonicalInitiative: { topic: "../bad" } } });
  assert.equal(malformedPeer.sourceMode, "canonical");
  assert.ok("warnings" in malformedPeer && malformedPeer.warnings.some((warning) => warning.includes("malformed")));
});

test("pi-swe recommends deterministic orchestration transitions for feature, bug, DSA, and finalize gates", () => {
  assert.deepEqual(recommendOrchestrationTransition({ path: "feature", artifacts: { workOrder: "w" } }), {
    stage: "plan",
    prompt: "swe-plan",
    reason: "feature work needs a plan or phase contract before implementation",
    requiredArtifacts: ["plan"],
  });
  assert.deepEqual(recommendOrchestrationTransition({ path: "bug", artifacts: { workOrder: "w", plan: "p" } }), {
    stage: "diagnose",
    prompt: "swe-diagnose",
    reason: "bug work needs diagnosis before TDD or implementation",
    requiredArtifacts: ["diagnosis"],
  });
  assert.deepEqual(recommendOrchestrationTransition({ path: "dsa", artifacts: { workOrder: "w", plan: "p" } }), {
    stage: "dsa-assess",
    prompt: "swe-dsa",
    reason: "representation risk needs a DSA decision before implementation",
    requiredArtifacts: ["dsaDecision"],
  });
  assert.deepEqual(recommendOrchestrationTransition({ path: "finalize", riskyChange: true, artifacts: { workOrder: "w", plan: "p", implementation: "i", verification: "v" } }), {
    stage: "review",
    prompt: "swe-review",
    reason: "risky verified changes need review before finalization",
    requiredArtifacts: ["review"],
  });
  assert.deepEqual(recommendOrchestrationTransition({ path: "feature", artifacts: { workOrder: "w", plan: "p", implementation: "i", verification: "v", finalHandoff: "h" } }), {
    stage: "complete",
    reason: "required orchestration artifacts are present",
    requiredArtifacts: [],
  });
});

test("pi-swe runner stops repeated verify failures with an actionable blocked handoff", () => {
  const fixture = writeAutonomousFixture("verify");

  const decision = evaluateAutonomousRunnerStep({
    state: {
      topic: "demo",
      state: "verify",
      activePhase: fixture.paths.activePhase,
      retryCounts: { "verify->implement:assertion-still-failing": 2 },
      artifacts: {
        workOrder: fixture.paths.workOrder,
        phaseIndex: fixture.paths.phaseIndex,
        verificationReport: fixture.paths.verificationReport,
      },
    },
    event: {
      kind: "stage-failed",
      from: "verify",
      requestedNextState: "implement",
      failureSignature: "assertion-still-failing",
      evidencePath: fixture.paths.verificationReport,
    },
  });

  assert.deepEqual(decision, {
    terminal: true,
    terminalState: "blocked:repeat-failure",
    state: "blocked",
    blockedCase: "repeat-failure",
    humanRequest: "inspect failure and decide",
    artifactPath: fixture.paths.verificationReport,
    retryKey: "verify->implement:assertion-still-failing",
    retryCount: 2,
    retryBudget: 2,
  });
});

test("pi-swe runner advances the success path until terminal complete", () => {
  const fixture = writeAutonomousFixture("intake");
  const successPath: Array<[PiSweLifecycleState, PiSweLifecycleState]> = [
    ["intake", "classify"],
    ["classify", "plan"],
    ["plan", "implement"],
    ["implement", "verify"],
    ["verify", "review"],
    ["review", "finalize"],
    ["finalize", "complete"],
  ];

  const decisions = successPath.map(([from, nextState]) =>
    evaluateAutonomousRunnerStep({
      state: {
        topic: "demo",
        state: from,
        artifacts: { finalHandoff: fixture.paths.finalHandoff },
      },
      event: { kind: "stage-completed", from, nextState },
    }),
  );

  assert.deepEqual(
    decisions.map((decision) => decision.terminal ? decision.terminalState : decision.nextState),
    ["classify", "plan", "implement", "verify", "review", "finalize", "complete"],
  );
  assert.equal(decisions.at(-1)?.terminal, true);
});

test("pi-swe runner reaches terminal complete with a stable handoff artifact", () => {
  const fixture = writeAutonomousFixture("finalize");

  const decision = evaluateAutonomousRunnerStep({
    state: {
      topic: "demo",
      state: "finalize",
      activePhase: fixture.paths.activePhase,
      artifacts: {
        finalHandoff: fixture.paths.finalHandoff,
      },
    },
    event: {
      kind: "stage-completed",
      from: "finalize",
      nextState: "complete",
    },
  });

  assert.deepEqual(decision, {
    terminal: true,
    terminalState: "complete",
    state: "complete",
    humanRequest: "review completed handoff",
    artifactPath: fixture.paths.finalHandoff,
  });
});

test("pi-swe runner emits every covered blocked case with an actionable human request", () => {
  const fixture = writeAutonomousFixture("verify");
  const blockedCases = Object.keys(PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS) as PiSweBlockedCase[];

  for (const blockedCase of blockedCases) {
    const decision = evaluateAutonomousRunnerStep({
      state: { topic: "demo", state: "verify" },
      event: {
        kind: "blocked",
        blockedCase,
        artifactPath: fixture.paths.verificationReport,
      },
    });

    assert.deepEqual(decision, {
      terminal: true,
      terminalState: `blocked:${blockedCase}`,
      state: "blocked",
      blockedCase,
      humanRequest: PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS[blockedCase],
      artifactPath: fixture.paths.verificationReport,
    });
  }
});

test("pi-swe runner keeps bounded retries below budget and blocks scope drift", () => {
  const fixture = writeAutonomousFixture("verify");

  assert.deepEqual(
    evaluateAutonomousRunnerStep({
      state: {
        topic: "demo",
        state: "verify",
        retryCounts: { "verify->implement:one-focused-failure": 1 },
      },
      event: {
        kind: "stage-failed",
        from: "verify",
        requestedNextState: "implement",
        failureSignature: "one-focused-failure",
        evidencePath: fixture.paths.verificationReport,
        failedCheckMatchesActivePhase: true,
      },
    }),
    {
      terminal: false,
      state: "verify",
      nextState: "implement",
      retryKey: "verify->implement:one-focused-failure",
      retryCount: 1,
      retryBudget: 2,
    },
  );

  assert.deepEqual(
    evaluateAutonomousRunnerStep({
      state: { topic: "demo", state: "verify" },
      event: {
        kind: "stage-failed",
        from: "verify",
        requestedNextState: "implement",
        failureSignature: "different-phase-failure",
        evidencePath: fixture.paths.verificationReport,
        failedCheckMatchesActivePhase: false,
      },
    }),
    {
      terminal: true,
      terminalState: "blocked:scope-drift",
      state: "blocked",
      blockedCase: "scope-drift",
      humanRequest: "approve updated plan",
      artifactPath: fixture.paths.verificationReport,
    },
  );
});

test("pi-swe reconstructs a next action for every non-terminal lifecycle state", () => {
  const nonTerminalStates = PI_SWE_LIFECYCLE_STATES.filter((state) => state !== "complete" && state !== "blocked");

  for (const state of nonTerminalStates) {
    const fixture = writeAutonomousFixture(state);
    const reconstructed = reconstructAutonomousWorkState({ cwd: fixture.cwd, statePath: fixture.statePath });

    assert.equal(reconstructed.nextAction.stage, state);
    assert.deepEqual(reconstructed.nextAction.allowedNextStates, PI_SWE_LIFECYCLE_TRANSITIONS[state]);
    assert.equal(reconstructed.nextAction.readPaths[0], fixture.statePath);
    assert.ok(reconstructed.nextAction.readPaths.includes(fixture.paths.workOrder));
    assert.ok(reconstructed.nextAction.readPaths.includes(fixture.paths.activePhase));
  }

  const planFixture = writeAutonomousFixture("plan");
  assert.equal(reconstructAutonomousWorkState({ cwd: planFixture.cwd, statePath: planFixture.statePath }).nextAction.writePath, planFixture.paths.phaseIndex);
});

function writeCanonicalFixture(options: { contractPlanRevision?: number; deferral?: unknown } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-canonical-inspector-"));
  const manifestPath = ".model-artifacts/specs/demo/manifest.json";
  const specPath = ".model-artifacts/specs/demo/spec.md";
  const planPath = ".model-artifacts/plans/demo/plan.md";
  const contractRoot = ".model-artifacts/plans/demo/revisions/r1";
  const contractPath = `${contractRoot}/contracts/01.md`;
  const indexPath = `${contractRoot}/contracts.json`;
  const reviewPath = ".model-artifacts/findings/demo/review.md";
  const spec = "# exact canonical spec\n";
  const plan = "# exact canonical plan\n";
  const contract = "# phase 01\n";
  writeFixtureFile(cwd, specPath, spec);
  writeFixtureFile(cwd, planPath, plan);
  writeFixtureFile(cwd, contractPath, contract);
  writeFixtureFile(cwd, reviewPath, "# approved review\n");

  const specialists = Object.fromEntries(CORE_SPECIALIST_IDS.map((id) => [id, { status: "not-required", rationale: `${id} has no consequential work.` }]));
  const manifest: any = {
    schemaVersion: 1,
    initiativeId: "demo",
    topic: "demo",
    initiativeState: "approved",
    activeSpec: { revision: 1, path: specPath, contentHash: sha256(spec) },
    activePlan: { revision: 1, path: planPath, contractRoot, contentHash: sha256(plan) },
    specialists,
    approval: {
      decision: "approved",
      planRevision: 1,
      planPath,
      planContentHash: sha256(plan),
      reviewPath,
      approvedAt: "2026-08-30T12:00:00.000Z",
      blockingFindings: 0,
    },
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
  writeFixtureFile(cwd, indexPath, JSON.stringify({
    schemaVersion: 1,
    contracts: [{ kind: "phase", id: "01", dependsOn: [], planRevision: options.contractPlanRevision ?? 1, path: contractPath, status: "pending", contentHash: sha256(contract) }],
    contractFacts: { "01": { entryInputsAvailable: true, capabilitiesAvailable: true, applicability: "applicable", acceptanceDefined: true, verificationDefined: true, ...(options.deferral !== undefined ? { deferral: options.deferral } : {}) } },
    consequentialSpecialists: [],
  }));
  const writeManifest = () => writeFixtureFile(cwd, manifestPath, JSON.stringify(manifest));
  writeManifest();
  return { cwd, manifestPath, manifest, writeManifest };
}

function activateCanonicalContract(fixture: ReturnType<typeof writeCanonicalFixture>) {
  const contractPath = ".model-artifacts/plans/demo/revisions/r1/contracts/01.md";
  fixture.manifest.activeContract = { id: "01", path: contractPath };
  fixture.writeManifest();
  return {
    topic: "demo",
    manifestPath: fixture.manifestPath,
    manifestSchemaVersion: 1,
    planRevision: 1,
    planPath: fixture.manifest.activePlan.path as string,
    contractId: "01",
    contractPath,
    lifecycle: { initiativeState: "approved" as const, contractStatus: "pending" as const },
    gates: { readyIds: ["01"], blockerCodes: [] },
  };
}

function writeFixtureFile(cwd: string, relativePath: string, content: string): void {
  mkdirSync(dirname(join(cwd, relativePath)), { recursive: true });
  writeFileSync(join(cwd, relativePath), content, "utf8");
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function writeAutonomousFixture(state: PiSweLifecycleState) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-work-docs-"));
  const paths = {
    workOrder: ".model-artifacts/specs/demo/2026-05-14_1200-work-order.md",
    phaseIndex: ".model-artifacts/todo/demo/phases/00-phase-index.md",
    activePhase: ".model-artifacts/todo/demo/phases/02-stable-work-documents.md",
    diagnosisFinding: ".model-artifacts/findings/demo/2026-05-14_1205-diagnosis.md",
    dsaDecision: ".model-artifacts/findings/demo/2026-05-14_1206-dsa-decision.md",
    implementationNote: ".model-artifacts/logs/demo/2026-05-14_1210-implementation.md",
    verificationReport: ".model-artifacts/reports/demo/2026-05-14_1220-verification.md",
    reviewReport: ".model-artifacts/reports/demo/2026-05-14_1230-review.md",
    finalHandoff: ".model-artifacts/reports/demo/2026-05-14_1240-handoff.md",
  };

  for (const relativePath of Object.values(paths)) {
    mkdirSync(dirname(join(cwd, relativePath)), { recursive: true });
    writeFileSync(join(cwd, relativePath), `# ${relativePath}\n`, "utf8");
  }

  const statePath = ".model-artifacts/logs/demo/state.json";
  mkdirSync(dirname(join(cwd, statePath)), { recursive: true });
  writeFileSync(
    join(cwd, statePath),
    JSON.stringify({
      topic: "demo",
      state,
      activePhase: paths.activePhase,
      retryCounts: { implement: 1 },
      artifacts: {
        workOrder: paths.workOrder,
        phaseIndex: paths.phaseIndex,
        diagnosisFinding: paths.diagnosisFinding,
        dsaDecision: paths.dsaDecision,
        implementationNote: paths.implementationNote,
        verificationReport: paths.verificationReport,
        reviewReport: paths.reviewReport,
        finalHandoff: paths.finalHandoff,
      },
    }),
    "utf8",
  );

  return { cwd, paths, statePath };
}
