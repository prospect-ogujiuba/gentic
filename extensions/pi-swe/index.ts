import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSweCommand } from "./src/command.ts";
import { registerSweWorkflowTool } from "./src/tool.ts";

export const PI_SWE_EXTENSION_ID = "pi-swe";

export default function piSwe(pi: ExtensionAPI): void {
  registerSweCommand(pi);
  registerSweWorkflowTool(pi);
}
