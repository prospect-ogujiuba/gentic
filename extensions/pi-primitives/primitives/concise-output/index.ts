import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";

import { loadPromptPolicy } from "../../prompt-policy.ts";

export default function conciseOutputPrimitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const applyPolicy = loadPromptPolicy(ctx);
  pi.on("before_agent_start", (event) => applyPolicy(event.systemPrompt));
}
