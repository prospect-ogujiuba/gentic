import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RuntimeCommand = ReturnType<ExtensionAPI["getCommands"]>[number];
export type RuntimeTool = ReturnType<ExtensionAPI["getAllTools"]>[number];

export type DiscoverySnapshot = {
  commands: RuntimeCommand[];
  tools: RuntimeTool[];
};

export type DiscoveryMatches = DiscoverySnapshot & {
  truncated: { commands: boolean; tools: boolean };
};

export type DiscoveryMatchMetadata = {
  name: string;
  description?: string;
  sourceInfo: {
    path: string;
    source: string;
    scope: string;
    origin: string;
    baseDir?: string;
  };
};

// These presentation limits keep command output and persisted tool details small even
// when another extension supplies unusually large metadata. Native totals stay exact.
export const MAX_DISCOVERY_QUERY_LENGTH = 200;
export const MAX_DISCOVERY_MATCHES_PER_KIND = 25;
export const MAX_DISCOVERY_OWNERS = 50;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_PROVENANCE_LENGTH = 512;

export function discoverySnapshot(pi: Pick<ExtensionAPI, "getCommands" | "getAllTools">): DiscoverySnapshot {
  const byBoundedName = (a: RuntimeCommand | RuntimeTool, b: RuntimeCommand | RuntimeTool) =>
    clip(a.name, MAX_NAME_LENGTH).localeCompare(clip(b.name, MAX_NAME_LENGTH));
  return {
    commands: [...pi.getCommands()].sort(byBoundedName),
    tools: [...pi.getAllTools()].sort(byBoundedName),
  };
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function owner(entry: RuntimeCommand | RuntimeTool): string {
  return entry.sourceInfo?.source?.trim() || "unknown";
}

function owners(entries: readonly (RuntimeCommand | RuntimeTool)[]): string {
  const values = [...new Set(entries.map((entry) => clip(owner(entry), MAX_NAME_LENGTH) || "unknown"))].sort();
  const shown = values.slice(0, MAX_DISCOVERY_OWNERS);
  if (values.length > shown.length) shown.push(`… (+${values.length - shown.length} more)`);
  return shown.join(", ") || "none";
}

function searchableText(entry: RuntimeCommand | RuntimeTool): string {
  return [
    clip(entry.name, MAX_NAME_LENGTH),
    clip(entry.description ?? "", MAX_DESCRIPTION_LENGTH),
    ...Object.values(entry.sourceInfo ?? {}).map((value) => clip(value ?? "", MAX_PROVENANCE_LENGTH)),
  ].join(" ").toLowerCase();
}

export function searchDiscovery(snapshot: DiscoverySnapshot, query: string): DiscoveryMatches {
  const term = query.trim().toLowerCase();
  const commands = snapshot.commands.filter((command) => searchableText(command).includes(term));
  const tools = snapshot.tools.filter((tool) => searchableText(tool).includes(term));
  return {
    commands: commands.slice(0, MAX_DISCOVERY_MATCHES_PER_KIND),
    tools: tools.slice(0, MAX_DISCOVERY_MATCHES_PER_KIND),
    truncated: {
      commands: commands.length > MAX_DISCOVERY_MATCHES_PER_KIND,
      tools: tools.length > MAX_DISCOVERY_MATCHES_PER_KIND,
    },
  };
}

export function discoveryMatchDetails(matches: DiscoveryMatches): {
  commands: DiscoveryMatchMetadata[];
  tools: DiscoveryMatchMetadata[];
} {
  const project = (entry: RuntimeCommand | RuntimeTool): DiscoveryMatchMetadata => ({
    name: clip(entry.name, MAX_NAME_LENGTH),
    ...(entry.description ? { description: clip(entry.description, MAX_DESCRIPTION_LENGTH) } : {}),
    sourceInfo: {
      path: clip(entry.sourceInfo?.path ?? "", MAX_PROVENANCE_LENGTH),
      source: clip(entry.sourceInfo?.source ?? "unknown", MAX_NAME_LENGTH),
      scope: clip(entry.sourceInfo?.scope ?? "unknown", MAX_NAME_LENGTH),
      origin: clip(entry.sourceInfo?.origin ?? "unknown", MAX_NAME_LENGTH),
      ...(entry.sourceInfo?.baseDir ? { baseDir: clip(entry.sourceInfo.baseDir, MAX_PROVENANCE_LENGTH) } : {}),
    },
  });
  return { commands: matches.commands.map(project), tools: matches.tools.map(project) };
}

export function discoveryStatusText(
  snapshot: DiscoverySnapshot,
  session: { packageSummary: string; cwd: string; resources: string },
): string {
  return [
    session.packageSummary,
    `cwd: ${clip(session.cwd || "unknown", MAX_PROVENANCE_LENGTH)}`,
    `resources: ${clip(session.resources || "unknown", MAX_NAME_LENGTH)}`,
    "",
    `Commands (${snapshot.commands.length})`,
    `Owners: ${owners(snapshot.commands)}`,
    "",
    `Tools (${snapshot.tools.length})`,
    `Owners: ${owners(snapshot.tools)}`,
  ].join("\n");
}

export function discoverySearchText(matches: DiscoveryMatches): string {
  const sections: string[] = [];
  if (matches.commands.length) {
    sections.push([
      "Commands",
      ...matches.commands.map((command) => `/${clip(command.name, MAX_NAME_LENGTH)} - ${clip(command.description || "no description", MAX_DESCRIPTION_LENGTH)} (${clip(owner(command), MAX_NAME_LENGTH)})`),
      ...(matches.truncated.commands ? [`… limited to ${MAX_DISCOVERY_MATCHES_PER_KIND} command matches`] : []),
    ].join("\n"));
  }
  if (matches.tools.length) {
    sections.push([
      "Tools",
      ...matches.tools.map((tool) => `${clip(tool.name, MAX_NAME_LENGTH)} - ${clip(tool.description || "no description", MAX_DESCRIPTION_LENGTH)} (${clip(owner(tool), MAX_NAME_LENGTH)})`),
      ...(matches.truncated.tools ? [`… limited to ${MAX_DISCOVERY_MATCHES_PER_KIND} tool matches`] : []),
    ].join("\n"));
  }
  return sections.join("\n\n");
}
