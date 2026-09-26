import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerProvider("{{kebabName}}", {
    baseUrl: "https://api.example.com/v1",
    apiKey: "$PROVIDER_API_KEY",
    api: "openai-responses",
    models: [],
  });
}
