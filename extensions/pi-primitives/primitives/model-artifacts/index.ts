import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { promptPolicy } from "../../prompt-policy.ts";
import { pathCandidates, promptFields } from "../../prompt-input.ts";

export default function modelArtifacts(pi: ExtensionAPI): void {
  const applyPolicy = promptPolicy(readFileSync(new URL("./injection.md", import.meta.url), "utf8"));
  pi.on("before_agent_start", (event) => {
    const applicable = promptFields(event).some((text) => {
      const lower = text.toLowerCase();
      if (["model artifacts", "model-artifacts", ".model-artifacts", "generated artifact", "artifact path", "write a report", "write a plan", "analysis artifact", "coordination artifact", "todo artifact", "review evidence"].some((phrase) => lower.includes(phrase))) return true;
      return pathCandidates(text).some((path) => /\.model-artifacts\//i.test(path) || /\b(?:reports|plans|findings|logs|specs|todo)\/[\w./-]*\.md\b/i.test(path));
    });
    if (applicable) return applyPolicy(event.systemPrompt);
  });
}
