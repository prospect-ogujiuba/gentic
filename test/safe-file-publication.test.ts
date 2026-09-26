import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SafePublicationError,
  publishNewTextFile,
} from "../src/services/safe-file-publication.ts";

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safe-publication-"));
}

function publish(root: string, relativePath: string, content = "content\n", maxBytes = 1024) {
  return publishNewTextFile({ root, relativePath, content, maxBytes, temporaryTag: "test-report" });
}

function expectCode(code: SafePublicationError["code"], action: () => unknown): void {
  assert.throws(action, (error) => error instanceof SafePublicationError && error.code === code);
}

test("safe publication is byte-exact, exclusive, and removes temporary files", () => {
  const root = fixture();
  try {
    const relativePath = ".model-artifacts/system/reports/test/exact.json";
    const content = "{\"emoji\":\"🙂\"}\n";
    const result = publish(root, relativePath, content);
    assert.equal(result.relativePath, relativePath);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.deepEqual(fs.readFileSync(result.path), Buffer.from(content));
    expectCode("collision", () => publish(root, relativePath, "replacement\n"));
    assert.deepEqual(fs.readFileSync(result.path), Buffer.from(content));
    assert.deepEqual(fs.readdirSync(path.dirname(result.path)), ["exact.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("safe publication rejects escaping paths, excessive bytes, and workflow authority", () => {
  const root = fixture();
  try {
    for (const candidate of [
      "../outside.md",
      "/tmp/outside.md",
      ".model-artifacts/system/reports/../outside.md",
      ".model-artifacts\\system\\reports\\outside.md",
      "reports/outside.md",
    ]) expectCode("invalid-path", () => publish(root, candidate));

    expectCode("content-too-large", () => publish(root, ".model-artifacts/system/reports/large.md", "🙂", 3));
    expectCode("workflow-authority", () => publish(root, ".model-artifacts/initiatives/demo/workflow.json", "{}\n"));
    expectCode("workflow-authority", () => publish(root, ".model-artifacts/initiatives/demo/workflow.json/child.md", "no\n"));
    assert.equal(fs.existsSync(path.join(root, ".model-artifacts")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("safe publication rejects symlinked parents and existing symlink destinations", () => {
  const root = fixture();
  const outside = fixture();
  try {
    const reports = path.join(root, ".model-artifacts", "system", "reports");
    fs.mkdirSync(path.dirname(reports), { recursive: true });
    fs.symlinkSync(outside, reports, "dir");
    expectCode("unsafe-parent", () => publish(root, ".model-artifacts/system/reports/escaped.md"));
    assert.deepEqual(fs.readdirSync(outside), []);

    fs.rmSync(reports);
    fs.mkdirSync(reports);
    const protectedPath = path.join(outside, "protected.md");
    fs.writeFileSync(protectedPath, "protected\n");
    fs.symlinkSync(protectedPath, path.join(reports, "linked.md"), "file");
    expectCode("collision", () => publish(root, ".model-artifacts/system/reports/linked.md"));
    assert.equal(fs.readFileSync(protectedPath, "utf8"), "protected\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("safe directory creation stays on opened parents when an ancestor swaps", () => {
  const root = fixture();
  const outside = fixture();
  const system = path.join(root, ".model-artifacts", "system");
  const displaced = path.join(root, "displaced-system");
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  try {
    fs.mkdirSync(system, { recursive: true });
    fs.mkdirSync = ((candidate: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: false }) => {
      if (!swapped && path.basename(String(candidate)) === "reports") {
        swapped = true;
        fs.renameSync(system, displaced);
        fs.symlinkSync(outside, system, "dir");
      }
      return originalMkdirSync(candidate, options as never);
    }) as typeof fs.mkdirSync;
    expectCode("unsafe-parent", () => publish(root, ".model-artifacts/system/reports/directory-swap.md"));
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("safe publication stays on its opened parent and fails closed across a publication-time parent swap", () => {
  const root = fixture();
  const outside = fixture();
  const directory = path.join(root, ".model-artifacts", "system", "reports");
  const displaced = path.join(root, "displaced-reports");
  const originalLinkSync = fs.linkSync;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      fs.renameSync(directory, displaced);
      fs.symlinkSync(outside, directory, "dir");
      originalLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync;
    expectCode("unsafe-parent", () => publish(root, ".model-artifacts/system/reports/swapped.md"));
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(displaced), []);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("safe publication fails closed when the parent swaps during staged-file cleanup", () => {
  const root = fixture();
  const outside = fixture();
  const directory = path.join(root, ".model-artifacts", "system", "reports");
  const displaced = path.join(root, "displaced-cleanup-reports");
  const originalUnlinkSync = fs.unlinkSync;
  let swapped = false;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.unlinkSync = ((candidate: fs.PathLike) => {
      originalUnlinkSync(candidate);
      if (!swapped && String(candidate).endsWith(".test-report.tmp")) {
        swapped = true;
        fs.renameSync(directory, displaced);
        fs.symlinkSync(outside, directory, "dir");
      }
    }) as typeof fs.unlinkSync;
    expectCode("unsafe-parent", () => publish(root, ".model-artifacts/system/reports/late-swap.md"));
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(displaced), []);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("safe publication removes a staged file after an interrupted write", () => {
  const root = fixture();
  const relativePath = ".model-artifacts/system/reports/interrupted.md";
  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      originalWriteFileSync(file, Buffer.from(String(data)).subarray(0, 3), options);
      throw new Error("simulated interruption");
    }) as typeof fs.writeFileSync;
    assert.throws(() => publish(root, relativePath), /simulated interruption/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  const directory = path.join(root, ".model-artifacts", "system", "reports");
  assert.equal(fs.existsSync(path.join(root, relativePath)), false);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("shared backend has no Pi registration or workflow lifecycle dependencies", () => {
  const source = fs.readFileSync(path.resolve("src/services/safe-file-publication.ts"), "utf8");
  assert.doesNotMatch(source, /@earendil-works|register(?:Tool|Command)|SweService|workflow\.json[^\n]*write/i);
});
