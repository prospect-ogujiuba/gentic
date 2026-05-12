export type CommandCatalogEntry = {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string };
};

export function extensionCommands<T extends CommandCatalogEntry>(commands: readonly T[]): T[] {
  return commands.filter((command) => command.source === "extension");
}

export function commandOwner(command: CommandCatalogEntry): string {
  return command.sourceInfo?.path?.split("/extensions/")[1]?.split("/")[0]?.replace(/\.ts$/, "") || "extension";
}

export function groupCommandsByOwner<T extends CommandCatalogEntry>(commands: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const command of commands) {
    const owner = commandOwner(command);
    groups.set(owner, [...(groups.get(owner) || []), command]);
  }
  return groups;
}

export function commandOwners(commands: readonly CommandCatalogEntry[]): string[] {
  return [...groupCommandsByOwner(commands).keys()].sort();
}

export function formatCommands(commands: readonly CommandCatalogEntry[]): string {
  const groups = groupCommandsByOwner(commands);
  if (groups.size === 0) return "No extension commands registered.";
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, items]) => [`${owner}:`, ...items.map((command) => `  /${command.name} - ${command.description || "no description"}`)].join("\n"))
    .join("\n\n");
}

export function findCommands<T extends CommandCatalogEntry>(commands: readonly T[], term: string): T[] {
  const normalizedTerm = term.toLowerCase();
  return commands.filter((command) =>
    [command.name, command.description || "", command.sourceInfo?.path || ""].join(" ").toLowerCase().includes(normalizedTerm),
  );
}
