import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { promptPolicy } from "../../prompt-policy.ts";
import { parsePrimitiveTriggers, matchesPrimitivePrompt } from "../../triggers.ts";

export default function {{camelName}}Primitive(pi: ExtensionAPI): void {
  const applyPolicy = promptPolicy(readFileSync(new URL("./injection.md", import.meta.url), "utf8"));
  const triggers = parsePrimitiveTriggers(readFileSync(new URL("./triggers.json", import.meta.url), "utf8"));

  pi.on("before_agent_start", (event) => {
    if (!matchesPrimitivePrompt(event, triggers)) return;
    return applyPolicy(event.systemPrompt);
  });
}
