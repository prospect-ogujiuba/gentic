import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import gentic from "../extensions/gentic/index.ts";
import piCatalog from "../extensions/pi-catalog/index.ts";
import piCommands from "../extensions/pi-commands/index.ts";
import piGate from "../extensions/pi-gate/index.ts";
import piGit from "../extensions/pi-git/index.ts";
import piHud from "../extensions/pi-hud/index.ts";
import piPrimitives from "../extensions/pi-primitives/index.ts";
import piPrompts from "../extensions/pi-prompts/index.ts";
import piSkills from "../extensions/pi-skills/index.ts";
import piSwe from "../extensions/pi-swe/index.ts";
import piTodo from "../extensions/pi-todo/index.ts";

const root = new URL("..", import.meta.url).pathname;

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => unknown;

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => Array<Record<string, unknown>>;
  sourceInfo?: { path: string };
};

type RegisteredTool = {
  name: string;
  description?: string;
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
  sourceInfo?: { path: string };
};

function createContext(entries: Array<Record<string, unknown>>) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const status = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();
  let footer: unknown;
  let title = "";
  let reloaded = false;
  let newSessionStarted = false;

  const ctx = {
    cwd: root,
    sessionId: "demo-session",
    hasUI: true,
    signal: undefined,
    sessionManager: {
      getEntries: () => entries,
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, value: unknown) {
        status.set(key, value);
      },
      setWidget(key: string, value: unknown) {
        widgets.set(key, value);
      },
      setFooter(value: unknown) {
        footer = value;
      },
      setTitle(value: string) {
        title = value;
      },
    },
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
    waitForIdle: async () => undefined,
    newSession: async ({ withSession }: { withSession?: (ctx: unknown) => Promise<void> | void }) => {
      newSessionStarted = true;
      await withSession?.(ctx);
    },
    demoState: {
      notifications,
      status,
      widgets,
      get footer() {
        return footer;
      },
      get title() {
        return title;
      },
      get reloaded() {
        return reloaded;
      },
      get newSessionStarted() {
        return newSessionStarted;
      },
    },
  };
  return ctx;
}

function createPiHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const entries: Array<Record<string, unknown>> = [];
  const sentUserMessages: Array<{ message: string; options?: unknown }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  let currentExtension = "unknown";
  let sessionName = "";

  const pi = {
    capabilities: new Map([
      [
        "pi-todo",
        {
          getActiveTodo: () => ({ id: "todo-demo", title: "Demo active task", acceptanceCriteria: ["all extensions"], definitionOfDone: ["tests pass"] }),
          getTodoScope: () => ({ files: ["test/gentic-demo.test.ts"] }),
          getTodoEvidence: () => [{ type: "command", command: "npm test", exitCode: 0 }],
        },
      ],
    ]),
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, { ...command, sourceInfo: { path: join(root, "extensions", currentExtension, "index.ts") } });
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, { ...tool, sourceInfo: { path: join(root, "extensions", currentExtension, "index.ts") } });
    },
    getCommands() {
      return [...commands].map(([name, command]) => ({
        name,
        description: command.description,
        source: "extension",
        sourceInfo: command.sourceInfo,
      }));
    },
    getAllTools() {
      return [...tools].map(([name, tool]) => ({ name, sourceInfo: tool.sourceInfo }));
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { stdout: `${root}\n`, code: 0 };
      if (key === "branch --show-current") return { stdout: "demo\n", code: 0 };
      if (key === "status --short --branch") return { stdout: "## demo\n", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(message: string, options?: unknown) {
      sentUserMessages.push({ message, options });
    },
    getSessionName: () => sessionName,
    setSessionName(value: string) {
      sessionName = value;
    },
  };

  async function activate(name: string, extension: (pi: typeof pi) => unknown) {
    currentExtension = name;
    await extension(pi);
    currentExtension = "unknown";
  }

  async function emit(event: string, payload: Record<string, unknown>, ctx: ReturnType<typeof createContext>) {
    const results = [];
    for (const handler of handlers.get(event) || []) results.push(await handler({ type: event, ...payload }, ctx));
    return results;
  }

  const ctx = createContext(entries);
  return { pi, ctx, handlers, commands, tools, entries, sentUserMessages, execCalls, activate, emit };
}

test("demo activates every Gentic extension and exercises shared runtime paths", async () => {
  const harness = createPiHarness();

  await harness.activate("gentic", gentic as never);
  await harness.activate("pi-catalog", piCatalog as never);
  await harness.activate("pi-commands", piCommands as never);
  await harness.activate("pi-gate", piGate as never);
  await harness.activate("pi-git", piGit as never);
  await harness.activate("pi-hud", piHud as never);
  await harness.activate("pi-primitives", piPrimitives as never);
  await harness.activate("pi-prompts", piPrompts as never);
  await harness.activate("pi-skills", piSkills as never);
  await harness.activate("pi-swe", piSwe as never);
  await harness.activate("pi-todo", piTodo as never);

  for (const command of ["gentic", "catalog", "surfaces", "surface", "events", "clear", "gate", "pi-git", "pi-hud", "swe", "todo"]) {
    assert.equal(harness.commands.has(command), true, `missing /${command}`);
  }

  for (const tool of [
    "gentic_status",
    "gentic_surfaces",
    "gentic_pi_extension_events",
    "gentic_surface_package",
    "gentic_surface_extension",
    "gentic_surface_skill",
    "gentic_surface_prompt_template",
    "gentic_surface_theme",
    "git_snapshot",
    "todo",
  ]) {
    assert.equal(harness.tools.has(tool), true, `missing tool ${tool}`);
  }

  await harness.emit("session_start", { reason: "demo" }, harness.ctx);
  await harness.emit("resources_discover", { reason: "reload" }, harness.ctx);
  await harness.emit("agent_start", {}, harness.ctx);
  await harness.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npm test" } }, harness.ctx);
  await harness.emit("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: false }, harness.ctx);
  await harness.emit("tool_result", { toolName: "bash", content: "warning: demo", isError: false }, harness.ctx);
  await harness.emit("agent_end", {}, harness.ctx);

  const primitiveResults = await harness.emit(
    "before_agent_start",
    {
      prompt: "finish the implementation file for extensions/pi-swe/index.ts",
      systemPrompt: "base system prompt",
      systemPromptOptions: {},
    },
    harness.ctx,
  );
  assert.ok(primitiveResults.some((result) => JSON.stringify(result).includes("Implementation file completion convention")));

  const genticStatus = await harness.tools.get("gentic_status")?.execute("tool-call", {}, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(genticStatus.content[0].text, /extension command owners:/);
  assert.match(genticStatus.content[0].text, /pi-swe/);

  const surfaces = await harness.tools.get("gentic_surfaces")?.execute("tool-call", {}, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(surfaces.content[0].text, /prompt-template/);

  const gitSnapshot = await harness.tools.get("git_snapshot")?.execute("tool-call", {}, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(gitSnapshot.content[0].text, /branch: demo/);
  assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.includes("status")));

  const todoTool = harness.tools.get("todo");
  const created = await todoTool?.execute("tool-call", { action: "create", title: "exercise all extensions", acceptanceCriteria: ["demo passes"] }, undefined, undefined, harness.ctx) as { content: Array<{ text: string }>; details: { todo: { id: string } } };
  assert.match(created.content[0].text, /Created/);
  const listed = await todoTool?.execute("tool-call", { action: "list", includeDone: true }, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(listed.content[0].text, /exercise all extensions/);

  await harness.commands.get("gentic")?.handler("find swe", harness.ctx);
  await harness.commands.get("gentic")?.handler("run todo list", harness.ctx);
  await harness.commands.get("catalog")?.handler("surface package", harness.ctx);
  await harness.commands.get("gate")?.handler("check node --version", harness.ctx);
  await harness.commands.get("pi-git")?.handler("", harness.ctx);
  await harness.commands.get("pi-hud")?.handler("show", harness.ctx);
  await harness.commands.get("swe")?.handler("status", harness.ctx);
  await harness.commands.get("todo")?.handler("list", harness.ctx);
  await harness.commands.get("clear")?.handler("", harness.ctx);

  assert.ok(harness.sentUserMessages.some((message) => message.message === "/todo list"));
  assert.equal(harness.ctx.demoState.newSessionStarted, true);
  assert.ok(harness.ctx.demoState.notifications.some((entry) => entry.message.includes("pi-swe status")));
  assert.ok(harness.ctx.demoState.notifications.some((entry) => entry.message.includes("Pi package surfaces") || entry.message.includes("package manifest")));
  assert.equal(harness.ctx.demoState.status.has("todo"), true);
  assert.equal(harness.ctx.demoState.status.has("pi-catalog"), true);
  assert.equal(harness.ctx.demoState.status.has("gentic"), true);
});
