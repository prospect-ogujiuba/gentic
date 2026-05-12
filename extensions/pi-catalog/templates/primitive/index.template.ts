import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Primitive, PrimitiveContext } from "../../index.ts";

const primitive: Primitive = (pi: ExtensionAPI, ctx: PrimitiveContext): void => {
  const content = ctx.readText("{{supportingFileName}}");

  pi.on("before_agent_start", (event) => {
    if (!event.prompt.includes("{{triggerPhrase}}")) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${content}`,
    };
  });
};

export default primitive;
