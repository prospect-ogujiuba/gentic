import assert from "node:assert/strict";
import { test } from "node:test";

import piPrimitives from "../extensions/pi-primitives/index.ts";

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
