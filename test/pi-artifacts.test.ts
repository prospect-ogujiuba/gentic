import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piArtifacts, {
  ArtifactService,
  MAX_ARTIFACT_CONTENT_BYTES,
  createArtifactPath,
  validateCanonicalArtifactPath,
} from "../extensions/pi-artifacts/index.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "pi-artifacts-"));
}

test("canonical paths are deterministic for initiative and system artifacts", () => {
  const now = new Date("2026-09-21T19:30:45.000Z");
  assert.equal(
    createArtifactPath({ scope: "initiative", topic: "pi-work", kind: "reports", name: "implementation-review", content: "x" }, now),
    ".model-artifacts/initiatives/pi-work/reports/2026-09-21_1930-implementation-review.md",
  );
  assert.equal(
    createArtifactPath({ scope: "system", kind: "logs", namespace: "pi-work", name: "checkpoint", content: "x" }, now),
    ".model-artifacts/system/logs/pi-work/2026-09-21_1930-checkpoint.md",
  );
});

test("service creates exclusive initiative artifacts with content metadata", () => {
  const root = fixture();
  const service = new ArtifactService(root);
  const content = "# Review\n\nPassed.\n";
  const created = service.create(
    { scope: "initiative", topic: "pi-work", kind: "reports", name: "implementation-review", content },
    { now: new Date("2026-09-21T19:30:45.000Z") },
  );

  assert.equal(created.path, ".model-artifacts/initiatives/pi-work/reports/2026-09-21_1930-implementation-review.md");
  assert.equal(created.createdAt, "2026-09-21T19:30:45.000Z");
  assert.equal(created.bytes, Buffer.byteLength(content));
  assert.equal(created.contentHash, `sha256:${createHash("sha256").update(content).digest("hex")}`);
  assert.equal(readFileSync(join(root, created.path), "utf8"), content);
  assert.throws(
    () => service.create(
      { scope: "initiative", topic: "pi-work", kind: "reports", name: "implementation-review", content },
      { now: new Date("2026-09-21T19:30:59.000Z") },
    ),
    /already exists/,
  );
});

test("service creates namespaced system artifacts", () => {
  const root = fixture();
  const created = new ArtifactService(root).create(
    { scope: "system", kind: "reports", namespace: "release", name: "verification", content: "# Verification\n" },
    { now: new Date("2026-09-21T19:31:00.000Z") },
  );
  assert.equal(created.path, ".model-artifacts/system/reports/release/2026-09-21_1931-verification.md");
  assert.ok(existsSync(join(root, created.path)));
});

test("canonical validation rejects wrong roots, kinds, filenames, and traversal", () => {
  for (const path of [
    ".model-artifacts/reports/2026-09-21_1930-report.md",
    ".model-artifacts/initiatives/demo/analysis/2026-09-21_1930-report.md",
    ".model-artifacts/initiatives/demo/reports/latest.md",
    ".model-artifacts/initiatives/../reports/2026-09-21_1930-report.md",
    ".model-artifacts/system/specs/2026-09-21_1930-spec.md",
    ".model-artifacts/system/logs/runtime/receipt.json",
    ".model-artifacts/system/logs/a/b/2026-09-21_1930-log.md",
  ]) assert.throws(() => validateCanonicalArtifactPath(path), /artifact|initiative|system/);

  assert.doesNotThrow(() => validateCanonicalArtifactPath(".model-artifacts/initiatives/demo/workflow.json"));
  assert.doesNotThrow(() => validateCanonicalArtifactPath(".model-artifacts/system/logs/runtime/2026-09-21_1930-receipt.md"));
});

test("service rejects unsafe segments, unsafe parents, and invalid content", () => {
  const root = fixture();
  const service = new ArtifactService(root);
  const base = { scope: "initiative" as const, kind: "findings" as const, content: "# Finding\n" };
  assert.throws(() => service.create({ ...base, topic: "Not-Kebab", name: "finding" }), /kebab-case/);
  assert.throws(() => service.create({ ...base, topic: "demo", name: "Not Kebab" }), /kebab-case/);
  assert.throws(() => service.create({ ...base, topic: "demo", name: "empty", content: " \n" }), /non-empty/);
  assert.throws(() => service.create({ ...base, topic: "demo", name: "large", content: "x".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1) }), /1 MiB/);

  const outside = join(root, "outside");
  mkdirSync(outside);
  const artifactRoot = join(root, ".model-artifacts");
  mkdirSync(artifactRoot);
  symlinkSync(outside, join(artifactRoot, "initiatives"));
  assert.throws(() => service.create({ ...base, topic: "demo", name: "linked" }), /safe directory/);
});

test("artifact tool creates files and enforces system kinds", async () => {
  const root = fixture();
  const tools = new Map<string, any>();
  piArtifacts({ registerTool(tool: any) { tools.set(tool.name, tool); } } as never);
  const tool = tools.get("artifact");
  assert.ok(tool);
  const signal = new AbortController().signal;
  const ctx = { cwd: root };

  const result = await tool.execute("call-1", {
    scope: "initiative", topic: "demo", kind: "plans", name: "delivery-plan", content: "# Plan\n",
  }, signal, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Created \.model-artifacts\/initiatives\/demo\/plans\//);

  const rejected = await tool.execute("call-2", {
    scope: "system", kind: "plans", name: "bad", content: "# Bad\n",
  }, signal, undefined, ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /invalid system artifact kind/);
});

test("pi-artifacts documentation describes creation without migration behavior", () => {
  const readme = readFileSync(join(process.cwd(), "extensions/pi-artifacts/README.md"), "utf8");
  assert.match(readme, /creates durable model-generated Markdown/i);
  assert.match(readme, /never overwrites/i);
  assert.doesNotMatch(readme, /migration|rollback|legacy|recover/i);
  for (const removed of [
    "extensions/pi-artifacts/src/app/transaction.ts",
    "extensions/pi-artifacts/src/domain/inventory.ts",
    "extensions/pi-artifacts/src/domain/plan.ts",
    "src/swe-migration-record.ts",
  ]) assert.equal(existsSync(join(process.cwd(), removed)), false, removed);
});
