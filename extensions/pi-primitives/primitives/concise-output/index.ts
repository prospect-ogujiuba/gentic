import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";

const POLICY_HEADING = "# Output and Responses Efficiency Policy";

export default function conciseOutputPrimitive(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  const injection = ctx.readText("injection.md").trim();
  if (!injection) return;

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(POLICY_HEADING)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
