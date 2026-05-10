import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SCHEMA_VERSION, SURFACES, type SurfaceDefinition } from "../../catalog/surfaces.ts";

function toolNameFor(surface: SurfaceDefinition): string {
  return `gentic_surface_${surface.id.replaceAll("-", "_")}`;
}

function surfaceText(surface: SurfaceDefinition): string {
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
            text: JSON.stringify({ schemaVersion: SCHEMA_VERSION, surfaces: SURFACES }, null, 2),
          },
        ],
        details: { schemaVersion: SCHEMA_VERSION, count: SURFACES.length },
      };
    },
  });

  for (const surface of SURFACES) {
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
