import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { VerificationCollector } from "../extensions/pi-swe/src/app/verification.ts";
import { completionBlockers, completeWork } from "../extensions/pi-swe/src/domain/completion.ts";
import { parseInitiative, transitionWork } from "../extensions/pi-swe/src/domain/initiative.ts";
import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { InitiativeStore, initiativePath } from "../extensions/pi-swe/src/app/store.ts";

const bootstrap = JSON.parse(readFileSync(new URL("../.model-artifacts/initiatives/pi-swe-foundation/workflow.json", import.meta.url), "utf8"));
bootstrap.evidence = [];
bootstrap.work = bootstrap.work.map((item: { kind: string }) => item.kind === "phase" ? item : { ...item, status: "pending" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-evidence-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/bug.ts"), "export const value = 0;\n");
  const initiative = parseInitiative({
    ...structuredClone(bootstrap), id: "fixture", artifacts: [],
    work: bootstrap.work.map((item: any) => item.id === "W-1" ? { ...item, obligationIds: ["O-1"] } : item),
  });
  return { root, initiative, collector: new VerificationCollector(root, { now: sequenceClock() }) };
}

function sequenceClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 17, 0, tick++)).toISOString();
}

test("collector binds an ordinary permitted bash tool call to actual failed and passing outcomes", () => {
  const { root, initiative, collector } = fixture();
  try {
    const red = collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: "node --test test/bug.test.ts", relevantPaths: ["src/bug.ts"] });
    assert.equal(collector.observeToolCall({ toolCallId: "red-call", toolName: "bash", input: { command: red.command } }, root), true);
    const failed = collector.observeToolResult({ toolCallId: "red-call", toolName: "bash", isError: true, content: [{ type: "text", text: "AssertionError: expected 1" }] });
    assert.equal(failed?.outcome, "failed");
    assert.equal(failed?.provenance.permissionBoundary, "ordinary-bash-tool-call");
    assert.deepEqual(failed?.execution, { executable: "bash", args: ["-lc", "node --test test/bug.test.ts"], cwd: "." });

    writeFileSync(join(root, "src/bug.ts"), "export const value = 1;\n");
    const green = collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: red.command, relevantPaths: ["src/bug.ts"] });
    collector.observeToolCall({ toolCallId: "green-call", toolName: "bash", input: { command: green.command } }, root);
    const passed = collector.observeToolResult({ toolCallId: "green-call", toolName: "bash", isError: false, content: [{ type: "text", text: "1 test passed" }] });
    assert.equal(passed?.outcome, "passed");
    assert.equal(passed?.source.before.hash, passed?.source.after.hash);
    assert.notEqual(failed?.source.after.hash, passed?.source.after.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collector ignores mismatched calls and cannot turn missing or aborted results into evidence", () => {
  const { root, initiative, collector } = fixture();
  try {
    collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/bug.ts"] });
    assert.equal(collector.observeToolCall({ toolCallId: "wrong", toolName: "bash", input: { command: "npm run typecheck" } }, root), false);
    assert.equal(collector.observeToolResult({ toolCallId: "wrong", toolName: "bash", isError: false, content: [] }), undefined);
    assert.equal(collector.abort("user cancelled"), true);
    assert.deepEqual(collector.drainEvidence(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relevant snapshots include missing/new files and reject unsafe, symlinked, or unbounded paths", () => {
  const { root, initiative, collector } = fixture();
  try {
    const pending = collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/new.ts"] });
    writeFileSync(join(root, "src/new.ts"), "new source\n");
    collector.observeToolCall({ toolCallId: "new", toolName: "bash", input: { command: pending.command } }, root);
    const evidence = collector.observeToolResult({ toolCallId: "new", toolName: "bash", isError: false, content: [] });
    assert.notEqual(evidence?.source.before.hash, evidence?.source.after.hash);
    assert.throws(() => collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["../secret"] }), /safe project-relative/i);
    assert.throws(() => collector.prepare(initiative, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: Array.from({ length: 257 }, (_, i) => `src/${i}.ts`) }), /at most 256/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion requires each obligation's declared evidence kinds and RED before GREEN", () => {
  const { root, initiative, collector } = fixture();
  try {
    const configured = parseInitiative({
      ...initiative,
      obligations: initiative.obligations.map((item) => item.id === "O-1"
        ? { ...item, verification: { kind: "review-and-tests", requiredEvidence: ["machine-command", "model-review"], sequence: "red-green" } }
        : item),
    });
    const implemented = transitionWork(transitionWork(configured, "W-1", "active"), "W-1", "implemented");
    assert.match(completionBlockers(implemented, "W-1", root).join(" "), /missing machine-command evidence/i);

    const redRequest = collector.prepare(implemented, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/bug.ts"] });
    collector.observeToolCall({ toolCallId: "red", toolName: "bash", input: { command: redRequest.command } }, root);
    const red = collector.observeToolResult({ toolCallId: "red", toolName: "bash", isError: true, content: [{ type: "text", text: "intended regression" }] })!;
    const greenRequest = collector.prepare(implemented, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/bug.ts"] });
    collector.observeToolCall({ toolCallId: "green", toolName: "bash", input: { command: greenRequest.command } }, root);
    const green = collector.observeToolResult({ toolCallId: "green", toolName: "bash", isError: false, content: [{ type: "text", text: "pass" }] })!;
    const machineOnly = parseInitiative({ ...implemented, evidence: [red, green] });
    assert.match(completionBlockers(machineOnly, "W-1", root).join(" "), /missing model-review evidence/i);

    const review = {
      id: "E-review", kind: "model-review", workId: "W-1", obligationIds: ["O-1"], outcome: "passed",
      reviewedAt: "2026-09-21T18:00:00.000Z", contractFingerprint: green.contractFingerprint,
      source: green.source.after, dimensions: ["correctness", "security-boundary"],
      summary: "Reviewed permission boundary and completion behavior; no blocking findings.",
      provenance: { kind: "pi-model-self-review", sessionId: "fixture-session" },
    };
    const reviewed = parseInitiative({ ...implemented, evidence: [red, green, review] });
    assert.deepEqual(completionBlockers(reviewed, "W-1", root), []);
    assert.equal(completeWork(reviewed, "W-1", root).work.find((item) => item.id === "W-1")?.status, "complete");

    const noRed = parseInitiative({ ...implemented, evidence: [green, review] });
    assert.match(completionBlockers(noRed, "W-1", root).join(" "), /RED.*before.*GREEN/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review evidence is runtime-created, self-review-labelled, and source-fresh", async () => {
  const { root, initiative } = fixture();
  try {
    const configured = parseInitiative({
      ...initiative,
      obligations: initiative.obligations.map((item) => item.id === "O-1"
        ? { ...item, verification: { kind: "review", requiredEvidence: ["model-review"] } }
        : item),
    });
    const implemented = transitionWork(transitionWork(configured, "W-1", "active"), "W-1", "implemented");
    const path = initiativePath(root, "fixture");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(implemented, null, 2)}\n`);
    const service = new SweService(root, new InitiativeStore(root), new VerificationCollector(root));
    const stored = await service.recordReview("fixture", {
      workId: "W-1", obligationIds: ["O-1"], outcome: "passed", relevantPaths: ["src/bug.ts"],
      dimensions: ["correctness"], summary: "No blocking correctness findings.", sessionId: "runtime-session",
    });
    const review = stored.initiative.evidence[0];
    assert.equal(review.kind, "model-review");
    assert.deepEqual(review.provenance, { kind: "pi-model-self-review", sessionId: "runtime-session" });
    assert.deepEqual(completionBlockers(stored.initiative, "W-1", root), []);
    writeFileSync(join(root, "src/bug.ts"), "changed after review\n");
    assert.match(completionBlockers(stored.initiative, "W-1", root).join(" "), /stale source/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completion rejects failed, stale, wrong-contract, and model-forged waiver evidence", () => {
  const { root, initiative, collector } = fixture();
  try {
    const machineInitiative = parseInitiative({
      ...initiative,
      obligations: initiative.obligations.map((item) => item.id === "O-1"
        ? { ...item, verification: { kind: "automated-tests", requiredEvidence: ["machine-command"] } }
        : item),
    });
    const implemented = transitionWork(transitionWork(machineInitiative, "W-1", "active"), "W-1", "implemented");
    assert.match(completionBlockers(implemented, "W-1", root).join(" "), /missing machine-command evidence/i);

    const pending = collector.prepare(implemented, { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/bug.ts"] });
    collector.observeToolCall({ toolCallId: "pass", toolName: "bash", input: { command: pending.command } }, root);
    const passing = collector.observeToolResult({ toolCallId: "pass", toolName: "bash", isError: false, content: [{ type: "text", text: "pass" }] })!;
    const evidenced = parseInitiative({ ...implemented, evidence: [passing] });
    assert.deepEqual(completionBlockers(evidenced, "W-1", root), []);
    assert.equal(completeWork(evidenced, "W-1", root).work.find((item) => item.id === "W-1")?.status, "complete");
    const laterFailure = parseInitiative({ ...implemented, evidence: [passing, { ...passing, id: "E-later-failure", outcome: "failed", completedAt: "2026-09-21T18:00:00.000Z" }] });
    assert.match(completionBlockers(laterFailure, "W-1", root).join(" "), /latest machine-command evidence.*failed/i);

    writeFileSync(join(root, "src/bug.ts"), "changed after verification\n");
    assert.match(completionBlockers(evidenced, "W-1", root).join(" "), /stale source/i);
    const wrongContract = parseInitiative({ ...implemented, evidence: [{ ...passing, contractFingerprint: `sha256:${"0".repeat(64)}` }] });
    assert.match(completionBlockers(wrongContract, "W-1", root).join(" "), /current contract/i);
    assert.throws(() => parseInitiative({ ...implemented, evidence: [{ id: "E-waiver", kind: "human-waiver", actor: "model", workId: "W-1", obligationIds: ["O-1"], outcome: "passed" }] }), /evidence kind|unknown field|human waiver/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
