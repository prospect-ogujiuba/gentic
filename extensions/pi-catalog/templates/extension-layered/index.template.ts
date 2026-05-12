import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register{{pascalName}} } from "./src/pi/register.ts";

export default function {{camelName}}(pi: ExtensionAPI): void {
  register{{pascalName}}(pi);
}
