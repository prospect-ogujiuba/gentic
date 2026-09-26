import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "{{kebabName}}",
    label: "{{skillTitle}}",
    description: "{{description}}",
    parameters: Type.Object({ input: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: params.input ?? "{{kebabName}} ready" }], details: {} };
    },
  });
}
