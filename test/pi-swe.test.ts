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

test("pi-swe registers runtime event wiring and /swe command", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const todoProvider = {
    getActiveTodo: () => ({ id: "todo-1", title: "Implement adapter", acceptanceCriteria: ["peer context"], definitionOfDone: ["tests pass"] }),
    getTodoScope: () => ({ files: ["extensions/pi-swe/index.ts"] }),
    getTodoEvidence: () => [{ type: "command", command: "npm test", exitCode: 0 }],
  };
  const pi = {
    capabilities: new Map([["pi-todo", todoProvider]]),
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    getCommands() {
      return [{ name: "todo" }];
    },
    getAllTools() {
      return [{ name: "gate", sourceInfo: { path: `${root}/extensions/pi-gate/index.ts` } }];
    },
  };
  const ctx = { cwd: root, sessionId: "test", hasUI: true, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  assert.equal(piSwe(pi as never, ctx as never), undefined);
  assert.deepEqual([...handlers.keys()], ["session_start", "turn_start", "tool_call", "tool_result"]);
  assert.equal(commands.has("swe"), true);

  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start" }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "read", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "edit", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_result")?.({ type: "tool_result", toolName: "bash", input: { command: "node --test test/pi-swe.test.ts" }, details: { exitCode: 0 }, isError: false }, ctx);

  await commands.get("swe")?.handler("status", ctx);
  await commands.get("swe")?.handler("config", ctx);

  assert.ok(notifications.some((entry) => entry.message.includes("enabled: true")));
  assert.ok(notifications.some((entry) => entry.message.includes("detected peers: pi-gate, pi-todo")));
  assert.ok(notifications.some((entry) => entry.message.includes("active plan: todo:todo-1 Implement adapter (AC:1, DoD:1)")));
  assert.ok(notifications.some((entry) => entry.message.includes("todo scope: files:extensions/pi-swe/index.ts")));
  assert.ok(notifications.some((entry) => entry.message.includes("inspected paths: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("changed paths: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("verification count: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("todo evidence count: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("pi-swe config")));
});


const baseStages = ["plan", "diagnose", "implement", "verify", "review", "finalize"] as const;

test("all base pi-swe prompt templates are discoverable", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.pi?.prompts?.includes("./extensions/**/prompts/**/*.md"));

  for (const stage of baseStages) {
    const promptPath = join(root, `extensions/pi-swe/prompts/swe-${stage}.md`);
    assert.equal(existsSync(promptPath), true, `missing prompt for ${stage}`);
    const content = readFileSync(promptPath, "utf8");
    assert.match(content, /^---\n[\s\S]*description:/);
    assert.doesNotMatch(content, /\/sop\b|programming_sop|sop-/);
  }
});

test("all base pi-swe skills are discoverable", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));

  for (const stage of baseStages) {
    const skillPath = join(root, `extensions/pi-swe/skills/swe-${stage}/SKILL.md`);
    assert.equal(existsSync(skillPath), true, `missing skill for ${stage}`);
    const content = readFileSync(skillPath, "utf8");
    assert.match(content, new RegExp(`name: swe-${stage}`));
    assert.match(content, /description:/);
    assert.doesNotMatch(content, /\/sop\b|programming_sop|sop-/);
  }
});
