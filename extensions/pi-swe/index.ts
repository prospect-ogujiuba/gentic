import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSweCommand } from "./src/command.ts";
import { registerSweWorkflowTool } from "./src/tool.ts";

export const PI_SWE_EXTENSION_ID = "pi-swe";
/** Native v2 is qualification-only in this phase; the installed production entrypoint fails closed to compatibility. */
export const PI_SWE_ACTIVATION = "disabled" as const;

export default function piSwe(pi: ExtensionAPI): void {
  registerSweCommand(pi);
  registerSweWorkflowTool(pi);
}
