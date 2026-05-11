import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import piSwe, { metadata } from "../extensions/pi-swe/index.ts";

const root = new URL("..", import.meta.url).pathname;

test("package discovery sees pi-swe extension", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.pi?.extensions, ["./extensions"]);
  assert.ok(readdirSync(join(root, "extensions"), { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name === "pi-swe"));
  assert.equal(existsSync(join(root, "extensions/pi-swe/index.ts")), true);
  assert.equal(metadata.id, "pi-swe");
});

test("pi-swe skeleton loads without registering behavior", () => {
  const calls: string[] = [];
  const pi = new Proxy({}, {
    get(_target, property) {
      calls.push(String(property));
      return () => undefined;
    },
  });
  const ctx = { cwd: root, sessionId: "test", ui: {} };

  assert.equal(piSwe(pi as never, ctx as never), undefined);
  assert.deepEqual(calls, []);
});
