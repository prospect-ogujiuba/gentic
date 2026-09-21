import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  contractFingerprint,
  parseInitiative,
  readyWork,
  transitionWork,
} from "../extensions/pi-swe/src/domain/initiative.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));
bootstrap.revision = 1;
bootstrap.evidence = [];
bootstrap.work = bootstrap.work.map((item: { kind: string }) => item.kind === "phase" ? item : { ...item, status: "pending" });
const clone = <T>(value: T): T => structuredClone(value);

test("schema accepts the approved bootstrap and is closed at every modeled boundary", () => {
  const initiative = parseInitiative(bootstrap);
  assert.equal(initiative.id, "pi-swe-foundation");
  assert.throws(() => parseInitiative({ ...clone(bootstrap), surprise: true }), /unknown field.*surprise/i);
  const nested = clone(bootstrap);
  nested.work[1].testing.surprise = true;
  assert.throws(() => parseInitiative(nested), /unknown field.*surprise/i);
});

test("schema rejects broken references, duplicate IDs, hierarchy overflow, parent dependencies, and cycles", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["duplicate", (value) => { value.work[2].id = "W-1"; }, /duplicate id W-1/i],
    ["criterion", (value) => { value.work[1].criterionIds = ["AC-missing"]; }, /unknown criterion/i],
    ["obligation", (value) => { value.work[1].obligationIds = ["O-missing"]; }, /unknown obligation/i],
    ["practice", (value) => { value.obligations[0].practiceId = "P-missing"; }, /unknown practice/i],
    ["parent dependency", (value) => { value.work[1].dependsOn = ["PH-2"]; }, /dependency.*executable leaf/i],
    ["cycle", (value) => { value.work[1].dependsOn = ["W-7"]; }, /dependency cycle/i],
    ["depth", (value) => { value.work.push({ id: "S-1", parentId: "W-1", kind: "subtask", title: "nested", status: "pending", dependsOn: [], criterionIds: ["AC-6"], obligationIds: ["O-1"], testing: { approach: "tdd", reason: "fixture" } }); value.work.push({ id: "S-2", parentId: "S-1", kind: "subtask", title: "too deep", status: "pending", dependsOn: [], criterionIds: ["AC-6"], obligationIds: ["O-1"], testing: { approach: "tdd", reason: "fixture" } }); }, /hierarchy depth/i],
  ];
  for (const [name, mutate, expected] of cases) {
    const value = clone(bootstrap);
    mutate(value);
    assert.throws(() => parseInitiative(value), expected, name);
  }
});

test("practice and obligation coverage cannot become empty ceremony", () => {
  const missingObligation = clone(bootstrap);
  missingObligation.practices.push({ id: "P-empty", practice: "empty", appliesTo: ["W-1"], reason: "fixture" });
  assert.throws(() => parseInitiative(missingObligation), /practice P-empty has no derived obligation/i);

  const outOfScope = clone(bootstrap);
  outOfScope.practices[0].appliesTo = ["W-1"];
  assert.throws(() => parseInitiative(outOfScope), /obligation O-2.*does not apply/i);
});

test("readiness is derived and legal leaf transitions keep implemented distinct from complete", () => {
  const initiative = parseInitiative(bootstrap);
  assert.deepEqual(readyWork(initiative).map((item) => item.id), ["W-1"]);
  const active = transitionWork(initiative, "W-1", "active");
  const implemented = transitionWork(active, "W-1", "implemented");
  assert.equal(implemented.work.find((item) => item.id === "W-1")?.status, "implemented");
  assert.throws(() => transitionWork(initiative, "W-1", "complete"), /illegal work transition/i);
  assert.throws(() => transitionWork(initiative, "W-2", "active"), /not ready/i);
});

test("contract fingerprints ignore bookkeeping but change with requirements", () => {
  const initiative = parseInitiative(bootstrap);
  const first = contractFingerprint(initiative);
  assert.equal(contractFingerprint({ ...initiative, revision: initiative.revision + 1 }), first);
  const changed = clone(initiative);
  changed.acceptanceCriteria[0].text += " changed";
  assert.notEqual(contractFingerprint(parseInitiative(changed)), first);
});
