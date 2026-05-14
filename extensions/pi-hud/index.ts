import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiHud } from "./src/pi/register.ts";

export default function piHud(pi: ExtensionAPI): void {
  registerPiHud(pi);
}
