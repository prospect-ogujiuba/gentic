import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+shift+x", {
    description: "{{description}}",
    handler: async (ctx) => ctx.ui.notify("{{kebabName}}", "info"),
  });
}
