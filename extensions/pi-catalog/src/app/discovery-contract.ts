export const DISCOVERY_COMMAND_NAME = "catalog" as const;
export const DISCOVERY_TOOL_NAME = "gentic_catalog" as const;
export const DISCOVERY_OPERATIONS = ["status", "search"] as const;

export type DiscoveryOperation = (typeof DISCOVERY_OPERATIONS)[number];

export const DISCOVERY_COMMAND_USAGE = "/catalog [status|search <term>]" as const;

export const DISCOVERY_COMMAND_COMPLETIONS = [
  {
    value: "status",
    label: "status",
    description: "Show registered command and tool status · /catalog status",
  },
  {
    value: "search",
    label: "search",
    description: "Search registered commands and tools · /catalog search <term>",
  },
] as const;

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
