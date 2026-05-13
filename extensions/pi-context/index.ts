import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiContext } from "./src/pi/index.ts";

export * from "./src/app/index.ts";
export * from "./src/domain/index.ts";
export * from "./src/pi/index.ts";

export default function piContext(pi: ExtensionAPI): void {
  registerPiContext(pi);
}
