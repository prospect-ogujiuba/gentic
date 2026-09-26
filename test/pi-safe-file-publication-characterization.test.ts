import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ArtifactService, MAX_ARTIFACT_CONTENT_BYTES } from "../extensions/pi-artifacts/index.ts";
import {
  createNativeContextSnapshot,
  renderNativeContextJson,
  renderNativeContextMarkdown,
  writeNativeContextExport,
} from "../extensions/pi-context/src/app/index.ts";

const capturedAt = "2026-09-14T03:00:00.000Z";

function fixture(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function contextSnapshot() {
  return createNativeContextSnapshot({
    getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
    getSystemPromptOptions: () => ({}),
    sessionManager: { getBranch: () => [] },
  } as never, { capturedAt });
}

function runPublisher(root: string): Promise<{ code: number | null; stderr: string }> {
  const serviceUrl = pathToFileURL(path.resolve("extensions/pi-artifacts/src/app/service.ts")).href;
  const program = [
    `import { ArtifactService } from ${JSON.stringify(serviceUrl)};`,
    "new ArtifactService(process.env.ROOT).create({ scope: 'initiative', topic: 'race', kind: 'reports', name: 'winner', content: '# winner\\n' }, { now: new Date('2026-09-14T03:00:00.000Z') });",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
      env: { ...process.env, ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("characterizes artifact bytes, bounds, collision errors, and durable publication", () => {
  const root = fixture("pi-publication-artifact-");
  try {
    const service = new ArtifactService(root);
    const content = "# exact bytes\n\n🙂\n";
    const request = { scope: "initiative" as const, topic: "security", kind: "reports" as const, name: "baseline", content };
    const created = service.create(request, { now: new Date(capturedAt) });
    assert.equal(created.path, ".model-artifacts/initiatives/security/reports/2026-09-14_0300-baseline.md");
    assert.deepEqual(fs.readFileSync(path.join(root, created.path)), Buffer.from(content));
    assert.throws(() => service.create(request, { now: new Date(capturedAt) }), /artifact already exists/);
    assert.throws(() => service.create({ ...request, name: "too-large", content: "x".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1) }), /1 MiB limit/);
    assert.equal(fs.readdirSync(path.dirname(path.join(root, created.path))).some((name) => name.endsWith(".artifact.tmp")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("characterizes context Markdown and JSON paths and exact rendered bytes", () => {
  const root = fixture("pi-publication-context-");
  try {
    const snapshot = contextSnapshot();
    const markdown = writeNativeContextExport(snapshot, { cwd: root, format: "markdown" });
    const json = writeNativeContextExport(snapshot, { cwd: root, format: "json" });
    assert.equal(markdown.relativePath, path.join(".model-artifacts", "system", "reports", "pi-context", "2026-09-14_0300-pi-context-00-000.md"));
    assert.equal(json.relativePath, path.join(".model-artifacts", "system", "reports", "pi-context", "2026-09-14_0300-pi-context-00-000.json"));
    assert.deepEqual(fs.readFileSync(markdown.path), Buffer.from(renderNativeContextMarkdown(snapshot)));
    assert.deepEqual(fs.readFileSync(json.path), Buffer.from(renderNativeContextJson(snapshot)));
    assert.throws(() => writeNativeContextExport(snapshot, { cwd: root, format: "markdown" }), /already exists|unsafe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("characterizes traversal, symlink destination, and swapped-parent rejection", () => {
  const root = fixture("pi-publication-containment-");
  const outside = fixture("pi-publication-outside-");
  try {
    const service = new ArtifactService(root);
    assert.throws(() => service.create({
      scope: "initiative", topic: "..", kind: "reports", name: "escape", content: "no\n",
    }), /kebab-case/);

    const reports = path.join(root, ".model-artifacts", "initiatives", "security", "reports");
    fs.mkdirSync(reports, { recursive: true });
    fs.rmSync(reports, { recursive: true });
    fs.symlinkSync(outside, reports, "dir");
    assert.throws(() => service.create({
      scope: "initiative", topic: "security", kind: "reports", name: "swapped", content: "no\n",
    }, { now: new Date(capturedAt) }), /safe directory|symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), []);

    fs.rmSync(reports);
    fs.mkdirSync(reports);
    const protectedPath = path.join(outside, "protected.md");
    fs.writeFileSync(protectedPath, "protected\n");
    fs.symlinkSync(protectedPath, path.join(reports, "2026-09-14_0300-destination.md"), "file");
    assert.throws(() => service.create({
      scope: "initiative", topic: "security", kind: "reports", name: "destination", content: "no\n",
    }, { now: new Date(capturedAt) }), /already exists/);
    assert.equal(fs.readFileSync(protectedPath, "utf8"), "protected\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("characterizes exclusive concurrent publication and interruption remnants", async () => {
  const root = fixture("pi-publication-race-");
  try {
    const directory = path.join(root, ".model-artifacts", "initiatives", "race", "reports");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ".interrupted.artifact.tmp"), "partial");

    const results = await Promise.all(Array.from({ length: 6 }, () => runPublisher(root)));
    assert.equal(results.filter(({ code }) => code === 0).length, 1);
    assert.equal(results.filter(({ stderr }) => /artifact already exists/.test(stderr)).length, 5);
    assert.equal(fs.readFileSync(path.join(directory, "2026-09-14_0300-winner.md"), "utf8"), "# winner\n");
    assert.equal(fs.readFileSync(path.join(directory, ".interrupted.artifact.tmp"), "utf8"), "partial");
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".artifact.tmp")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("characterizes interrupted context publication as leaving no destination or temporary file", () => {
  const root = fixture("pi-publication-interruption-");
  const snapshot = contextSnapshot();
  const destination = path.join(root, ".model-artifacts", "system", "reports", "pi-context", "2026-09-14_0300-pi-context-00-000.md");
  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      originalWriteFileSync(file, Buffer.from(String(data)).subarray(0, 8), options);
      throw new Error("simulated interrupted write");
    }) as typeof fs.writeFileSync;
    assert.throws(() => writeNativeContextExport(snapshot, { cwd: root, format: "markdown" }), /simulated interrupted write/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  const directory = path.dirname(destination);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("characterizes workflow authority as unavailable through artifact and context publishers", () => {
  const root = fixture("pi-publication-authority-");
  try {
    const created = new ArtifactService(root).create({
      scope: "initiative", topic: "authority", kind: "reports", name: "workflow", content: "not authority\n",
    }, { now: new Date(capturedAt) });
    assert.notEqual(path.basename(created.path), "workflow.json");
    writeNativeContextExport(contextSnapshot(), { cwd: root, format: "json" });
    assert.equal(fs.existsSync(path.join(root, ".model-artifacts", "initiatives", "authority", "workflow.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
