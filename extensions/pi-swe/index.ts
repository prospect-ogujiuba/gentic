import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerControllerBoundSweCommand } from "./src/command.ts";
import { SharedRuntimeController } from "./src/runtime.ts";
import { registerControllerBoundSweWorkflowTool } from "./src/tool.ts";

export const PI_SWE_EXTENSION_ID = "pi-swe";
/** One checkout-local selector controls command, tool, UI, and engine runtime selection. */
export const PI_SWE_ACTIVATION = "runtime-selector" as const;

export default function piSwe(pi: ExtensionAPI): void {
  // Register adapters exactly once. Every production surface requires one shared controller.
  // Historical fixture calls `registerSweCommand(pi)` and `registerSweWorkflowTool(pi)` are not production composition.
  const runtime = new SharedRuntimeController(pi);
  registerControllerBoundSweCommand(pi, runtime);
  registerControllerBoundSweWorkflowTool(pi, runtime);
}
