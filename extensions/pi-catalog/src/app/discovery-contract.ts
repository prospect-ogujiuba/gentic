import {
  renderUsage,
  rootActionCompletions,
  type CommandActionSpec,
} from "../../../../src/command-guidance.ts";

export const DISCOVERY_COMMAND_NAME = "catalog" as const;
export const DISCOVERY_TOOL_NAME = "gentic_catalog" as const;
export const DISCOVERY_OPERATIONS = ["status", "search"] as const;

export type DiscoveryOperation = (typeof DISCOVERY_OPERATIONS)[number];

export const DISCOVERY_COMMAND_ACTIONS = [
  { action: "status", syntax: "/catalog status", description: "Show registered command and tool status" },
  { action: "search", syntax: "/catalog search <term>", description: "Search registered commands and tools" },
] as const satisfies readonly CommandActionSpec<DiscoveryOperation>[];

export const DISCOVERY_COMMAND_USAGE = renderUsage(DISCOVERY_COMMAND_ACTIONS);
export const DISCOVERY_COMMAND_COMPLETIONS = rootActionCompletions("", DISCOVERY_COMMAND_ACTIONS);

export const DISCOVERY_CONTRACT = {
  command: DISCOVERY_COMMAND_NAME,
  tool: DISCOVERY_TOOL_NAME,
  defaultOperation: "status",
  operations: DISCOVERY_OPERATIONS,
  runtimeSources: ["pi.getCommands()", "pi.getAllTools()", "sourceInfo"],
  proxiesCommands: false,
  readsGeneratedFixtures: false,
} as const satisfies {
  command: string;
  tool: string;
  defaultOperation: DiscoveryOperation;
  operations: readonly DiscoveryOperation[];
  runtimeSources: readonly string[];
  proxiesCommands: boolean;
  readsGeneratedFixtures: boolean;
};
