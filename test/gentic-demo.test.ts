import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piCatalog from "../extensions/pi-catalog/index.ts";
import piCommands from "../extensions/pi-commands/index.ts";
import piGit from "../extensions/pi-git/index.ts";
import piHud from "../extensions/pi-hud/index.ts";
import piPrimitives from "../extensions/pi-primitives/index.ts";
import piSwe from "../extensions/pi-swe/index.ts";
import piTodo from "../extensions/pi-todo/index.ts";

const root = new URL("..", import.meta.url).pathname;

type Handler = (event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => unknown;

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => Array<Record<string, unknown>>;
  sourceInfo?: { path: string; source?: string; scope?: string; origin?: string };
};

type RegisteredTool = {
  name: string;
  description?: string;
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
  sourceInfo?: { path: string; source?: string; scope?: string; origin?: string };
};

function createContext(entries: Array<Record<string, unknown>>) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const cwd = mkdtempSync(join(tmpdir(), "gentic-demo-"));
  const status = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();
  let footer: unknown;
  let title = "";
  let reloaded = false;
  let newSessionStarted = false;

  const ctx = {
    cwd,
    sessionId: "demo-session",
    hasUI: true,
    mode: "tui" as const,
    signal: undefined,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
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
  const metadataScans = { commands: 0, tools: 0 };
  let currentExtension = "unknown";
  let sessionName = "";

  const pi = {
    events: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) || []), handler]);
      },
    },
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
      commands.set(name, {
        ...command,
        sourceInfo: { path: join(root, "extensions", currentExtension, "index.ts"), source: currentExtension, scope: "project", origin: "top-level" },
      });
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, {
        ...tool,
        sourceInfo: { path: join(root, "extensions", currentExtension, "index.ts"), source: currentExtension, scope: "project", origin: "top-level" },
      });
    },
    getCommands() {
      metadataScans.commands += 1;
      return [...commands].map(([name, command]) => ({
        name,
        description: command.description,
        source: "extension",
        sourceInfo: command.sourceInfo,
      }));
    },
    getAllTools() {
      metadataScans.tools += 1;
      return [...tools].map(([name, tool]) => ({ name, description: tool.description, sourceInfo: tool.sourceInfo }));
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { stdout: `${root}\n`, code: 0 };
      if (key === "status --porcelain=v1 --branch -z --untracked-files=all") return { stdout: "## demo\0", code: 0 };
      if (key === "remote -v") return { stdout: "", code: 0 };
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
  return { pi, ctx, handlers, commands, tools, entries, sentUserMessages, execCalls, metadataScans, activate, emit };
}

test("catalog queries native command and tool metadata once per operation", async (t) => {
  const harness = createPiHarness();
  t.after(() => rmSync(harness.ctx.cwd, { recursive: true, force: true }));

  await harness.activate("plugin-a", (pi) => {
    pi.registerCommand("deploy", { description: "Deploy the durable service", handler() {} });
    pi.registerTool({ name: "deploy_status", description: "Inspect the durable deployment", execute() {} });
  });
  await harness.activate("pi-catalog", piCatalog as never);
  await harness.emit("session_start", { reason: "startup" }, harness.ctx);
  await harness.emit("resources_discover", { reason: "reload" }, harness.ctx);

  await harness.commands.get("catalog")?.handler("status", harness.ctx);
  const status = harness.ctx.demoState.notifications.at(-1);
  assert.match(status?.message ?? "", /gentic@0\.1\.0/);
  assert.match(status?.message ?? "", new RegExp(`cwd: ${harness.ctx.cwd}`));
  assert.match(status?.message ?? "", /resources: reload/);
  assert.match(status?.message ?? "", /Commands \(2\)/);
  assert.match(status?.message ?? "", /Tools \(2\)/);
  assert.match(status?.message ?? "", /Owners: pi-catalog, plugin-a/);
  assert.deepEqual(harness.metadataScans, { commands: 1, tools: 1 });

  await harness.commands.get("catalog")?.handler("search durable", harness.ctx);
  const search = harness.ctx.demoState.notifications.at(-1);
  assert.match(search?.message ?? "", /Commands[\s\S]*\/deploy - Deploy the durable service/);
  assert.match(search?.message ?? "", /Tools[\s\S]*deploy_status - Inspect the durable deployment/);
  assert.deepEqual(harness.metadataScans, { commands: 2, tools: 2 });

  const result = await harness.tools.get("gentic_catalog")?.execute("tool-call", { operation: "search", query: "plugin-a" }) as {
    content: Array<{ text: string }>;
    details: { commandCount: number; toolCount: number; matches: { commands: unknown[]; tools: unknown[] } };
  };
  assert.match(result.content[0].text, /\/deploy/);
  assert.match(result.content[0].text, /deploy_status/);
  assert.equal(result.details.commandCount, 2);
  assert.equal(result.details.toolCount, 2);
  assert.equal(result.details.matches.commands.length, 1);
  assert.equal(result.details.matches.tools.length, 1);
  assert.deepEqual(harness.metadataScans, { commands: 3, tools: 3 });
});

test("demo activates every Gentic-owned extension and exercises shared runtime paths", async (t) => {
  const harness = createPiHarness();
  t.after(async () => {
    await harness.emit("session_shutdown", { reason: "test-complete" }, harness.ctx);
    rmSync(harness.ctx.cwd, { recursive: true, force: true });
  });

  await harness.activate("pi-catalog", piCatalog as never);
  await harness.activate("pi-commands", piCommands as never);
  await harness.activate("pi-git", piGit as never);
  await harness.activate("pi-hud", piHud as never);
  await harness.activate("pi-primitives", piPrimitives as never);
  await harness.activate("pi-swe", piSwe as never);
  await harness.activate("pi-todo", piTodo as never);

  for (const command of ["catalog", "clear", "scaffold", "pi-git", "pi-hud", "swe", "todo"]) {
    assert.equal(harness.commands.has(command), true, `missing /${command}`);
  }

  for (const tool of ["gentic_catalog", "git_snapshot", "todo"]) {
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

  const catalogStatus = await harness.tools.get("gentic_catalog")?.execute("tool-call", { operation: "status" }, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(catalogStatus.content[0].text, /Commands \(\d+\)[\s\S]*Tools \(\d+\)/);

  const gitSnapshot = await harness.tools.get("git_snapshot")?.execute("tool-call", {}, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(gitSnapshot.content[0].text, /branch: demo/);
  assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.includes("status")));

  const todoTool = harness.tools.get("todo");
  const created = await todoTool?.execute("tool-call", { action: "create", title: "exercise all extensions", acceptanceCriteria: ["demo passes"] }, undefined, undefined, harness.ctx) as { content: Array<{ text: string }>; details: { todo: { id: string } } };
  assert.match(created.content[0].text, /Created/);
  const listed = await todoTool?.execute("tool-call", { action: "list", includeDone: true }, undefined, undefined, harness.ctx) as { content: Array<{ text: string }> };
  assert.match(listed.content[0].text, /exercise all extensions/);

  await harness.commands.get("catalog")?.handler("search pi-swe", harness.ctx);
  await harness.commands.get("gate")?.handler("check node --version", harness.ctx);
  await harness.commands.get("pi-git")?.handler("", harness.ctx);
  await harness.commands.get("pi-hud")?.handler("show", harness.ctx);
  await harness.commands.get("swe")?.handler("status", harness.ctx);
  await harness.commands.get("todo")?.handler("list", harness.ctx);
  await harness.commands.get("clear")?.handler("", harness.ctx);

  assert.equal(harness.ctx.demoState.newSessionStarted, true);
  assert.ok(harness.ctx.demoState.notifications.some((entry) => entry.message.includes("pi-swe")));
  assert.ok(harness.ctx.demoState.notifications.some((entry) => entry.message.includes("Commands") && entry.message.includes("/swe")));
  assert.equal(harness.ctx.demoState.status.has("todo"), true);
  assert.equal(harness.ctx.demoState.status.has("pi-catalog"), true);
});
