import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrimitiveContext } from "../../index.ts";

export default function implementationFileCompletion(pi: ExtensionAPI, ctx: PrimitiveContext): void {
  pi.on("before_agent_start", (event) => {
    const injection = ctx.readText("injection.md").trim();
    if (!injection) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
