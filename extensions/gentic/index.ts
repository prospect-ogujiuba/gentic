import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGentic } from "./src/pi/register.ts";

export default function gentic(pi: ExtensionAPI): void {
  registerGentic(pi);
}
