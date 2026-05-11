import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearAlias(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        withSession: async (ctx) => {
          ctx.ui.notify("New session started", "success");
        },
      });
    },
  });
}
