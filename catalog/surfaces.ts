export const SCHEMA_VERSION = "3" as const;

export const SURFACE_IDS = ["package", "extension", "skill", "prompt-template", "theme"] as const;

export type SurfaceId = (typeof SURFACE_IDS)[number];

export interface SurfaceDefinition {
  id: SurfaceId;
  directory?: string;
  description: string;
  /** Why Gentic treats this as first-class: it is discovered directly by pi package metadata. */
  discovery: "package.json#pi" | "package-manifest";
}

export const SURFACES: readonly SurfaceDefinition[] = [
  {
    id: "package",
    description: "Pi package manifest metadata, install/update identity, and package filtering.",
    discovery: "package-manifest",
  },
  {
    id: "extension",
    directory: "extensions",
    description: "Pi extension modules discovered from package.json pi.extensions globs.",
    discovery: "package.json#pi",
  },
  {
    id: "skill",
    directory: "skills",
    description: "Pi skills discovered from package.json pi.skills globs.",
    discovery: "package.json#pi",
  },
  {
    id: "prompt-template",
    directory: "prompts",
    description: "Pi prompt templates discovered from package.json pi.prompts globs.",
    discovery: "package.json#pi",
  },
  {
    id: "theme",
    directory: "themes",
    description: "Pi theme JSON files discovered from package.json pi.themes globs.",
    discovery: "package.json#pi",
  },
];
