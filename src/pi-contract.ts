export const PI_CONTRACT_SCHEMA_VERSION = "3" as const;
export const SCHEMA_VERSION = PI_CONTRACT_SCHEMA_VERSION;
export const PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY = "schemaVersion" as const;

export const PI_PACKAGE_MANIFEST_KEY = "pi" as const;
export const PI_PACKAGE_MANIFEST_DISCOVERY = "package.json#pi" as const;
export const PI_PACKAGE_SURFACE_DISCOVERY = "package-manifest" as const;

export const PI_PACKAGE_SURFACE_IDS = ["package", "extension", "skill", "prompt-template", "theme"] as const;
export const PI_PACKAGE_RESOURCE_KINDS = ["extension", "skill", "prompt-template", "theme"] as const;
export const PI_PACKAGE_RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

export type PiPackageSurfaceId = (typeof PI_PACKAGE_SURFACE_IDS)[number];
export type PiPackageResourceKind = (typeof PI_PACKAGE_RESOURCE_KINDS)[number];
export type PiPackageResourceKey = (typeof PI_PACKAGE_RESOURCE_KEYS)[number];
export type PiPackageDiscovery = typeof PI_PACKAGE_MANIFEST_DISCOVERY | typeof PI_PACKAGE_SURFACE_DISCOVERY;

export interface PiPackageResourceVocabularyEntry {
  surfaceId: PiPackageResourceKind;
  manifestKey: PiPackageResourceKey;
  directory: string;
  label: string;
}

export const PI_PACKAGE_RESOURCE_VOCABULARY: Record<PiPackageResourceKind, PiPackageResourceVocabularyEntry> = {
  extension: {
    surfaceId: "extension",
    manifestKey: "extensions",
    directory: "extensions",
    label: "extension",
  },
  skill: {
    surfaceId: "skill",
    manifestKey: "skills",
    directory: "skills",
    label: "skill",
  },
  "prompt-template": {
    surfaceId: "prompt-template",
    manifestKey: "prompts",
    directory: "prompts",
    label: "prompt template",
  },
  theme: {
    surfaceId: "theme",
    manifestKey: "themes",
    directory: "themes",
    label: "theme",
  },
} as const;

export interface PiPackageSurfaceDefinition {
  id: PiPackageSurfaceId;
  directory?: string;
  manifestKey?: PiPackageResourceKey;
  resourceKind?: PiPackageResourceKind;
  label: string;
  description: string;
  /** Why Gentic treats this as first-class: it is discovered directly by pi package metadata. */
  discovery: PiPackageDiscovery;
}

export const PI_PACKAGE_SURFACES: readonly PiPackageSurfaceDefinition[] = [
  {
    id: "package",
    label: "package manifest",
    description: "Pi package manifest metadata, install/update identity, and package filtering.",
    discovery: PI_PACKAGE_SURFACE_DISCOVERY,
  },
  {
    id: "extension",
    ...PI_PACKAGE_RESOURCE_VOCABULARY.extension,
    resourceKind: "extension",
    description: "Pi extension modules discovered from package.json pi.extensions entries.",
    discovery: PI_PACKAGE_MANIFEST_DISCOVERY,
  },
  {
    id: "skill",
    ...PI_PACKAGE_RESOURCE_VOCABULARY.skill,
    resourceKind: "skill",
    description: "Pi skills discovered from package.json pi.skills entries.",
    discovery: PI_PACKAGE_MANIFEST_DISCOVERY,
  },
  {
    id: "prompt-template",
    ...PI_PACKAGE_RESOURCE_VOCABULARY["prompt-template"],
    resourceKind: "prompt-template",
    description: "Pi prompt templates discovered from package.json pi.prompts entries.",
    discovery: PI_PACKAGE_MANIFEST_DISCOVERY,
  },
  {
    id: "theme",
    ...PI_PACKAGE_RESOURCE_VOCABULARY.theme,
    resourceKind: "theme",
    description: "Pi theme JSON files discovered from package.json pi.themes entries.",
    discovery: PI_PACKAGE_MANIFEST_DISCOVERY,
  },
];

export const PI_EXTENSION_RESOURCE_DISCOVERY_EVENT = "resources_discover" as const;

export const PI_EXTENSION_EVENT_GROUPS = {
  resource: ["resources_discover"],
  session: [
    "session_start",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_compact",
    "session_shutdown",
    "session_before_tree",
    "session_tree",
  ],
  agent: [
    "context",
    "before_provider_request",
    "after_provider_response",
    "before_agent_start",
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ],
  model: ["model_select", "thinking_level_select"],
  tool: ["tool_call", "tool_result"],
  user: ["user_bash", "input"],
} as const;

export const PI_EXTENSION_EVENTS = Object.values(PI_EXTENSION_EVENT_GROUPS).flat();

export type PiExtensionEvent = (typeof PI_EXTENSION_EVENTS)[number];
export type PiExtensionEventGroup = keyof typeof PI_EXTENSION_EVENT_GROUPS;
