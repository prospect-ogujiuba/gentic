import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("command inventory reports its configurable Pi startup deadline", () => {
  const directory = mkdtempSync(join(tmpdir(), "gentic-command-inventory-"));
  const executable = join(directory, "pi");
  writeFileSync(executable, "#!/usr/bin/env node\nsetTimeout(() => {}, 1_000);\n", "utf8");
  chmodSync(executable, 0o755);

  try {
    const result = spawnSync(process.execPath, [join(root, "scripts/check-command-inventory.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        GENTIC_COMMAND_INVENTORY_TIMEOUT_MS: "20",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pi command inventory exceeded 20ms/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
