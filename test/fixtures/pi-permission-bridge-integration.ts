import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeUserBashCommand, registerUserBashPermissionBridge } from "../../extensions/pi-permission-bridge/index.ts";
import { evaluate } from "../../node_modules/@gotgenes/pi-permission-system/src/rule.ts";

const config = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../config/pi-permission-system.json", import.meta.url), "utf8")));

function service(overrides: Record<string, unknown> = {}) {
  const permission = { ...config.permission, ...overrides };
  return {
    checkPermission(surface: string, value = "") {
      const policy = permission[surface] ?? permission["*"] ?? "ask";
      if (typeof policy === "string") return { state: policy, source: surface };
      const rules = Object.entries(policy).map(([pattern, action]) => ({ surface, pattern, action, origin: "global", layer: "config" }));
      const result = evaluate(surface, value, rules as any, {} as any);
      return { state: result.action, matchedPattern: result.pattern, source: surface };
    },
  } as any;
}

const cwd = mkdtempSync(join(tmpdir(), "permission-bridge-integration-"));
mkdirSync(join(cwd, ".git"));
writeFileSync(join(cwd, ".env"), "secret");

for (const command of [
  "printf secret > .env",
  "printf x > .git/config",
  "git status > .env",
  "git status; rm -rf /",
  "rm --recursive -f /",
  "rm -Rfv /",
  "rm -rf \"$HOME\"",
  "rm -rf $HOME/",
  "rm -rf ${HOME}/",
  "rm -rf ~/",
  `rm -rf ${(process.env.HOME ?? "/home/example").replace(/\/+$/, "")}/`,
]) {
  const decision = await analyzeUserBashCommand(service(), command, cwd);
  assert.equal(decision.state, "deny", command);
}

assert.equal((await analyzeUserBashCommand(service(), "bash -c 'rm -rf /'", cwd)).state, "deny");
assert.equal((await analyzeUserBashCommand(service(), "bash -c 'echo hi'", cwd)).state, "ask");
assert.equal((await analyzeUserBashCommand(service(), "git status; npm install unknown", cwd)).state, "ask");
assert.equal((await analyzeUserBashCommand(service(), "git status", cwd)).state, "allow");

const outside = mkdtempSync(join(tmpdir(), "permission-bridge-outside-"));
assert.equal((await analyzeUserBashCommand(service({ external_directory_write: "deny" }), `printf x > ${join(outside, "x")}`, cwd)).state, "deny");

const outsideEnv = join(outside, ".env");
writeFileSync(outsideEnv, "secret");
const link = join(cwd, "linked-env");
symlinkSync(outsideEnv, link);
assert.equal((await analyzeUserBashCommand(service(), `printf x > ${link}`, cwd)).state, "deny");

const hooks = new Map<string, (...args: any[]) => any>();
const events = new Map<string, (...args: any[]) => any>();
registerUserBashPermissionBridge({
  on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); },
  events: { on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); } },
} as any, async () => service());
const ctx = { cwd, mode: "print", hasUI: false, ui: {} } as any;
events.get("permissions:ready")?.({ sessionId: "integration-session" });
assert.equal((await hooks.get("user_bash")?.({ command: "git status; rm -rf /", cwd }, ctx)).result.exitCode, 126);
assert.equal((await hooks.get("user_bash")?.({ command: "printf x > .env", cwd }, ctx)).result.exitCode, 126);
hooks.get("session_shutdown")?.({}, ctx);
assert.match((await hooks.get("user_bash")?.({ command: "git status", cwd }, ctx)).result.output, /service unavailable/);
events.get("permissions:ready")?.({ sessionId: "integration-session-2" });
assert.equal(await hooks.get("user_bash")?.({ command: "git status", cwd }, ctx), undefined);

console.log("permission bridge integration: ok");
