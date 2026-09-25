import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkProductionExtensionDependencies,
  formatDependencyFailures,
  TEMPORARY_PRIVATE_SRC_EXCEPTIONS,
} from "../scripts/check-extension-dependencies.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gentic-extension-dependencies-"));
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

const exactException = {
  importer: "extensions/pi-a/src/consumer.ts",
  specifier: "../../pi-b/src/private.ts",
  target: "extensions/pi-b/src/private.ts",
  removalOwner: "migration-owner",
};

test("current production source has no sibling private-src imports or temporary exceptions", () => {
  const result = checkProductionExtensionDependencies(repositoryRoot);
  assert.deepEqual(formatDependencyFailures(result), []);
  assert.equal(result.staleExceptions.length, 0);
  assert.equal(TEMPORARY_PRIVATE_SRC_EXCEPTIONS.length, 0);
});

test("rejects a new sibling extension private-src import while ignoring test fixtures", (t) => {
  const root = fixture({
    "extensions/pi-a/types.ts": 'import "../pi-b/src/private.ts";\n',
    "extensions/pi-b/src/private.ts": "export {};\n",
    "extensions/pi-a/fixtures/example.ts": 'import "../../pi-b/src/also-private.ts";\n',
    "test/fixture.ts": 'import "../extensions/pi-b/src/also-private.ts";\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = checkProductionExtensionDependencies(root, []);
  assert.deepEqual(result.violations, [{
    importer: "extensions/pi-a/types.ts",
    specifier: "../pi-b/src/private.ts",
    target: "extensions/pi-b/src/private.ts",
  }]);
  assert.equal(result.staleExceptions.length, 0);
});

test("accepts only an exact matching exception and reports it when stale", (t) => {
  const root = fixture({
    "extensions/pi-a/src/consumer.ts": 'import "../../pi-b/src/private.ts";\n',
    "extensions/pi-b/src/private.ts": "export {};\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(formatDependencyFailures(checkProductionExtensionDependencies(root, [exactException])), []);
  writeFileSync(join(root, exactException.importer), "export {};\n");
  const stale = checkProductionExtensionDependencies(root, [exactException]);
  assert.equal(stale.violations.length, 0);
  assert.deepEqual(stale.staleExceptions, [exactException]);
});

test("rejects broadened or internally inconsistent exceptions", (t) => {
  const root = fixture({
    "extensions/pi-a/src/consumer.ts": 'import "../../pi-b/src/private.ts";\n',
    "extensions/pi-b/src/private.ts": "export {};\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => checkProductionExtensionDependencies(root, [{ ...exactException, importer: "extensions/pi-a/src/*.ts" }]),
    /exact non-glob importer/,
  );
  assert.throws(
    () => checkProductionExtensionDependencies(root, [{ ...exactException, target: "extensions/pi-b/src/other.ts" }]),
    /target does not match/,
  );
});
