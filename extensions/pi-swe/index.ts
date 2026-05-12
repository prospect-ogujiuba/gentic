import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerSweCommands } from "./src/commands.ts";
import { registerSweEvents } from "./src/events.ts";
import { createRuntime } from "./src/runtime.ts";

export const PI_SWE_EXTENSION_ID = "pi-swe";
export const PI_SWE_EXTENSION_NAME = "Pi SWE";

export type PiSweExtensionMetadata = {
  id: typeof PI_SWE_EXTENSION_ID;
  name: typeof PI_SWE_EXTENSION_NAME;
  description: string;
};

export const metadata: PiSweExtensionMetadata = {
  id: PI_SWE_EXTENSION_ID,
  name: PI_SWE_EXTENSION_NAME,
  description: "Runtime SWE workflow guidance for planning, inspection, scope, and verification.",
};

export default function piSwe(pi: ExtensionAPI, initialCtx?: ExtensionContext): void {
  const runtime = createRuntime(initialCtx);

  registerSweEvents(pi, runtime);
  registerSweCommands(pi, runtime);
}
