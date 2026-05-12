import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  catalogText,
  eventsListText,
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_PACKAGE_SURFACES,
  surfaceById,
  surfacesListText,
  surfaceText,
  toolNameFor,
} from "../app/catalog.ts";
import { PI_EXTENSION_EVENTS, SCHEMA_VERSION } from "../../../../src/pi-contract.ts";

export function registerPiCatalog(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-catalog", `catalog ${PI_PACKAGE_SURFACES.length} surfaces`);
  });
  pi.registerTool({
    name: "gentic_surfaces",
    label: "Pi Catalog Surfaces",
    description: "List Pi package resource surfaces tracked by pi-catalog.",
    promptSnippet: "List Pi package resource surfaces tracked by pi-catalog.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: surfacesListText(),
          },
        ],
        details: { [PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY]: SCHEMA_VERSION, count: PI_PACKAGE_SURFACES.length },
      };
    },
  });

  pi.registerTool({
    name: "gentic_pi_extension_events",
    label: "Pi Extension Events",
    description: "List Pi extension event constants tracked by Gentic.",
    promptSnippet: "List Pi extension event groups tracked by Gentic.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: eventsListText(),
          },
        ],
        details: { [PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY]: SCHEMA_VERSION, count: PI_EXTENSION_EVENTS.length },
      };
    },
  });

  for (const surface of PI_PACKAGE_SURFACES) {
    pi.registerTool({
      name: toolNameFor(surface),
      label: `Pi Catalog Surface: ${surface.id}`,
      description: `Describe the first-class ${surface.id} Pi package surface.`,
      promptSnippet: `Describe the ${surface.id} Pi package surface tracked by pi-catalog.`,
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: surfaceText(surface) }],
          details: { [PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY]: SCHEMA_VERSION, surface },
        };
      },
    });
  }

  pi.registerCommand("catalog", {
    description: "Pi catalog: surfaces, surface <id>, events",
    getArgumentCompletions: (prefix) =>
      ["surfaces", "surface", "events"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!subcommand || subcommand === "surfaces") {
        ctx.ui.notify(subcommand ? surfacesListText() : catalogText(), "info");
        return;
      }
      if (subcommand === "events") {
        ctx.ui.notify(eventsListText(), "info");
        return;
      }
      if (subcommand === "surface") {
        const id = rest.join(" ").trim();
        const surface = surfaceById(id);
        ctx.ui.notify(surface ? surfaceText(surface) : `Unknown surface: ${id || "<empty>"}\n\n${surfacesListText()}`, surface ? "info" : "warning");
        return;
      }
      ctx.ui.notify(`Unknown catalog command: ${subcommand}\n\n${catalogText()}`, "warning");
    },
  });

  pi.registerCommand("surfaces", {
    description: "Show first-class Pi package surfaces",
    handler: async (_args, ctx) => {
      ctx.ui.notify(surfacesListText(), "info");
    },
  });

  pi.registerCommand("surface", {
    description: "Describe one Pi package surface: package, extension, skill, prompt-template, theme",
    getArgumentCompletions: (prefix) =>
      PI_PACKAGE_SURFACES.filter((surface) => surface.id.startsWith(prefix)).map((surface) => ({
        value: surface.id,
        label: surface.id,
        description: surface.description,
      })),
    handler: async (args, ctx) => {
      const id = args.trim();
      const surface = surfaceById(id);
      ctx.ui.notify(surface ? surfaceText(surface) : `Unknown surface: ${id || "<empty>"}\n\n${surfacesListText()}`, surface ? "info" : "warning");
    },
  });

  pi.registerCommand("events", {
    description: "Show Pi extension events grouped by lifecycle area",
    handler: async (_args, ctx) => {
      ctx.ui.notify(eventsListText(), "info");
    },
  });
}
