import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { commandOwners, extensionCommands, findCommands, formatCommands } from "../command-catalog.ts";
import { packageSummary } from "../package-summary.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
const STATUS_KEY = "gentic";

const GENTIC_COMMAND_COMPLETIONS = [
  { value: "status", label: "status", description: "Show suite/resource status · /gentic status" },
  { value: "commands", label: "commands", description: "List extension-owned runtime commands · /gentic commands" },
  { value: "find", label: "find", description: "Search command names and descriptions · /gentic find <term>" },
  { value: "run", label: "run", description: "Forward an extension command · /gentic run <command> [args]" },
  { value: "reload", label: "reload", description: "Reload extensions, skills, prompts, themes, and settings · /gentic reload" },
] as const;

let lastSession = { startedAt: 0, cwd: "", resources: "unknown" };

function extensionCommandCatalog(pi: ExtensionAPI) {
  return extensionCommands(pi.getCommands());
}

export function completeGenticArgument(pi: ExtensionAPI, prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const runMatch = normalized.match(/^run\s+(\S*)$/);
  if (runMatch) {
    const query = runMatch[1] ?? "";
    return extensionCommandCatalog(pi)
      .filter((command) => command.name !== "gentic" && command.name.startsWith(query))
      .map((command) => ({
        value: `run ${command.name}`,
        label: command.name,
        description: command.description || `Run /${command.name}`,
      }));
  }
  if (/^(?:find|run)\s+\S+/.test(normalized) || /\s/.test(normalized)) return [];
  return GENTIC_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized)).map((item) => ({ ...item }));
}

function statusText(pi: ExtensionAPI): string {
  const commands = extensionCommandCatalog(pi);
  const owners = commandOwners(commands);
  return [
    packageSummary(ROOT),
    "",
    `cwd: ${lastSession.cwd || "unknown"}`,
    `resources: ${lastSession.resources}`,
    `extension command owners: ${owners.length ? owners.join(", ") : "none"}`,
    `extension commands: ${commands.length}`,
    "",
    "Gentic is the suite orchestrator: it maps and routes to extensions, but does not host their features.",
  ].join("\n");
}

export function registerGentic(pi: ExtensionAPI): void {
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
        details: { commandCount: extensionCommandCatalog(pi).length, session: lastSession },
      };
    },
  });

  pi.registerCommand("gentic", {
    description: "/gentic [status|commands|find <term>|run <extension-command> [args]|reload] — inspect and route the Gentic suite",
    getArgumentCompletions: (prefix) => completeGenticArgument(pi, prefix),
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "reload") {
        await ctx.reload();
        return;
      }

      if (subcommand === "commands") {
        ctx.ui.notify(formatCommands(extensionCommandCatalog(pi)), "info");
        return;
      }

      if (subcommand === "find") {
        const term = rest.join(" ").toLowerCase();
        const matches = findCommands(extensionCommandCatalog(pi), term);
        ctx.ui.notify(matches.length ? formatCommands(matches) : `No extension command matched: ${term || "<empty>"}`, matches.length ? "info" : "warning");
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
