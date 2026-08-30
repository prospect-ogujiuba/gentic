import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerUserBashPermissionBridge } from "../../extensions/pi-permission-bridge/index.ts";
import { evaluate } from "../../node_modules/@gotgenes/pi-permission-system/src/rule.ts";

const config = JSON.parse(await readFile(new URL("../../config/pi-permission-system.json", import.meta.url), "utf8"));
const service = {
  checkPermission(surface: string, value = "") {
    const policy = config.permission[surface] ?? config.permission["*"] ?? "ask";
    if (typeof policy === "string") return { state: policy, source: surface };
    const rules = Object.entries(policy).map(([pattern, action]) => ({ surface, pattern, action, origin: "global", layer: "config" }));
    const result = evaluate(surface, value, rules as any, {} as any);
    return { state: result.action, matchedPattern: result.pattern, source: surface };
  },
} as any;
const hooks = new Map<string, (...args: any[]) => any>();
const events = new Map<string, (...args: any[]) => any>();
registerUserBashPermissionBridge({
  on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); },
  events: { on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); } },
} as any, async () => service);

const cwd = mkdtempSync(join(tmpdir(), "permission-bridge-prewarm-"));
mkdirSync(join(cwd, ".git"));
writeFileSync(join(cwd, ".env"), "secret");
const ctx = { cwd, mode: "print", hasUI: false, ui: {} } as any;
events.get("permissions:ready")?.({ sessionId: "prewarm-session" });

// First user_bash call occurs before any before_agent_start or explicit parser warm-up.
assert.equal((await hooks.get("user_bash")?.({ command: "git status; rm -rf /", cwd }, ctx)).result.exitCode, 126);
assert.equal((await hooks.get("user_bash")?.({ command: "git status; npm install unknown", cwd }, ctx)).result.exitCode, 126);
assert.equal((await hooks.get("user_bash")?.({ command: "printf x > .env", cwd }, ctx)).result.exitCode, 126);
hooks.get("session_shutdown")?.({}, ctx);
assert.match((await hooks.get("user_bash")?.({ command: "git status", cwd }, ctx)).result.output, /service unavailable/);
events.get("permissions:ready")?.({ sessionId: "replacement-session" });
assert.equal(await hooks.get("user_bash")?.({ command: "git status", cwd }, ctx), undefined);

console.log("permission bridge prewarm lifecycle: ok");
