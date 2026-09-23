import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";

import { renderUsage, rootActionCompletions } from "../../../../src/command-guidance.ts";
import { packageSummary } from "../app/package-summary.ts";
import {
  DISCOVERY_COMMAND_ACTIONS,
  DISCOVERY_COMMAND_NAME,
  DISCOVERY_COMMAND_USAGE,
  DISCOVERY_OPERATIONS,
  DISCOVERY_TOOL_NAME,
  type DiscoveryOperation,
} from "../app/discovery-contract.ts";
import {
  discoveryMatchDetails,
  discoverySearchText,
  discoverySnapshot,
  discoveryStatusText,
  MAX_DISCOVERY_QUERY_LENGTH,
  searchDiscovery,
  type DiscoveryMatches,
} from "../app/runtime-discovery.ts";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const STATUS_KEY = "pi-catalog";

function runDiscovery(
  pi: ExtensionAPI,
  session: { packageSummary: string; cwd: string; resources: string },
  operation: DiscoveryOperation,
  query = "",
) {
  const snapshot = discoverySnapshot(pi);
  const matches: DiscoveryMatches = operation === "search"
    ? searchDiscovery(snapshot, query)
    : { commands: [], tools: [], truncated: { commands: false, tools: false } };
  const text = operation === "status"
    ? discoveryStatusText(snapshot, session)
    : discoverySearchText(matches);
  return { snapshot, matches, text };
}

function normalizeQuery(query: string | undefined): string {
  return (query ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function invalidQuery(query: string): string | undefined {
  if (!query) return renderUsage(DISCOVERY_COMMAND_ACTIONS, ["search"]);
  if (query.length > MAX_DISCOVERY_QUERY_LENGTH) {
    return `Search term must be ${MAX_DISCOVERY_QUERY_LENGTH} characters or fewer.`;
  }
  return undefined;
}

export function registerPiCatalog(pi: ExtensionAPI): void {
  const session = { packageSummary: packageSummary(ROOT), cwd: "", resources: "unknown" };
  pi.on("session_start", (event, ctx) => {
    session.cwd = ctx.cwd;
    session.resources = event.reason;
    ctx.ui.setStatus(STATUS_KEY, "Gentic catalog");
  });

  pi.on("resources_discover", (event) => {
    session.resources = event.reason;
  });

  pi.registerTool({
    name: DISCOVERY_TOOL_NAME,
    label: "Gentic Catalog",
    description: "Show runtime command/tool status or search their native metadata.",
    promptSnippet: "Use gentic_catalog to inspect or search registered commands and tools.",
    parameters: Type.Object({
      operation: Type.Optional(StringEnum(DISCOVERY_OPERATIONS)),
      query: Type.Optional(Type.String({
        description: `Search term, at most ${MAX_DISCOVERY_QUERY_LENGTH} characters, when operation is search`,
        maxLength: MAX_DISCOVERY_QUERY_LENGTH,
      })),
    }),
    async execute(_toolCallId, params) {
      const operation = (params.operation ?? "status") as DiscoveryOperation;
      const query = normalizeQuery(params.query);
      const queryError = operation === "search" ? invalidQuery(query) : undefined;
      if (queryError) {
        return {
          content: [{ type: "text", text: queryError }],
          details: { commandCount: 0, toolCount: 0, matches: { commands: [], tools: [] }, truncated: { commands: false, tools: false } },
        };
      }
      const { snapshot, matches, text } = runDiscovery(pi, session, operation, query);
      const output = operation === "search" && !text ? `No commands or tools matched: ${query}` : text;
      return {
        content: [{ type: "text", text: output }],
        details: {
          commandCount: snapshot.commands.length,
          toolCount: snapshot.tools.length,
          matches: discoveryMatchDetails(matches),
          truncated: matches.truncated,
        },
      };
    },
  });

  pi.registerCommand(DISCOVERY_COMMAND_NAME, {
    description: `${DISCOVERY_COMMAND_USAGE} — inspect registered commands and tools`,
    getArgumentCompletions: (prefix) => rootActionCompletions(prefix, DISCOVERY_COMMAND_ACTIONS),
    handler: async (args, ctx) => {
      const [rawOperation = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!DISCOVERY_OPERATIONS.includes(rawOperation as DiscoveryOperation)) {
        ctx.ui.notify(`Unknown catalog operation: ${rawOperation}\n\n${renderUsage(DISCOVERY_COMMAND_ACTIONS)}`, "warning");
        return;
      }
      const operation = rawOperation as DiscoveryOperation;
      const query = normalizeQuery(rest.join(" "));
      const queryError = operation === "search" ? invalidQuery(query) : undefined;
      if (queryError) {
        ctx.ui.notify(queryError, "warning");
        return;
      }
      const { text } = runDiscovery(pi, session, operation, query);
      if (operation === "search" && !text) {
        ctx.ui.notify(`No commands or tools matched: ${query}`, "warning");
        return;
      }
      ctx.ui.notify(text, "info");
    },
  });
}
