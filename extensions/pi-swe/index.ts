import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSweSurface } from "./src/pi/register.ts";

export default function piSwe(pi: ExtensionAPI): void {
  registerSweSurface(pi);
}
