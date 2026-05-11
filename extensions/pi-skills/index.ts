import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Skills are discovered from directories under skills/ via package.json#pi.skills.
 * This extension exists as the owner namespace for shared Gentic skills.
 */
export default function piSkills(_pi: ExtensionAPI): void {
  // No runtime registration required for file-based skills.
}
