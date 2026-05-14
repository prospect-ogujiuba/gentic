import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assessDsa } from "../extensions/pi-swe/src/domain/dsa.ts";
import { adviseTdd } from "../extensions/pi-swe/src/domain/tdd.ts";

const root = new URL("..", import.meta.url).pathname;

test("adviseTdd returns deterministic Red Green Refactor guidance", () => {
  assert.deepEqual(adviseTdd({ behavior: " saves edited todo title ", hasFailingTest: true }), {
    nextObservableBehavior: "saves edited todo title",
    testLevel: "unit",
    red: "Keep exactly one failing unit test focused on: saves edited todo title.",
    green: "Make the smallest production change that turns only that behavior green.",
    refactor: "Refactor only after the focused test is green; preserve behavior and keep scope to touched code.",
    verification: ["focused unit test", "nearby tests for touched code", "broader checks only if integration risk justifies them"],
    antiPatterns: [],
  });
});

test("adviseTdd detects common anti-patterns and defaults legacy work to characterization", () => {
  const advice = adviseTdd({ behavior: "preserves imported legacy records", legacyOrUnclearBehavior: true, productionChangedBeforeRed: true, refactorBeforeGreen: true });

  assert.equal(advice.testLevel, "characterization");
  assert.match(advice.red, /Write one failing characterization test first/);
  assert.deepEqual(advice.antiPatterns, ["production changed before Red", "refactor before Green", "missing failing test or characterization"]);
});

test("assessDsa recommends measure first for speculative optimization wishes", () => {
  const assessment = assessDsa({
    problemSummary: "Speed up lookup",
    currentImplementation: "Array scan over a small in-memory list",
    optimizationWishes: ["faster lookup"],
    evidence: "speculative",
    currentMeetsSemantics: true,
  });

  assert.equal(assessment.recommendation, "measure first; keep the current implementation until workload evidence justifies a change");
  assert.deepEqual(assessment.semanticRequirements, []);
  assert.deepEqual(assessment.optimizationWishes, ["faster lookup"]);
  assert.equal(assessment.confidence, "low");
  assert.match(assessment.complexityImpact, /unknown until measured/);
});

test("assessDsa prioritizes semantic requirements over optimization wishes", () => {
  const assessment = assessDsa({
    problemSummary: "Return events in priority order",
    currentImplementation: "FIFO queue",
    semanticRequirements: ["highest priority first"],
    optimizationWishes: ["lower allocation"],
    workload: { dominantOperations: ["insert", "pop max"], scale: "thousands per workspace", ordering: "priority" },
    evidence: "inferred",
    currentMeetsSemantics: false,
    proposedStructure: "priority queue",
    proposedAlgorithm: "heap push/pop",
  });

  assert.equal(assessment.recommendation, "change to priority queue with heap push/pop to satisfy semantic requirements");
  assert.deepEqual(assessment.rejectedAlternatives, ["keeping a structure that fails required behavior"]);
  assert.equal(assessment.confidence, "high");
  assert.match(assessment.workloadConstraints, /operations: insert, pop max/);
});

test("pi-swe helpers stay internal and expose no model-callable tools", () => {
  const entrypoint = readFileSync(join(root, "extensions/pi-swe/index.ts"), "utf8");
  const tdd = readFileSync(join(root, "extensions/pi-swe/src/tdd.ts"), "utf8");
  const dsa = readFileSync(join(root, "extensions/pi-swe/src/dsa.ts"), "utf8");

  assert.doesNotMatch(entrypoint, /\.\/src\/(?:tdd|dsa)\.ts/);
  assert.doesNotMatch(`${entrypoint}\n${tdd}\n${dsa}`, /registerTool\([^)]*(?:tdd|dsa|swe-tdd|swe-dsa)/i);
});
