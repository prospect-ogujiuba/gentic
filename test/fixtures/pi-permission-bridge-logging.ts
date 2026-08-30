import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBridgeReview } from "../../extensions/pi-permission-bridge/index.ts";

const record = { command: "printf token=super-secret > .env", state: "deny", outcome: "deny" } as const;
const context = { cwd: "/repo", projectTrusted: false };
const logRelative = "extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl";

const enabled = mkdtempSync(join(tmpdir(), "permission-bridge-review-"));
await appendBridgeReview(record, context, enabled);
const enabledLog = join(enabled, logRelative);
assert.equal(existsSync(enabledLog), true);
assert.equal(statSync(enabledLog).mode & 0o777, 0o600);
assert.equal(statSync(join(enabled, "extensions/pi-permission-system/logs")).mode & 0o777, 0o700);

const commentedOptOut = mkdtempSync(join(tmpdir(), "permission-bridge-review-off-"));
const optOutConfigDir = join(commentedOptOut, "extensions/pi-permission-system");
mkdirSync(optOutConfigDir, { recursive: true });
writeFileSync(join(optOutConfigDir, "config.json"), "{\n  // valid JSONC opt-out\n  \"permissionReviewLog\": false\n}\n");
await appendBridgeReview(record, context, commentedOptOut);
assert.equal(existsSync(join(commentedOptOut, logRelative)), false);

const invalidScope = mkdtempSync(join(tmpdir(), "permission-bridge-review-invalid-"));
const invalidConfigDir = join(invalidScope, "extensions/pi-permission-system");
mkdirSync(invalidConfigDir, { recursive: true });
writeFileSync(join(invalidConfigDir, "config.json"), JSON.stringify({ permissionReviewLog: false, unknownSetting: true }));
await appendBridgeReview(record, context, invalidScope);
assert.equal(existsSync(join(invalidScope, logRelative)), true, "invalid scope must not apply its opt-out");

const projectOverrideAgent = mkdtempSync(join(tmpdir(), "permission-bridge-review-project-agent-"));
const globalConfigDir = join(projectOverrideAgent, "extensions/pi-permission-system");
mkdirSync(globalConfigDir, { recursive: true });
writeFileSync(join(globalConfigDir, "config.json"), JSON.stringify({ permissionReviewLog: false }));
const project = mkdtempSync(join(tmpdir(), "permission-bridge-review-project-"));
const projectConfigDir = join(project, ".pi/extensions/pi-permission-system");
mkdirSync(projectConfigDir, { recursive: true });
writeFileSync(join(projectConfigDir, "config.json"), "{\n // trusted override\n \"permissionReviewLog\": true\n}\n");
await appendBridgeReview(record, { cwd: project, projectTrusted: true }, projectOverrideAgent);
assert.equal(existsSync(join(projectOverrideAgent, logRelative)), true);

console.log("permission bridge logging config: ok");
