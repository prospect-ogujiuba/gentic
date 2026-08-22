import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme) => new Text(theme.fg("muted", "{{skillTitle}}"), 0, 0));
  });
}
