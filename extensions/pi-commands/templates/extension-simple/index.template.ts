import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("{{kebabName}}", "{{statusText}}");
  });
}
