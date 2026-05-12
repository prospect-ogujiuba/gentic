import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHudCommand, registerHudEventHandlers } from "./adapter.ts";

export default function piHud(pi: ExtensionAPI): void {
  registerHudEventHandlers(pi);
  registerHudCommand(pi);
}
