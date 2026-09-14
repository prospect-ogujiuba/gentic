import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";
import { loadPromptPolicy } from "../../prompt-policy.ts";
import { loadPrimitiveTriggers, matchesPrimitivePrompt } from "../../triggers.ts";

export default function {{camelName}}Primitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const applyPolicy = loadPromptPolicy(ctx);
  const triggers = loadPrimitiveTriggers(ctx);

  pi.on("before_agent_start", (event) => {
    if (!matchesPrimitivePrompt(event, triggers)) return;
    return applyPolicy(event.systemPrompt);
  });
}
