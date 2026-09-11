import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inspectCanonicalInitiative } from "../extensions/pi-swe/src/planning.ts";
import {
  cleanupEvaluatorWorkspace,
  createEvaluatorRunRoot,
  materializeApprovedPlanFixture,
} from "../evals/pi-swe-autonomy/src/fixture.ts";
import {
  parseAggregateRecord,
  parseEvaluationEvent,
  parseFixtureRecord,
  parseTrialRecord,
  parseTrialScore,
} from "../evals/pi-swe-autonomy/src/types.ts";

test("approved-plan fixture materializes deterministically without shared writable files", () => {
  const runRoot = createEvaluatorRunRoot();
  try {
    const first = materializeApprovedPlanFixture(runRoot, "trial-a");
    const second = materializeApprovedPlanFixture(runRoot, "trial-b");

    assert.equal(first.fixture.contentTreeDigest, second.fixture.contentTreeDigest);
    assert.deepEqual(first.fixture.files, second.fixture.files);

    const relativePath = "src/counter.js";
    const firstFile = join(first.workspacePath, relativePath);
    const secondFile = join(second.workspacePath, relativePath);
    assert.notEqual(lstatSync(firstFile).ino, lstatSync(secondFile).ino);
    const original = readFileSync(secondFile, "utf8");
    writeFileSync(firstFile, "export const changed = true;\n", "utf8");
    assert.equal(readFileSync(secondFile, "utf8"), original);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("approved-plan fixture has three ordered executable contracts and valid canonical links", () => {
  const runRoot = createEvaluatorRunRoot();
  try {
    const materialized = materializeApprovedPlanFixture(runRoot, "canonical");
    const inspection = inspectCanonicalInitiative({ cwd: materialized.workspacePath, topic: "counter-evaluation" });
    const executable = inspection.contracts.filter((contract) => contract.kind === "subphase");

    assert.deepEqual(inspection.diagnostics, []);
    assert.deepEqual(executable.map((contract) => contract.id), ["P01-C01", "P01-C02", "P01-C03"]);
    assert.deepEqual(executable.map((contract) => contract.dependsOn), [[], ["P01-C01"], ["P01-C02"]]);
    assert.deepEqual(inspection.readyIds, ["P01-C01"]);
    assert.equal(inspection.gates.find((gate) => gate.id === "plan-approved")?.ready, true);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("evaluation record parsers reject unknown versions and missing identity fields", () => {
  const identity = {
    trialId: "trial-001",
    scenarioId: "approved-plan",
    provider: "openai",
    modelId: "gpt-example-1",
    thinkingLevel: "high",
    fixtureDigest: `sha256:${"a".repeat(64)}`,
  };
  const fixture = parseFixtureRecord({
    schemaVersion: 1,
    fixtureId: "approved-plan-v1",
    contentTreeDigest: identity.fixtureDigest,
    files: ["package.json"],
    contractIds: ["P01-C01", "P01-C02", "P01-C03"],
  });
  assert.equal(fixture.fixtureId, "approved-plan-v1");

  const trial = parseTrialRecord({
    schemaVersion: 1,
    ...identity,
    piVersion: "0.84.2",
    genticRevision: "abc123",
    resourceProfileId: "isolated-v1",
    promptHash: `sha256:${"b".repeat(64)}`,
    startedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(trial.trialId, identity.trialId);

  const event = parseEvaluationEvent({
    schemaVersion: 1,
    trialId: identity.trialId,
    sequence: 0,
    timestamp: "2026-09-11T00:00:01.000Z",
    kind: "prompt",
    payload: {},
  });
  assert.equal(event.sequence, 0);

  const score = parseTrialScore({
    schemaVersion: 1,
    ...identity,
    outcome: "passed",
    findings: [],
  });
  assert.equal(score.outcome, "passed");

  const aggregate = parseAggregateRecord({
    schemaVersion: 1,
    aggregateId: "aggregate-001",
    provider: identity.provider,
    modelId: identity.modelId,
    thinkingLevel: identity.thinkingLevel,
    scenarioId: identity.scenarioId,
    fixtureDigest: identity.fixtureDigest,
    trialIds: [identity.trialId],
  });
  assert.equal(aggregate.trialIds.length, 1);

  for (const [parser, value] of [
    [parseTrialRecord, { ...trial, schemaVersion: 2 }],
    [parseEvaluationEvent, { ...event, trialId: undefined }],
    [parseTrialScore, { ...score, modelId: "" }],
  ] as const) {
    assert.throws(() => parser(value), /schemaVersion|trialId|modelId/);
  }
});

test("cleanup rejects paths outside the evaluator-owned realpath", () => {
  const runRoot = createEvaluatorRunRoot();
  const outside = mkdtempSync(join(tmpdir(), "pi-swe-eval-outside-"));
  try {
    const materialized = materializeApprovedPlanFixture(runRoot, "safe");
    assert.throws(() => cleanupEvaluatorWorkspace(runRoot, outside), /outside evaluator run root/);
    assert.equal(existsSync(outside), true);

    const link = join(runRoot, "escape-link");
    symlinkSync(outside, link, "dir");
    assert.throws(() => cleanupEvaluatorWorkspace(runRoot, link), /outside evaluator run root/);
    assert.equal(existsSync(outside), true);

    cleanupEvaluatorWorkspace(runRoot, materialized.workspacePath);
    assert.equal(existsSync(materialized.workspacePath), false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
