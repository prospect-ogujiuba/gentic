import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { promptPolicy } from "../../prompt-policy.ts";
import { pathCandidates, promptFields } from "../../prompt-input.ts";

export default function implementationFileCompletion(pi: ExtensionAPI): void {
  const applyPolicy = promptPolicy(readFileSync(new URL("./injection.md", import.meta.url), "utf8"));
  pi.on("before_agent_start", (event) => {
    const applicable = promptFields(event).some((text) => {
      const lower = text.toLowerCase();
      if (["assigned file", "plan file", "phase file", "implementation file", "todo file", "acceptance criteria", "definition of done", "implementation contract", "next phase", "later phase"].some((phrase) => lower.includes(phrase))) return true;
      return pathCandidates(text).some((path) => /\b[\w./-]*(?:plan|phase|todo|implementation)[\w./-]*\.md\b/i.test(path));
    });
    if (applicable) return applyPolicy(event.systemPrompt);
  });
}
