import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  PI_EXTENSION_EVENT_GROUPS,
  PI_EXTENSION_EVENTS,
  PI_PACKAGE_SURFACES,
  SCHEMA_VERSION,
  type PiPackageSurfaceDefinition,
} from "../../src/pi-contract.ts";

function toolNameFor(surface: PiPackageSurfaceDefinition): string {
  return `gentic_surface_${surface.id.replaceAll("-", "_")}`;
}

function surfaceText(surface: PiPackageSurfaceDefinition): string {
  return [
    `# ${surface.id}`,
    "",
    surface.description,
    "",
    `Runtime directory: ${surface.directory ?? "package manifest"}`,
    `Pi discovery: ${surface.discovery}`,
    "",
    "This is a first-class Gentic surface because Pi discovers it directly from package metadata.",
  ].join("\n");
}

export default function genticSurfaceCatalogTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gentic_surfaces",
    label: "Gentic Surfaces",
    description: "List Gentic's first-class Pi package resource surfaces.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ schemaVersion: SCHEMA_VERSION, surfaces: PI_PACKAGE_SURFACES }, null, 2),
          },
        ],
        details: { schemaVersion: SCHEMA_VERSION, count: PI_PACKAGE_SURFACES.length },
      };
    },
  });

  pi.registerTool({
    name: "gentic_pi_extension_events",
    label: "Pi Extension Events",
    description: "List Pi extension event constants tracked by Gentic.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { schemaVersion: SCHEMA_VERSION, events: PI_EXTENSION_EVENTS, groups: PI_EXTENSION_EVENT_GROUPS },
              null,
              2,
            ),
          },
        ],
        details: { schemaVersion: SCHEMA_VERSION, count: PI_EXTENSION_EVENTS.length },
      };
    },
  });

  for (const surface of PI_PACKAGE_SURFACES) {
    pi.registerTool({
      name: toolNameFor(surface),
      label: `Gentic Surface: ${surface.id}`,
      description: `Describe the first-class Gentic ${surface.id} surface.`,
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: surfaceText(surface) }],
          details: { schemaVersion: SCHEMA_VERSION, surface },
        };
      },
    });
  }
}
