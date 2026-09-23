import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { InitiativeStore, InitiativeStoreError, initiativePath } from "../extensions/pi-swe/src/app/store.ts";

const source = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function proposal(id = "new-initiative") {
  const value = structuredClone(source);
  value.id = id;
  value.revision = 1;
  value.status = "draft";
  value.evidence = [];
  value.artifacts = [];
  value.work = value.work.map((item: any) => {
    if (item.kind === "phase") return item;
    const { disposition: _disposition, ...rest } = item;
    return { ...rest, status: "pending" };
  });
  return value;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-create-"));
  return { root, store: new InitiativeStore(root), service: new SweService(root) };
}

test("create publishes validated authority and supports status then start", async () => {
  const { root, service } = fixture();
  try {
    const created = await service.create("new-initiative", proposal());
    assert.equal(created.initiative.revision, 1);
    assert.equal(service.status("new-initiative").hash, created.hash);
    const started = await service.start("new-initiative", "W-1");
    assert.equal(started.initiative.revision, 2);
    assert.equal(started.initiative.work.find((item) => item.id === "W-1")?.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create resolves and verifies canonical artifact hashes", async () => {
  const { root, store } = fixture();
  try {
    const value = proposal("artifact-initiative");
    const artifactPath = ".model-artifacts/initiatives/artifact-initiative/plans/2026-09-22_0337-bootstrap-plan.md";
    mkdirSync(join(root, ".model-artifacts/initiatives/artifact-initiative/plans"), { recursive: true });
    writeFileSync(join(root, artifactPath), "# Bootstrap plan\n");
    value.artifacts = [{ path: artifactPath, type: "plan", relatedWork: ["W-1"], summary: "Reviewed bootstrap plan." }];
    const created = await store.create("artifact-initiative", value);
    assert.match(created.initiative.artifacts[0].contentHash ?? "", /^sha256:[a-f0-9]{64}$/);

    const mismatch = proposal("mismatched-artifact");
    const mismatchPath = ".model-artifacts/initiatives/mismatched-artifact/plans/2026-09-22_0337-bootstrap-plan.md";
    mkdirSync(join(root, ".model-artifacts/initiatives/mismatched-artifact/plans"), { recursive: true });
    writeFileSync(join(root, mismatchPath), "# Bootstrap plan\n");
    mismatch.artifacts = [{ path: mismatchPath, type: "plan", relatedWork: ["W-1"], summary: "Reviewed bootstrap plan.", contentHash: `sha256:${"0".repeat(64)}` }];
    await assert.rejects(() => store.create("mismatched-artifact", mismatch), /artifact content hash mismatch/i);
    assert.equal(existsSync(initiativePath(root, "mismatched-artifact")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create never overwrites existing authority", async () => {
  const { root, service } = fixture();
  try {
    const first = await service.create("new-initiative", proposal());
    const bytes = readFileSync(first.path);
    await assert.rejects(() => service.create("new-initiative", proposal()), (error: unknown) => {
      assert.ok(error instanceof InitiativeStoreError);
      assert.equal(error.code, "already-exists");
      return true;
    });
    assert.deepEqual(readFileSync(first.path), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects malformed, mismatched, and non-initial proposals", async () => {
  const { root, service } = fixture();
  try {
    await assert.rejects(() => service.create("new-initiative", { nope: true }), /unsupported initiative schema/i);
    await assert.rejects(() => service.create("expected-id", proposal("other-id")), /identity mismatch/i);
    const cases: Array<[string, (value: any) => void, RegExp]> = [
      ["revision", (value) => { value.revision = 2; }, /revision must be 1/i],
      ["status", (value) => { value.status = "active"; }, /status must be draft/i],
      ["evidence", (value) => { value.evidence = [source.evidence[0]]; }, /evidence must be empty/i],
      ["work status", (value) => { value.work.find((item: any) => item.kind !== "phase").status = "active"; }, /must be pending/i],
      ["work disposition", (value) => { value.work.find((item: any) => item.kind !== "phase").disposition = { kind: "cancelled", reason: "not initial" }; }, /without a disposition/i],
      ["empty work", (value) => { value.acceptanceCriteria = []; value.practices = []; value.obligations = []; value.work = []; }, /must contain executable work/i],
      ["work without verification", (value) => { value.practices = []; value.obligations = []; value.work = value.work.map((item: any) => item.kind === "phase" ? item : { ...item, obligationIds: [] }); }, /must carry verification obligations/i],
    ];
    for (const [name, mutate, expected] of cases) {
      const value = proposal();
      mutate(value);
      await assert.rejects(() => service.create("new-initiative", value), expected, name);
    }
    assert.equal(existsSync(initiativePath(root, "new-initiative")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects parent swaps during publication and cleans stable lock/temp names", async () => {
  const { root } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-swe-swap-outside-"));
  try {
    const path = initiativePath(root, "swapped-parent");
    let moved = "";
    const store = new InitiativeStore(root, { fault: (stage) => {
      if (stage !== "before-create-link") return;
      moved = join(root, "moved-topic");
      renameSync(dirname(path), moved);
      symlinkSync(outside, dirname(path), "dir");
    } });
    await assert.rejects(() => store.create("swapped-parent", proposal("swapped-parent")), /symlink|parent changed/i);
    assert.equal(existsSync(join(outside, "workflow.json")), false);
    assert.equal(existsSync(join(moved, "workflow.json.lock")), false);
    assert.equal(existsSync(join(moved, "workflow.json")), false);
    assert.deepEqual(readdirSync(moved), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("create rejects artifacts changed after hashing but before publication", async () => {
  const { root } = fixture();
  try {
    const value = proposal("changing-artifact");
    const artifactPath = ".model-artifacts/initiatives/changing-artifact/plans/2026-09-22_0337-bootstrap-plan.md";
    const absolute = join(root, artifactPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "# Initial plan\n");
    value.artifacts = [{ path: artifactPath, type: "plan", relatedWork: ["W-1"], summary: "Changing bootstrap plan." }];
    const store = new InitiativeStore(root, { fault: (stage) => { if (stage === "before-create-link") writeFileSync(absolute, "# Changed plan\n"); } });
    await assert.rejects(() => store.create("changing-artifact", value), /artifact.*(mismatch|changed)/i);
    assert.equal(existsSync(initiativePath(root, "changing-artifact")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects traversal and symlinked authority parents", async () => {
  const { root, service } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-swe-outside-"));
  try {
    await assert.rejects(() => service.create("../escape", proposal("escape")), /identity mismatch|canonical kebab-case/i);
    symlinkSync(outside, join(root, ".model-artifacts"), "dir");
    await assert.rejects(() => service.create("new-initiative", proposal()), /symlink/i);
    assert.equal(existsSync(join(outside, "initiatives", "new-initiative", "workflow.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("concurrent creation is exclusive and pre-publication faults leave no authority", async () => {
  const { root } = fixture();
  try {
    const first = new InitiativeStore(root);
    const second = new InitiativeStore(root);
    const results = await Promise.allSettled([
      first.create("new-initiative", proposal()),
      second.create("new-initiative", proposal()),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /already exists/i.test(String(result.reason))).length, 1);

    const faulty = new InitiativeStore(root, { fault: (stage) => { if (stage === "before-publish") throw new Error("injected create crash"); } });
    await assert.rejects(() => faulty.create("faulted-initiative", proposal("faulted-initiative")), /injected create crash/i);
    assert.equal(existsSync(initiativePath(root, "faulted-initiative")), false);
    assert.equal(existsSync(`${initiativePath(root, "faulted-initiative")}.lock`), false);

    const lockedPath = initiativePath(root, "locked-initiative");
    mkdirSync(dirname(lockedPath), { recursive: true });
    writeFileSync(`${lockedPath}.lock`, "other process\n");
    await assert.rejects(() => first.create("locked-initiative", proposal("locked-initiative")), /locked by another process/i);
    assert.equal(readFileSync(`${lockedPath}.lock`, "utf8"), "other process\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("structured create is the bootstrap path and slash plan remains non-mutating", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-surface-"));
  try {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const notices: string[] = [];
    const userMessages: string[] = [];
    const pi = {
      on() {},
      registerCommand(name: string, command: unknown) { commands.set(name, command); },
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
      appendEntry() {},
      sendUserMessage(message: string) { userMessages.push(message); },
    };
    piSwe(pi as never);
    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify(message: string) { notices.push(message); } },
    };
    await commands.get("swe").handler("plan --id surface-create Add the surface create flow", ctx);
    assert.match(notices.at(-1) ?? "", /Planning surface-create from your request/i);
    assert.match(userMessages.at(-1) ?? "", /action=create/i);
    assert.match(userMessages.at(-1) ?? "", /surface-create/i);
    assert.equal(existsSync(initiativePath(root, "surface-create")), false);
    await commands.get("swe").handler("plan --id ../escape Add unsafe planning", ctx);
    assert.match(notices.at(-1) ?? "", /canonical kebab-case/i);

    const result = await tools.get("swe").execute("call-1", { action: "create", initiativeId: "surface-create", proposal: proposal("surface-create") }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Created .*workflow\.json/i);
    assert.equal(new InitiativeStore(root).read("surface-create").initiative.revision, 1);
    assert.match(tools.get("swe").promptGuidelines.join(" "), /sole|bootstrap|create/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
