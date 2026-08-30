import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeContractGraph, type ContractNode } from "../extensions/pi-swe/src/domain/contract-graph.ts";
import { parseInitiativeManifest } from "../extensions/pi-swe/src/initiative.ts";

const topic = "pi-swe/canonical-planning";
const specPath = `.model-artifacts/specs/${topic}/2026-08-30_0331-initiative-spec-r2.md`;
const planPath = `.model-artifacts/plans/${topic}/2026-08-30_0333-plan-index-r1.md`;
const contractRoot = `.model-artifacts/plans/${topic}/revisions/r1`;
const reviewPath = `.model-artifacts/findings/${topic}/2026-08-30_0335-execution-plan-review.md`;

function draftManifest() {
  return {
    schemaVersion: 1,
    initiativeId: topic,
    topic,
    initiativeState: "planning",
    activeSpec: { revision: 2, path: specPath, contentHash: "sha256:spec-r2" },
    specialists: {},
    updatedAt: "2026-08-30T03:31:00.000Z",
  };
}

function approvedManifest() {
  return {
    ...draftManifest(),
    initiativeState: "approved",
    activePlan: { revision: 1, path: planPath, contractRoot, contentHash: "sha256:plan-r1" },
    approval: {
      decision: "approved",
      planRevision: 1,
      planPath,
      planContentHash: "sha256:plan-r1",
      reviewPath,
      approvedAt: "2026-08-30T03:35:00.000Z",
      blockingFindings: 0,
    },
  };
}

function diagnosticCodes(value: unknown): string[] {
  const result = parseInitiativeManifest(value);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

test("canonical initiative manifest parses valid draft and approved schema-v1 values", () => {
  const draft = parseInitiativeManifest(draftManifest());
  assert.equal(draft.ok, true);
  if (draft.ok) {
    assert.equal(draft.manifest.initiativeState, "planning");
    assert.equal(draft.manifest.topic, topic);
  }

  const approved = parseInitiativeManifest(approvedManifest());
  assert.equal(approved.ok, true);
  if (approved.ok) {
    assert.equal(approved.manifest.initiativeState, "approved");
    assert.equal(approved.manifest.approval.planRevision, approved.manifest.activePlan.revision);
    assert.equal(approved.manifest.approval.planPath, approved.manifest.activePlan.path);
  }
});

test("canonical initiative manifest rejects unsupported versions and invalid identities", () => {
  assert.deepEqual(diagnosticCodes({ ...draftManifest(), schemaVersion: 2 }), ["unsupported_schema_version"]);
  assert.ok(diagnosticCodes({ ...draftManifest(), topic: "../escape", initiativeId: "../escape" }).includes("invalid_topic"));
  assert.ok(diagnosticCodes({ ...draftManifest(), topic: "other/topic" }).includes("identity_mismatch"));
});

test("canonical initiative manifest rejects unsafe and non-canonical linked paths", () => {
  assert.ok(diagnosticCodes({ ...draftManifest(), activeSpec: { revision: 2, path: "../spec.md", contentHash: "sha256:x" } }).includes("invalid_path"));
  assert.ok(diagnosticCodes({ ...approvedManifest(), activePlan: { revision: 1, path: `.model-artifacts/todo/${topic}/phases/00-phase-index.md`, contractRoot, contentHash: "sha256:plan-r1" } }).includes("invalid_path"));
  assert.ok(diagnosticCodes({ ...draftManifest(), activeSpec: { revision: 2, path: "/tmp/spec.md", contentHash: "sha256:x" } }).includes("invalid_path"));
});

test("canonical initiative manifest rejects stale or incomplete approval", () => {
  assert.ok(diagnosticCodes({ ...approvedManifest(), approval: { ...approvedManifest().approval, planRevision: 2 } }).includes("stale_approval"));
  assert.ok(diagnosticCodes({ ...approvedManifest(), approval: { ...approvedManifest().approval, planContentHash: "sha256:stale" } }).includes("stale_approval"));
  assert.ok(diagnosticCodes({ ...approvedManifest(), approval: { ...approvedManifest().approval, blockingFindings: 1 } }).includes("blocking_findings"));
  const { approval: _approval, ...withoutApproval } = approvedManifest();
  assert.ok(diagnosticCodes(withoutApproval).includes("missing_field"));
});

const contractPath = (id: string) => `${contractRoot}/contracts/${id}.md`;

function phaseContract(id: string, dependsOn: readonly string[] = [], status: ContractNode["status"] = "pending"): ContractNode {
  return { kind: "phase", id, dependsOn, planRevision: 1, path: contractPath(id), status };
}

function subphaseContract(id: string, parentId: string, dependsOn: readonly string[] = [], status: ContractNode["status"] = "pending"): ContractNode {
  return { kind: "subphase", id, parentId, dependsOn, planRevision: 1, path: contractPath(id), status };
}

function graphDiagnosticCodes(contracts: readonly ContractNode[]): string[] {
  const result = analyzeContractGraph(contracts);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

test("contract graph returns deterministic linear order and ready set without mutating input", () => {
  const contracts = Object.freeze([
    Object.freeze(subphaseContract("01.02", "01", Object.freeze(["01.01"]))),
    Object.freeze(phaseContract("01", Object.freeze([]), "complete")),
    Object.freeze(subphaseContract("01.01", "01", Object.freeze(["01"]), "complete")),
  ]);
  const snapshot = structuredClone(contracts);

  const result = analyzeContractGraph(contracts);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.topologicalOrder, ["01", "01.01", "01.02"]);
    assert.deepEqual(result.ready, ["01.02"]);
  }
  assert.deepEqual(contracts, snapshot);
});

test("contract graph orders branching ties numerically and applies the readiness gate", () => {
  const contracts = [
    subphaseContract("01.10", "01", ["01"], "pending"),
    subphaseContract("01.02", "01", ["01"], "pending"),
    phaseContract("01", [], "complete"),
  ] as const;

  const gate = (contract: Readonly<ContractNode>) => contract.id !== "01.10";
  const result = analyzeContractGraph(contracts, gate);
  assert.deepEqual(analyzeContractGraph([...contracts].reverse(), gate), result);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.topologicalOrder, ["01", "01.02", "01.10"]);
    assert.deepEqual(result.ready, ["01.02"]);
  }
});

test("contract graph rejects duplicate, missing, self, and parent integrity errors", () => {
  assert.deepEqual(graphDiagnosticCodes([phaseContract("01"), phaseContract("01")]), ["duplicate_id"]);
  assert.deepEqual(graphDiagnosticCodes([phaseContract("01", ["02"])]), ["unknown_dependency"]);
  assert.deepEqual(graphDiagnosticCodes([phaseContract("01", ["01"])]), ["self_dependency"]);
  assert.deepEqual(graphDiagnosticCodes([subphaseContract("01.02", "02")]), ["parent_mismatch"]);
  assert.deepEqual(graphDiagnosticCodes([phaseContract("1")]), ["invalid_id"]);

  const invalidIds = [phaseContract("invalid-z"), phaseContract("invalid-a")];
  assert.deepEqual(analyzeContractGraph([...invalidIds].reverse()), analyzeContractGraph(invalidIds));
});

test("contract graph cycle diagnostics identify cycle members and return no executable result", () => {
  const result = analyzeContractGraph([
    phaseContract("01", ["02"]),
    phaseContract("02", ["01"]),
    phaseContract("03", ["02"]),
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostics, [{ code: "cycle", ids: ["01", "02"], message: "dependency cycle involves: 01, 02" }]);
  }
});

test("contract graph defines empty and single-contract results", () => {
  const empty = analyzeContractGraph([]);
  assert.deepEqual(empty, { ok: true, topologicalOrder: [], ready: [] });

  const single = analyzeContractGraph([phaseContract("01")]);
  assert.deepEqual(single, { ok: true, topologicalOrder: ["01"], ready: ["01"] });
});
