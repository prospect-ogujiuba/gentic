import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = { name?: string; version?: string; pi?: Record<string, string[]> };
type CommandInfo = ReturnType<ExtensionAPI["getCommands"]>[number];

const ROOT = new URL("../..", import.meta.url).pathname;
const STATUS_KEY = "gentic";

let lastSession = { startedAt: 0, cwd: "", resources: "unknown" };

function packageJson(): PackageJson {
  const path = join(ROOT, "package.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function packageSummary(): string {
  const pkg = packageJson();
  const resources = Object.entries(pkg.pi || {})
    .map(([key, values]) => `${key}: ${values.length}`)
    .join(" • ");
  return `${pkg.name || "gentic"}@${pkg.version || "unknown"}\n${resources || "no pi resources declared"}`;
}

function extensionCommands(pi: ExtensionAPI): CommandInfo[] {
  return pi.getCommands().filter((command) => command.source === "extension");
}

function commandGroups(commands: CommandInfo[]): Map<string, CommandInfo[]> {
  const groups = new Map<string, CommandInfo[]>();
  for (const command of commands) {
    const owner = command.sourceInfo?.path?.split("/extensions/")[1]?.split("/")[0]?.replace(/\.ts$/, "") || "extension";
    groups.set(owner, [...(groups.get(owner) || []), command]);
  }
  return groups;
}

function commandsText(commands: CommandInfo[]): string {
  const groups = commandGroups(commands);
  if (groups.size === 0) return "No extension commands registered.";
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, items]) => [`${owner}:`, ...items.map((command) => `  /${command.name} - ${command.description || "no description"}`)].join("\n"))
    .join("\n\n");
}

function statusText(pi: ExtensionAPI): string {
  const commands = extensionCommands(pi);
  const owners = [...commandGroups(commands).keys()].sort();
  return [
    packageSummary(),
    "",
    `cwd: ${lastSession.cwd || "unknown"}`,
    `resources: ${lastSession.resources}`,
    `extension command owners: ${owners.length ? owners.join(", ") : "none"}`,
    `extension commands: ${commands.length}`,
    "",
    "Gentic is the suite orchestrator: it maps and routes to extensions, but does not host their features.",
  ].join("\n");
}

export default function gentic(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    lastSession = { startedAt: Date.now(), cwd: ctx.cwd, resources: event.reason };
    ctx.ui.setStatus(STATUS_KEY, "gentic orchestrator");
  });

  pi.on("resources_discover", (event) => {
    lastSession.resources = event.reason;
  });

  pi.registerTool({
    name: "gentic_status",
    label: "Gentic Status",
    description: "Show Gentic suite orchestration status and available extension command owners.",
    promptSnippet: "Use gentic_status to inspect the Gentic suite and connected extension command owners.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: statusText(pi) }],
        details: { commandCount: extensionCommands(pi).length, session: lastSession },
      };
    },
  });

  pi.registerCommand("gentic", {
    description: "Gentic orchestrator: status, commands, find <term>, run <command>, reload",
    getArgumentCompletions: (prefix) =>
      ["status", "commands", "find", "run", "reload"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "reload") {
        await ctx.reload();
        return;
      }

      if (subcommand === "commands") {
        ctx.ui.notify(commandsText(extensionCommands(pi)), "info");
        return;
      }

      if (subcommand === "find") {
        const term = rest.join(" ").toLowerCase();
        const matches = extensionCommands(pi).filter((command) =>
          [command.name, command.description || "", command.sourceInfo?.path || ""].join(" ").toLowerCase().includes(term),
        );
        ctx.ui.notify(matches.length ? commandsText(matches) : `No extension command matched: ${term || "<empty>"}`, matches.length ? "info" : "warning");
        return;
      }

      if (subcommand === "run") {
        const command = rest.join(" ").trim();
        if (!command) {
          ctx.ui.notify("Usage: /gentic run <extension-command> [args]", "warning");
          return;
        }
        pi.sendUserMessage(command.startsWith("/") ? command : `/${command}`, { deliverAs: ctx.isIdle() ? undefined : "followUp" });
        return;
      }

      ctx.ui.notify(statusText(pi), "info");
    },
  });
}
