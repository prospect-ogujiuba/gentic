import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerArtifactsCommand } from "./src/pi/commands.ts";

export default function piArtifacts(pi: ExtensionAPI): void {
  registerArtifactsCommand(pi);
}
