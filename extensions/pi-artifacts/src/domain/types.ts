export const ARTIFACT_KINDS = ["reports", "plans", "findings", "logs", "specs", "todo"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactClassification = "canonical-valid" | "legacy-movable" | "protected" | "ambiguous" | "invalid";

export type MigrationMapping = {
  kind: ArtifactKind;
  topic: string;
  timestamp: string;
  shortName: string;
};

export type MigrationConfig = {
  schemaVersion: 1;
  mappings: Record<string, MigrationMapping>;
};

export type ArtifactInventoryEntry = {
  source: string;
  classification: ArtifactClassification;
  reasons: string[];
  bytes: number;
  contentHash?: string;
  destination?: string;
  topic?: string;
  authorityUnit?: "initiative" | "system" | "isolated";
  referenceSites?: string[];
  referenceSiteHashes?: Record<string, string>;
};

export type ArtifactInventory = {
  schemaVersion: 1;
  projectRoot: string;
  configPath: string | null;
  entries: ArtifactInventoryEntry[];
  totals: Record<ArtifactClassification, number>;
  fileCount: number;
  candidateBytes: number;
  diagnostics: string[];
};

export type AuditArtifactsOptions = {
  cwd: string;
  maxFiles?: number;
  maxBytes?: number;
  maxReferenceFiles?: number;
  maxReferenceBytes?: number;
};
