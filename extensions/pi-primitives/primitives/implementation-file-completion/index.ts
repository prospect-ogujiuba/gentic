import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";

type Triggers = {
  phrases?: string[];
  pathPatterns?: string[];
};

function loadTriggers(ctx: PrimitiveContext): Triggers {
  return JSON.parse(ctx.readText("triggers.json")) as Triggers;
}

function matchesTrigger(text: string, triggers: Triggers): boolean {
  const haystack = text.toLowerCase();
  const phrases = triggers.phrases || [];
  if (phrases.some((phrase) => haystack.includes(phrase.toLowerCase()))) return true;

  return (triggers.pathPatterns || []).some((pattern) => new RegExp(pattern, "i").test(text));
}

export default function implementationFileCompletion(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const injection = ctx.readText("injection.md").trim();
  const triggers = loadTriggers(ctx);
  if (!injection) return;

  pi.on("before_agent_start", (event) => {
    const text = [event.prompt, event.systemPromptOptions?.customPrompt, event.systemPromptOptions?.appendSystemPrompt, event.systemPromptOptions?.contextFiles]
      .filter(Boolean)
      .join("\n");

    if (!matchesTrigger(text, triggers)) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
