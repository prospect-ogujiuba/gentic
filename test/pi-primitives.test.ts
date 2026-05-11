import assert from "node:assert/strict";
import { test } from "node:test";

import piPrimitives from "../extensions/pi-primitives/index.ts";

type Handler = (event: {
  prompt?: string;
  systemPrompt: string;
  systemPromptOptions?: Record<string, unknown>;
}) => { systemPrompt?: string } | undefined;

async function beforeAgentStartHandler(): Promise<Handler> {
  let handler: Handler | undefined;
  await piPrimitives({
    on(name: string, callback: Handler) {
      if (name === "before_agent_start") handler = callback;
    },
  } as never);

  assert.ok(handler);
  return handler;
}

test("implementation-file-completion primitive matches expanded user prompt", async () => {
  const handler = await beforeAgentStartHandler();

  const result = handler({
    prompt: "Implement this SWE slice: docs/phase-1.md",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /\[COMPLETE\]/);
});

test("implementation-file-completion primitive skips unrelated prompts", async () => {
  const handler = await beforeAgentStartHandler();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.equal(result, undefined);
});
