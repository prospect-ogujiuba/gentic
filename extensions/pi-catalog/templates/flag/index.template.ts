import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function {{camelName}}(pi: ExtensionAPI): void {
  pi.registerFlag("{{kebabName}}", {
    description: "{{description}}",
    type: "boolean",
    default: false,
  });
}
