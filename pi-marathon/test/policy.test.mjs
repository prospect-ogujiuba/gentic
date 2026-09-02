import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CommandPolicy } from "../dist/core/policy.js";
import { DEFAULT_CONFIG } from "../dist/core/config.js";

const root = path.resolve("/tmp/pi-marathon-policy");
const policy = new CommandPolicy(root, structuredClone(DEFAULT_CONFIG.safety));
test("blocks destructive commands and out-of-workspace writes", () => {
  assert.equal(policy.checkCommand("rm -rf /").allowed, false);
  assert.equal(policy.checkPath(path.join(root, "src", "ok.ts"), "write").allowed, true);
  assert.equal(policy.checkPath("/etc/passwd", "write").allowed, false);
  assert.equal(policy.checkPath(path.join(root, ".env"), "write").allowed, false);
});
