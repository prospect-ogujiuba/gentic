import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPiGit } from "./src/pi/register.ts";

export default function piGit(pi: ExtensionAPI): void {
  registerPiGit(pi);
}
