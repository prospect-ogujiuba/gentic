import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { bridgeReviewEntry, registerUserBashPermissionBridge } from "../extensions/pi-permission-bridge/index.ts";

function harness(state: "allow" | "ask" | "deny" | "missing", confirm: boolean | boolean[] = false) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const events = new Map<string, (...args: any[]) => any>();
  let confirmations = 0;
  const reviews: Array<Record<string, unknown>> = [];
  const confirmationResults = Array.isArray(confirm) ? [...confirm] : [confirm, confirm];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); },
    events: { on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); } },
  } as any;
  registerUserBashPermissionBridge(
    pi,
    async () => state === "missing" ? undefined : ({
      checkPermission() { return { state, matchedPattern: state === "deny" ? "rm *" : "*" }; },
    }) as any,
    async (permissions, command) => permissions.checkPermission("bash", command),
    async (record) => { reviews.push(record); },
  );
  events.get("permissions:ready")?.({ sessionId: "session-1" });
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { async confirm() { return confirmationResults[confirmations++] ?? false; } },
  } as any;
  return { userBash: hooks.get("user_bash")!, ctx, confirmations: () => confirmations, reviews };
}

test("user bash compatibility bridge applies permission-system allow, deny, and ask decisions", async () => {
  const allowed = harness("allow");
  assert.equal(await allowed.userBash({ command: "git status", cwd: "/repo" }, allowed.ctx), undefined);
  assert.equal(allowed.reviews.at(-1)?.outcome, "allow");

  const denied = harness("deny");
  const deniedResult = await denied.userBash({ command: "rm -rf /", cwd: "/repo" }, denied.ctx);
  assert.equal(deniedResult.result.exitCode, 126);
  assert.equal(deniedResult.result.output, "pi-permission-system: denied by policy");
  assert.equal(deniedResult.result.output.includes("rm -rf /"), false);
  assert.equal(denied.reviews.at(-1)?.outcome, "deny");

  const approved = harness("ask", true);
  assert.equal(await approved.userBash({ command: "npm install", cwd: "/repo" }, approved.ctx), undefined);
  assert.equal(approved.confirmations(), 2);
  assert.equal(approved.reviews.at(-1)?.outcome, "approved");

  const rejected = harness("ask", false);
  assert.equal((await rejected.userBash({ command: "npm install", cwd: "/repo" }, rejected.ctx)).result.exitCode, 126);
  assert.equal(rejected.confirmations(), 1);

  const secondRejected = harness("ask", [true, false]);
  assert.equal((await secondRejected.userBash({ command: "npm install", cwd: "/repo" }, secondRejected.ctx)).result.exitCode, 126);
  assert.equal(secondRejected.confirmations(), 2);
});

test("bridge review entries never contain raw command text", () => {
  const command = "printf token=super-secret > .env";
  const entry = bridgeReviewEntry({ command, state: "deny", outcome: "deny" });
  assert.equal(JSON.stringify(entry).includes(command), false);
  assert.equal(entry.commandSha256.length, 64);
});

test("actual package parser enforces lifecycle, command, path, external-directory, wrapper, and destructive-root policy", () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const [fixture, expected] of [
    ["test/fixtures/pi-permission-bridge-prewarm.ts", /permission bridge prewarm lifecycle: ok/],
    ["test/fixtures/pi-permission-bridge-integration.ts", /permission bridge integration: ok/],
    ["test/fixtures/pi-permission-bridge-logging.ts", /permission bridge logging config: ok/],
  ] as const) {
    const result = spawnSync("node_modules/.bin/tsx", [fixture], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${fixture}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, expected);
  }
});

test("user bash compatibility bridge fails closed when the service or UI is unavailable", async () => {
  const missing = harness("missing");
  assert.equal((await missing.userBash({ command: "whoami", cwd: "/repo" }, missing.ctx)).result.exitCode, 126);
  assert.equal(missing.reviews.at(-1)?.outcome, "service_unavailable");

  const ask = harness("ask");
  ask.ctx.hasUI = false;
  ask.ctx.mode = "print";
  assert.equal((await ask.userBash({ command: "whoami", cwd: "/repo" }, ask.ctx)).result.exitCode, 126);
  assert.equal(ask.confirmations(), 0);
});
