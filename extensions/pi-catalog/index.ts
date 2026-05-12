import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPiCatalog } from "./src/pi/register.ts";

export default function piCatalog(pi: ExtensionAPI): void {
  registerPiCatalog(pi);
}
