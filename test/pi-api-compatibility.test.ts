import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("Pi compatibility check rejects an omitted extension event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gentic-pi-api-"));
  const fixture = join(directory, "pi-contract.ts");

  try {
    const contract = await readFile(join(root, "src", "pi-contract.ts"), "utf8");
    await writeFile(fixture, contract.replace('  project: ["project_trust"],\n', ""));

    const result = spawnSync(process.execPath, [join(root, "scripts", "check-pi-extension-api.mjs"), "--contract", fixture], {
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /PI_EXTENSION_EVENTS should match installed Pi events/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
