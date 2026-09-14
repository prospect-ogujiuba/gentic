import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";
import { loadPrimitiveTriggers, matchesPrimitivePrompt } from "../../triggers.ts";
import { loadPromptPolicy } from "../../prompt-policy.ts";

export default function modelArtifactsPrimitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const applyPolicy = loadPromptPolicy(ctx);
  const triggers = loadPrimitiveTriggers(ctx);

  pi.on("before_agent_start", (event) => {
    if (!matchesPrimitivePrompt(event, triggers)) return;
    return applyPolicy(event.systemPrompt);
  });
}
