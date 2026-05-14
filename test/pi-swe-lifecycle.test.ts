import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { evaluateAutonomousRunnerStep, PI_SWE_BLOCKED_CASE_HUMAN_REQUESTS, PI_SWE_LIFECYCLE_STATES, PI_SWE_LIFECYCLE_TRANSITIONS, reconstructAutonomousWorkState, validateLifecycleTransition, type PiSweBlockedCase, type PiSweLifecycleState } from "../extensions/pi-swe/src/lifecycle.ts";
import { inspectOrchestrationArtifacts, recommendOrchestrationTransition } from "../extensions/pi-swe/src/orchestrate.ts";

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
