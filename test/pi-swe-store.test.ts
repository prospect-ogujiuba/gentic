import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { InitiativeStore, initiativePath } from "../extensions/pi-swe/src/app/store.ts";

const bootstrap = readFileSync(new URL("../.model-artifacts/initiatives/pi-swe-foundation/workflow.json", import.meta.url), "utf8");

function fixture(): { root: string; store: InitiativeStore } {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-store-"));
  const path = initiativePath(root, "pi-swe-foundation");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bootstrap);
  return { root, store: new InitiativeStore(root) };
}

test("store reads validated authority and rejects unsafe or legacy identities", () => {
  const { root, store } = fixture();
  try {
    assert.equal(store.read("pi-swe-foundation").initiative.revision, JSON.parse(bootstrap).revision);
    assert.throws(() => store.read("../escape"), /initiative id/i);
    const path = initiativePath(root, "legacy");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, topic: "legacy" }));
    assert.throws(() => store.read("legacy"), /unsupported initiative schema/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mutation uses revision and hash CAS and atomically publishes valid JSON", async () => {
  const { root, store } = fixture();
  try {
    const before = store.read("pi-swe-foundation");
    const saved = await store.mutate("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "activate approved implementation",
    }, (initiative) => ({ ...initiative, status: "active" }));
    assert.equal(saved.initiative.revision, before.initiative.revision + 1);
    assert.equal(saved.initiative.status, "active");
    assert.equal(JSON.parse(readFileSync(initiativePath(root, "pi-swe-foundation"), "utf8")).revision, before.initiative.revision + 1);
    await assert.rejects(() => store.mutate("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "stale writer",
    }, (initiative) => initiative), /stale initiative/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("queued and cross-store contenders serialize; stale contender cannot overwrite", async () => {
  const { root, store } = fixture();
  try {
    const before = store.read("pi-swe-foundation");
    const other = new InitiativeStore(root);
    const options = { expectedRevision: before.initiative.revision, expectedHash: before.hash, reason: "race fixture" };
    const results = await Promise.allSettled([
      store.mutate("pi-swe-foundation", options, async (initiative) => { await new Promise((resolve) => setTimeout(resolve, 30)); return { ...initiative, status: "active" }; }),
      other.mutate("pi-swe-foundation", options, (initiative) => ({ ...initiative, status: "paused" })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /stale initiative/i.test(String(result.reason))).length, 1);
    assert.equal(store.read("pi-swe-foundation").initiative.revision, before.initiative.revision + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancellation is rechecked in queue and a pre-publish fault leaves old authority", async () => {
  const { root, store } = fixture();
  try {
    const before = store.read("pi-swe-foundation");
    const blocker = store.mutate("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "hold queue",
    }, async (initiative) => { await new Promise((resolve) => setTimeout(resolve, 30)); return initiative; });
    const controller = new AbortController();
    const cancelled = store.mutate("pi-swe-foundation", {
      expectedRevision: before.initiative.revision + 1,
      reason: "cancelled fixture",
      signal: controller.signal,
    }, (initiative) => initiative);
    controller.abort(new Error("cancel queued mutation"));
    await blocker;
    await assert.rejects(cancelled, /cancel queued mutation|abort/i);

    const current = store.read("pi-swe-foundation");
    const faulty = new InitiativeStore(root, { fault: (stage) => { if (stage === "before-publish") throw new Error("injected crash"); } });
    await assert.rejects(() => faulty.mutate("pi-swe-foundation", {
      expectedRevision: current.initiative.revision,
      expectedHash: current.hash,
      reason: "fault fixture",
    }, (initiative) => ({ ...initiative, status: "paused" })), /injected crash/);
    assert.equal(store.read("pi-swe-foundation").hash, current.hash);
    assert.equal(existsSync(`${initiativePath(root, "pi-swe-foundation")}.lock`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing lock fails closed and is never silently stolen", async () => {
  const { root, store } = fixture();
  try {
    const path = initiativePath(root, "pi-swe-foundation");
    writeFileSync(`${path}.lock`, JSON.stringify({ owner: "another-process" }));
    const before = store.read("pi-swe-foundation");
    await assert.rejects(() => store.mutate("pi-swe-foundation", {
      expectedRevision: before.initiative.revision,
      expectedHash: before.hash,
      reason: "lock fixture",
    }, (initiative) => initiative), /locked by another process/i);
    assert.equal(readFileSync(`${path}.lock`, "utf8"), JSON.stringify({ owner: "another-process" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
