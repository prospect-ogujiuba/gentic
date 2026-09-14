import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_PI_CONTEXT_CONFIG } from "../extensions/pi-context/src/config/index.ts";
import { EXCLUDED_RUNTIME_LEDGER_EVENTS } from "../extensions/pi-context/src/app/index.ts";
import { registerPiContext } from "../extensions/pi-context/src/pi/index.ts";

const marker = "LIGHTWEIGHT_RUNTIME_SECRET";

test("runtime replaces 26-event ledger with four stable lifecycle subscriptions", () => {
  const handlers = new Map<string, Function>();
  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as never);

  assert.deepEqual([...handlers.keys()], ["session_start", "turn_end", "session_compact", "session_shutdown"]);
  assert.equal(handlers.size, 4);
  assert.equal(EXCLUDED_RUNTIME_LEDGER_EVENTS.some((event) => handlers.has(event)), false);
  assert.equal(Number(((26 - handlers.size) / 26 * 100).toFixed(1)), 84.6);
});

test("command builds native output on demand and writes only explicit exports", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: any): Promise<void> }) => commands.set(name, command),
  } as never);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-lightweight-"));
  const reportDir = path.join(cwd, ".model-artifacts", "system", "reports", "pi-context");
  const notifications: Array<{ text: string; type: string }> = [];
  let usageCalls = 0;
  let promptCalls = 0;
  let branchCalls = 0;
  const ctx = {
    cwd,
    getContextUsage: () => {
      usageCalls += 1;
      return { tokens: 75, contextWindow: 100, percent: 75 };
    },
    getSystemPromptOptions: () => {
      promptCalls += 1;
      return { cwd: `/private/${marker}`, customPrompt: marker };
    },
    sessionManager: {
      getBranch: () => {
        branchCalls += 1;
        return [{ type: "message", id: marker, parentId: null, timestamp: marker, message: { role: "user", content: marker } }];
      },
    },
    ui: { notify: (text: string, type: string) => notifications.push({ text, type }) },
  };

  await commands.get("pi-context")?.handler("summary", ctx);
  assert.equal(fs.existsSync(reportDir), false);
  assert.match(notifications.at(-1)?.text ?? "", /Remaining: 25 of 100 tokens/);
  assert.doesNotMatch(notifications.at(-1)?.text ?? "", new RegExp(marker));

  await commands.get("pi-context")?.handler("artifact", ctx);
  await commands.get("pi-context")?.handler("json", ctx);
  assert.deepEqual(fs.readdirSync(reportDir).map((name) => path.extname(name)).sort(), [".json", ".md"]);
  for (const name of fs.readdirSync(reportDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(reportDir, name), "utf8"), new RegExp(marker));
  }
  assert.deepEqual({ usageCalls, promptCalls, branchCalls }, { usageCalls: 3, promptCalls: 3, branchCalls: 3 });
});

test("stable lifecycle pressure remains transition-only and content-safe", () => {
  const handlers = new Map<string, Function>();
  const notifications: Array<{ text: string; type: string }> = [];
  let remaining = 40;
  let configLoads = 0;
  registerPiContext({
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as never, {
    now: () => 1_000,
    loadConfig: () => {
      configLoads += 1;
      return {
        config: DEFAULT_PI_CONTEXT_CONFIG,
        diagnostics: [],
        paths: { global: `/private/${marker}`, project: `/repo/${marker}` },
      };
    },
  });
  const ctx = {
    cwd: `/private/${marker}`,
    getContextUsage: () => ({ tokens: 100 - remaining, contextWindow: 100, percent: 100 - remaining }),
    ui: { notify: (text: string, type: string) => notifications.push({ text, type }) },
  };

  handlers.get("session_start")?.({ reason: marker }, ctx);
  for (remaining of [25, 24, 10, 16, 10, 31, 25]) handlers.get("turn_end")?.({}, ctx);

  assert.deepEqual(notifications.map(({ type }) => type), ["warning", "error", "error", "warning"]);
  assert.equal(configLoads, 1);
  assert.doesNotMatch(JSON.stringify(notifications), new RegExp(marker));
});
