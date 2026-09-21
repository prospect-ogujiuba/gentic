import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerArtifactSurface } from "./src/pi/register.ts";

export { ArtifactService, MAX_ARTIFACT_CONTENT_BYTES } from "./src/app/service.ts";
export { artifactTimestamp, createArtifactPath, validateCanonicalArtifactPath } from "./src/domain/normalize.ts";
export {
  INITIATIVE_ARTIFACT_KINDS,
  SYSTEM_ARTIFACT_KINDS,
  type CreateArtifactRequest,
  type CreatedArtifact,
  type InitiativeArtifactKind,
  type SystemArtifactKind,
} from "./src/domain/types.ts";

export default function piArtifacts(pi: ExtensionAPI): void {
  registerArtifactSurface(pi);
}
