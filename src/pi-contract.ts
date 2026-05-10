export const SCHEMA_VERSION = "3" as const;

export const PI_PACKAGE_SURFACE_IDS = ["package", "extension", "skill", "prompt-template", "theme"] as const;

export type PiPackageSurfaceId = (typeof PI_PACKAGE_SURFACE_IDS)[number];

export interface PiPackageSurfaceDefinition {
  id: PiPackageSurfaceId;
  directory?: string;
  description: string;
  /** Why Gentic treats this as first-class: it is discovered directly by pi package metadata. */
  discovery: "package.json#pi" | "package-manifest";
}

export const PI_PACKAGE_SURFACES: readonly PiPackageSurfaceDefinition[] = [
  {
    id: "package",
    description: "Pi package manifest metadata, install/update identity, and package filtering.",
    discovery: "package-manifest",
  },
  {
    id: "extension",
    directory: "extensions",
    description: "Pi extension modules discovered from package.json pi.extensions entries.",
    discovery: "package.json#pi",
  },
  {
    id: "skill",
    directory: "skills",
    description: "Pi skills discovered from package.json pi.skills entries.",
    discovery: "package.json#pi",
  },
  {
    id: "prompt-template",
    directory: "prompts",
    description: "Pi prompt templates discovered from package.json pi.prompts entries.",
    discovery: "package.json#pi",
  },
  {
    id: "theme",
    directory: "themes",
    description: "Pi theme JSON files discovered from package.json pi.themes entries.",
    discovery: "package.json#pi",
  },
];

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
