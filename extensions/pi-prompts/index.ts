import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Prompt templates are discovered from Markdown files under prompts/ via
 * package.json#pi.prompts. This extension exists as the owner namespace for
 * shared Gentic prompt templates.
 */
export default function piPrompts(_pi: ExtensionAPI): void {
  // No runtime registration required for file-based prompt templates.
}
