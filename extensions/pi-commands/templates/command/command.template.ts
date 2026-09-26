import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiCommandModule } from "../types.ts";

export const {{camelName}}Command: PiCommandModule = {
  name: "{{commandName}}",
  register(pi: ExtensionAPI): void {
    pi.registerCommand("{{commandName}}", {
      description: "{{description}}",
      handler: async (args, ctx) => {
        ctx.ui.notify(`{{commandName}}: ${args || "done"}`, "info");
      },
    });
  },
};
