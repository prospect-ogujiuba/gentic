export const SCHEMA_VERSION = "1" as const;

export const SURFACE_IDS = [
  "package",
  "extension",
  "skill",
  "prompt-template",
  "theme",
  "context",
  "flag",
  "command",
  "shortcut",
  "tool",
  "event",
  "event-bus",
  "session-state",
  "session-labels",
  "tool-control",
  "model-control",
  "provider",
  "model",
  "exec",
  "message-injection",
  "message-renderer",
  "ui-component",
  "sdk",
  "rpc",
] as const;

export type SurfaceId = (typeof SURFACE_IDS)[number];

export interface SurfaceDefinition {
  id: SurfaceId;
  directory?: string;
  description: string;
}

export const SURFACES: readonly SurfaceDefinition[] = [
  { id: "package", description: "Pi package manifests, install/update metadata, and package filtering." },
  { id: "extension", directory: "extensions", description: "Pi extension modules loaded from the Gentic suite." },
  { id: "skill", directory: "skills", description: "Pi skills exposed by the Gentic suite." },
  { id: "prompt-template", directory: "prompts", description: "Prompt templates exposed by the Gentic suite." },
  { id: "theme", directory: "themes", description: "Theme JSON files exposed by the Gentic suite." },
  { id: "context", description: "Context discovery, transformation, pruning, and injection surfaces." },
  { id: "flag", description: "CLI flag registration and handling." },
  { id: "command", directory: "extensions", description: "Slash command extensions." },
  { id: "shortcut", directory: "extensions", description: "Keyboard shortcut extensions." },
  { id: "tool", directory: "extensions", description: "Custom LLM-callable tools." },
  { id: "event", directory: "extensions", description: "Lifecycle and agent event handlers." },
  { id: "event-bus", description: "Cross-extension event coordination patterns." },
  { id: "session-state", description: "Session persistence via custom entries and session metadata." },
  { id: "session-labels", description: "Session entry labels and navigation markers." },
  { id: "tool-control", description: "Tool activation, policy, interception, and result mutation." },
  { id: "model-control", description: "Model selection and thinking-level control." },
  { id: "provider", directory: "extensions", description: "Custom provider registration." },
  { id: "model", description: "Model catalog and metadata surfaces." },
  { id: "exec", description: "Shell/user-bash execution behavior." },
  { id: "message-injection", description: "Custom, steering, follow-up, and user message injection." },
  { id: "message-renderer", directory: "extensions", description: "Custom message renderers." },
  { id: "ui-component", directory: "extensions", description: "Custom TUI components and UI interactions." },
  { id: "sdk", description: "SDK integrations and programmatic pi usage." },
  { id: "rpc", description: "RPC/client integration surfaces." },
];
