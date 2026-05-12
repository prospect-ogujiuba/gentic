import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { commandOwners, extensionCommands, findCommands, formatCommands } from "./src/command-catalog.ts";
import { packageSummary } from "./src/package-summary.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const STATUS_KEY = "gentic";

let lastSession = { startedAt: 0, cwd: "", resources: "unknown" };

function extensionCommandCatalog(pi: ExtensionAPI) {
  return extensionCommands(pi.getCommands());
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
        details: { commandCount: extensionCommandCatalog(pi).length, session: lastSession },
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
