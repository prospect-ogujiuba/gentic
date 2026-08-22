import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";
import { loadPrimitiveTriggers, matchesPrimitiveTrigger } from "../../triggers.ts";

export default function modelArtifactsPrimitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const injection = ctx.readText("injection.md").trim();
  const triggers = loadPrimitiveTriggers(ctx);
  if (!injection) return;

  pi.on("before_agent_start", (event) => {
    const input = {
      prompt: event.prompt,
      customPrompt: event.systemPromptOptions?.customPrompt,
      appendSystemPrompt: event.systemPromptOptions?.appendSystemPrompt,
      contextFiles: event.systemPromptOptions?.contextFiles,
    };
    if (!matchesPrimitiveTrigger(input, triggers)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
