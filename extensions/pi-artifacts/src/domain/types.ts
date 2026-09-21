export const INITIATIVE_ARTIFACT_KINDS = ["specs", "plans", "todo", "findings", "reports", "logs"] as const;
export const SYSTEM_ARTIFACT_KINDS = ["reports", "logs"] as const;

export type InitiativeArtifactKind = typeof INITIATIVE_ARTIFACT_KINDS[number];
export type SystemArtifactKind = typeof SYSTEM_ARTIFACT_KINDS[number];

export type CreateInitiativeArtifact = {
  scope: "initiative";
  topic: string;
  kind: InitiativeArtifactKind;
  name: string;
  content: string;
};

export type CreateSystemArtifact = {
  scope: "system";
  kind: SystemArtifactKind;
  namespace?: string;
  name: string;
  content: string;
};

export type CreateArtifactRequest = CreateInitiativeArtifact | CreateSystemArtifact;

export type CreatedArtifact = {
  path: string;
  createdAt: string;
  bytes: number;
  contentHash: `sha256:${string}`;
};
