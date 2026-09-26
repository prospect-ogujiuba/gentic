import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { promptPolicy } from "../../prompt-policy.ts";

export default function conciseOutput(pi: ExtensionAPI): void {
  const applyPolicy = promptPolicy(readFileSync(new URL("./injection.md", import.meta.url), "utf8"));
  pi.on("before_agent_start", (event) => applyPolicy(event.systemPrompt));
}
