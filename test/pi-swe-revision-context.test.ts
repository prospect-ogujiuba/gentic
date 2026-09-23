import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { hashInitiativeArtifacts } from "../extensions/pi-swe/src/app/artifacts.ts";
import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { InitiativeStore, initiativePath } from "../extensions/pi-swe/src/app/store.ts";
import {
  buildSweContextProjection,
  refreshSweContextMessages,
  SWE_CONTEXT_TYPE,
  SWE_FOCUS_ENTRY_TYPE,
} from "../extensions/pi-swe/src/pi/context.ts";
import { contractFingerprint, parseInitiative } from "../extensions/pi-swe/src/domain/initiative.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-revision-"));
  const path = initiativePath(root, "pi-swe-foundation");
  mkdirSync(dirname(path), { recursive: true });
  const value = structuredClone(bootstrap);
  value.artifacts = [];
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return { root, path, store: new InitiativeStore(root) };
}

test("intentional revision invalidates old contracts while preserving evidence and completed work", async () => {
  const { root, store } = fixture();
  try {
    const service = new SweService(root, store);
    const before = store.read("pi-swe-foundation");
    const oldFingerprint = contractFingerprint(before.initiative);
    const proposal = structuredClone(before.initiative);
    proposal.objective += " Revised intentionally.";
    const revised = await service.revise("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "Clarify the approved contract after implementation feedback.",
      proposal,
    });
    assert.notEqual(contractFingerprint(revised.initiative), oldFingerprint);
    assert.deepEqual(revised.initiative.evidence, before.initiative.evidence);
    assert.equal(revised.initiative.work.find((item) => item.id === "W-5")?.status, "complete");
    assert.ok(revised.initiative.evidence.some((item) => item.contractFingerprint !== contractFingerprint(revised.initiative)));

    const rewind = structuredClone(revised.initiative);
    rewind.work.find((item) => item.id === "W-5")!.status = "pending";
    await assert.rejects(() => service.revise("pi-swe-foundation", {
      expectedRevision: revised.initiative.revision,
      expectedHash: revised.hash,
      reason: "Attempt to rewind completed history.",
      proposal: rewind,
    }), /rewind|completed work/i);

    const rewritten = structuredClone(revised.initiative);
    rewritten.work.find((item) => item.id === "W-5")!.title += " rewritten";
    await assert.rejects(() => service.revise("pi-swe-foundation", {
      expectedRevision: revised.initiative.revision,
      expectedHash: revised.hash,
      reason: "Attempt to rewrite completed contract.",
      proposal: rewritten,
    }), /cannot rewrite completed work/i);

    const bypass = structuredClone(revised.initiative);
    const added = { ...structuredClone(bypass.work.find((item) => item.id === "W-7")!), id: "W-added", status: "complete" };
    bypass.work.push(added);
    for (const obligationId of added.obligationIds) {
      const obligation = bypass.obligations.find((item) => item.id === obligationId)!;
      const appliesTo = bypass.practices.find((item) => item.id === obligation.practiceId)!.appliesTo;
      if (!appliesTo.includes(added.id)) appliesTo.push(added.id);
    }
    await assert.rejects(() => service.revise("pi-swe-foundation", {
      expectedRevision: revised.initiative.revision,
      expectedHash: revised.hash,
      reason: "Attempt to add pre-completed work.",
      proposal: bypass,
    }), /must begin pending/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intentional revision uses caller CAS so concurrent proposals cannot overwrite", async () => {
  const { root, store } = fixture();
  try {
    const before = store.read("pi-swe-foundation");
    const serviceA = new SweService(root, store);
    const serviceB = new SweService(root, new InitiativeStore(root));
    const request = (suffix: string) => ({
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: `Concurrent revision ${suffix}.`,
      proposal: { ...structuredClone(before.initiative), objective: `${before.initiative.objective} ${suffix}` },
    });
    const results = await Promise.allSettled([
      serviceA.revise("pi-swe-foundation", request("A")),
      serviceB.revise("pi-swe-foundation", request("B")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /stale initiative/i.test(String(result.reason))).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact hashing accepts only canonical topic-first regular files and verifies declared hashes", () => {
  const { root } = fixture();
  try {
    const relative = ".model-artifacts/initiatives/pi-swe-foundation/reports/2026-09-21_1801-w6.md";
    const artifactPath = join(root, relative);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, "bounded report\n");
    const initiative = parseInitiative({
      ...structuredClone(bootstrap),
      artifacts: [{ path: relative, type: "report", relatedWork: ["W-6"], summary: "W-6 evidence summary." }],
    });
    const hashed = hashInitiativeArtifacts(root, initiative);
    assert.match(hashed.artifacts[0].contentHash!, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(hashInitiativeArtifacts(root, hashed), hashed);

    const wrongTopic = structuredClone(initiative);
    wrongTopic.artifacts[0].path = ".model-artifacts/initiatives/other/reports/2026-09-21_1801-w6.md";
    assert.throws(() => hashInitiativeArtifacts(root, wrongTopic), /initiative topic|canonical artifact/i);
    const nonCanonical = structuredClone(initiative);
    nonCanonical.artifacts[0].path = ".model-artifacts/initiatives/pi-swe-foundation/reports/latest.md";
    assert.throws(() => parseInitiative(nonCanonical), /safe canonical path/i);

    writeFileSync(artifactPath, "changed report\n");
    assert.throws(() => hashInitiativeArtifacts(root, hashed), /content hash mismatch/i);

    rmSync(artifactPath);
    symlinkSync(join(root, "outside.md"), artifactPath);
    writeFileSync(join(root, "outside.md"), "outside\n");
    assert.throws(() => hashInitiativeArtifacts(root, initiative), /symbolic link|regular file/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh SWE context is bounded, collapses completed work, and replaces only SWE-owned messages", () => {
  const focused = structuredClone(bootstrap);
  focused.work = focused.work.map((item: any) => item.id === "W-6" ? { ...item, status: "active" }
    : item.id === "W-7" ? { ...item, status: "pending" }
    : item);
  const initiative = parseInitiative(focused);
  const projection = buildSweContextProjection(initiative, { maxChars: 6_000 });
  assert.ok(projection.length <= 6_000, `projection was ${projection.length} chars`);
  assert.match(projection, new RegExp(`revision ${initiative.revision}`, "i"));
  assert.match(projection, /W-6.*active/i);
  assert.match(projection, /completed work: 5/i);
  assert.doesNotMatch(projection, /W-1.*Retire/i);
  assert.doesNotMatch(projection, /"evidence"/i);

  const other = { role: "custom", customType: "other-extension", content: "keep me" };
  const stale = { role: "custom", customType: SWE_CONTEXT_TYPE, content: "revision 1 stale" };
  const normal = { role: "user", content: [{ type: "text", text: "continue" }] };
  const refreshed = refreshSweContextMessages([other, stale, normal], projection);
  assert.equal(refreshed.filter((message) => message.customType === SWE_CONTEXT_TYPE).length, 1);
  assert.equal(refreshed.find((message) => message.customType === SWE_CONTEXT_TYPE)?.content, projection);
  assert.ok(refreshed.includes(other));
  assert.ok(refreshed.includes(normal));
});

test("fork, resume, and tree context rebuild from repository authority instead of stale session state", async () => {
  const { root, store } = fixture();
  try {
    const handlers = new Map<string, Function[]>();
    const appended: Array<{ type: string; data: unknown }> = [];
    piSwe({
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerCommand() {},
      registerTool() {},
      appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
      sendMessage() {},
    } as never);
    const staleEntries = [{
      type: "custom", customType: SWE_FOCUS_ENTRY_TYPE,
      data: { initiativeId: "pi-swe-foundation", observedRevision: 1, initiative: { revision: 1, status: "active" } },
    }];
    const ctx = { cwd: root, sessionManager: { getEntries: () => staleEntries } };

    for (const reason of ["fork", "resume"]) {
      for (const handler of handlers.get("session_start") ?? []) await handler({ reason }, ctx);
      const initial = await handlers.get("before_agent_start")![0]!({ prompt: "continue" }, ctx);
      assert.match(initial.message.content, new RegExp(`revision ${store.read("pi-swe-foundation").initiative.revision}`));
      assert.doesNotMatch(initial.message.content, /revision 1\b/);
    }

    const before = store.read("pi-swe-foundation");
    const service = new SweService(root, new InitiativeStore(root));
    const revised = await service.revise("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "Advance authority before tree context reconstruction.",
      proposal: { ...structuredClone(before.initiative), objective: `${before.initiative.objective} Fresh repository authority.` },
    });
    const other = { role: "custom", customType: "other-extension", content: "preserve" };
    const result = await handlers.get("context")![0]!({ messages: [other, { role: "custom", customType: SWE_CONTEXT_TYPE, content: "stale" }] }, ctx);
    assert.match(result.messages.at(-1).content, new RegExp(`revision ${revised.initiative.revision}`));
    assert.match(result.messages.at(-1).content, /Fresh repository authority/);
    assert.ok(result.messages.includes(other));
    assert.deepEqual(appended, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
