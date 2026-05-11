import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  description: "Skeleton extension for future SWE workflow guidance.",
};

export default function piSwe(_pi: ExtensionAPI, _ctx: ExtensionContext): void {
  // Phase 01 intentionally registers no commands, events, policy checks, or warnings.
}
