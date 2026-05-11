import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commands } from "./commands/index.ts";

export default function piCommands(pi: ExtensionAPI): void {
  for (const command of commands) command.register(pi);
}
