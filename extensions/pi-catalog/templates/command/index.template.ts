import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerCommand("{{commandName}}", {
    description: "{{description}}",
    handler: async (args, ctx) => ctx.ui.notify(args || "{{commandName}} done", "info"),
  });
}
