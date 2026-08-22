import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import piPrimitives, { loadPrimitives } from "../extensions/pi-primitives/index.ts";

type BeforeAgentStartEvent = {
  prompt?: string;
  systemPrompt: string;
  systemPromptOptions?: Record<string, unknown>;
};

type Handler = (event: BeforeAgentStartEvent) => { systemPrompt?: string } | undefined;

async function beforeAgentStartPipeline(): Promise<Handler> {
  const handlers: Handler[] = [];
  await piPrimitives({
    on(name: string, callback: Handler) {
      if (name === "before_agent_start") handlers.push(callback);
    },
  } as never);

  assert.ok(handlers.length > 0);
  return (event) => {
    let current = { ...event };
    let changed = false;
    for (const handler of handlers) {
      const result = handler(current);
      if (result?.systemPrompt) {
        current = { ...current, systemPrompt: result.systemPrompt };
        changed = true;
      }
    }
    return changed ? { systemPrompt: current.systemPrompt } : undefined;
  };
}

test("implementation-file-completion primitive matches expanded user prompt", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Implement this SWE slice: docs/phase-1.md",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /\[COMPLETE\]/);
});

test("implementation-file-completion primitive skips unrelated prompts", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Output and Responses Efficiency Policy/);
  assert.doesNotMatch(result?.systemPrompt || "", /\[COMPLETE\]/);
});

test("concise-output primitive injects reusable output policy", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Output and Responses Efficiency Policy/);
  assert.match(result?.systemPrompt || "", /Minimize visible output\./);
});

test("concise-output primitive skips duplicate policy", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE\n\n# Output and Responses Efficiency Policy\n\nExisting copy.",
    systemPromptOptions: {},
  });

  assert.equal(result, undefined);
});

test("model-artifacts primitive injects reusable artifact convention", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Write a generated artifact for the review evidence",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Model artifacts convention/);
  assert.match(result?.systemPrompt || "", /\.model-artifacts\/<kind>\/<topic>/);
});

test("primitive triggers flatten structured context files", async () => {
  const handler = await beforeAgentStartPipeline();
  const result = handler({
    prompt: "Continue",
    systemPrompt: "BASE",
    systemPromptOptions: { contextFiles: [{ path: ".model-artifacts/plans/demo.md", content: "phase" }] },
  });
  assert.match(result?.systemPrompt || "", /Model artifacts convention/);
});

test("invalid primitive JSON, regex, and imports do not prevent later modules loading", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-"));
  const triggersModule = pathToFileURL(join(new URL("..", import.meta.url).pathname, "extensions/pi-primitives/triggers.ts")).href;
  const fixtures = {
    "invalid-import": `import "./missing.ts"; export default function () {}`,
    "invalid-json": `import { loadPrimitiveTriggers } from ${JSON.stringify(triggersModule)}; export default function (_pi, ctx) { loadPrimitiveTriggers(ctx); }`,
    "invalid-regex": `import { loadPrimitiveTriggers } from ${JSON.stringify(triggersModule)}; export default function (_pi, ctx) { loadPrimitiveTriggers(ctx); }`,
    "z-valid": `export default function (pi) { pi.registerCommand("later", { description: "later", handler() {} }); }`,
  };
  try {
    for (const [name, source] of Object.entries(fixtures)) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), source);
    }
    writeFileSync(join(root, "invalid-json/triggers.json"), "{");
    writeFileSync(join(root, "invalid-regex/triggers.json"), JSON.stringify({ pathPatterns: ["["] }));
    const commands: string[] = [];
    const report = await loadPrimitives({ registerCommand(name: string) { commands.push(name); } } as never, { primitivesDir: root });
    assert.deepEqual(report.loaded, ["z-valid"]);
    assert.deepEqual(report.failures.map((failure) => failure.name), ["invalid-import", "invalid-json", "invalid-regex"]);
    assert.deepEqual(commands, ["later"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primitive config can disable modules without hiding status data", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-config-"));
  try {
    mkdirSync(join(root, "disabled"));
    writeFileSync(join(root, "disabled/index.ts"), `export default function () { throw new Error("should not load"); }`);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ disabled: ["disabled"] }));
    const report = await loadPrimitives({} as never, { primitivesDir: root, configPath });
    assert.deepEqual(report.skipped, ["disabled"]);
    assert.deepEqual(report.failures, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
