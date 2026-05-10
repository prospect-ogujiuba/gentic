import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function gentic(pi: ExtensionAPI): void {
  pi.registerCommand("gentic", {
    description: "Show Gentic suite information",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Gentic is loaded as a pi package suite. Use pi package filters to enable or disable individual extensions, skills, prompts, and themes.",
        "info",
      );
    },
  });
}
