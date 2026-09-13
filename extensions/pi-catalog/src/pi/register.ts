import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  capabilitiesText,
  catalogText,
  eventsListText,
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_CONTRACT_SOURCE,
  PI_NATIVE_CAPABILITY_GROUPS,
  PI_PACKAGE_SURFACES,
  surfaceById,
  surfacesListText,
  surfaceText,
  type CatalogSection,
} from "../app/catalog.ts";
import { PI_EXTENSION_EVENTS, SCHEMA_VERSION, type PiNativeCapabilityGroup } from "../../../../src/pi-contract.ts";

const capabilityGroups = Object.keys(PI_NATIVE_CAPABILITY_GROUPS) as PiNativeCapabilityGroup[];
const catalogSections = ["summary", "surfaces", "events", ...capabilityGroups] as const;
const SECTION_DESCRIPTIONS: Record<string, string> = {
  summary: "Catalog version, source, and capability totals · /catalog summary",
  surfaces: "Inspect Pi package surfaces · /catalog surfaces [id]",
  events: "List extension lifecycle events · /catalog events",
  commands: "List native command capabilities · /catalog commands",
  tools: "List native tool capabilities · /catalog tools",
  shortcuts: "List native shortcut capabilities · /catalog shortcuts",
  flags: "List native CLI flag capabilities · /catalog flags",
  providers: "List provider capabilities · /catalog providers",
  renderers: "List custom renderer capabilities · /catalog renderers",
  "markdown-transformers": "List markdown transformer capabilities · /catalog markdown-transformers",
  "ui-surfaces": "List native UI surface capabilities · /catalog ui-surfaces",
};

function sectionText(section: CatalogSection, id?: string): string {
  if (section === "summary") return catalogText();
  if (section === "events") return eventsListText();
  if (section === "surfaces") {
    if (!id) return surfacesListText();
    const surface = surfaceById(id);
    return surface ? surfaceText(surface) : `Unknown surface: ${id}\n\n${surfacesListText()}`;
  }
  return capabilitiesText(section);
}

export function registerPiCatalog(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-catalog", `Pi ${PI_CONTRACT_SOURCE.version}; ${capabilityGroups.length} capability groups`);
  });

  pi.registerTool({
    name: "gentic_catalog",
    label: "Pi Native Catalog",
    description: "Inspect the version-stamped Pi package and native extension capability catalog.",
    promptSnippet: "Inspect Pi package surfaces or native extension capabilities.",
    parameters: Type.Object({
      section: Type.Optional(Type.Union(catalogSections.map((section) => Type.Literal(section)))),
      id: Type.Optional(Type.String({ description: "Package surface id when section is surfaces" })),
    }),
    async execute(_toolCallId, params) {
      const section = (params.section ?? "summary") as CatalogSection;
      return {
        content: [{ type: "text", text: sectionText(section, params.id) }],
        details: {
          [PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY]: SCHEMA_VERSION,
          source: PI_CONTRACT_SOURCE,
          surfaceCount: PI_PACKAGE_SURFACES.length,
          eventCount: PI_EXTENSION_EVENTS.length,
          capabilityGroupCount: capabilityGroups.length,
        },
      };
    },
  });

  pi.registerCommand("catalog", {
    description: "/catalog [summary|surfaces [id]|events|commands|tools|shortcuts|flags|providers|renderers|markdown-transformers|ui-surfaces] — inspect native Pi capabilities",
    getArgumentCompletions: (prefix) => {
      const [section = "", id = ""] = prefix.trimStart().split(/\s+/, 2);
      if (section === "surfaces" && prefix.includes(" ")) {
        return PI_PACKAGE_SURFACES.filter((surface) => surface.id.startsWith(id)).map((surface) => ({
          value: `surfaces ${surface.id}`,
          label: surface.id,
          description: surface.description,
        }));
      }
      return ["summary", "surfaces", "events", ...capabilityGroups]
        .filter((value) => value.startsWith(section))
        .map((value) => ({ value, label: value, description: SECTION_DESCRIPTIONS[value] ?? `Inspect ${value}` }));
    },
    handler: async (args, ctx) => {
      const [section = "summary", id] = args.trim().split(/\s+/).filter(Boolean);
      if (!catalogSections.includes(section as (typeof catalogSections)[number])) {
        ctx.ui.notify(`Unknown catalog section: ${section}\n\n${catalogText()}`, "warning");
        return;
      }
      const text = sectionText(section as CatalogSection, id);
      ctx.ui.notify(text, section === "surfaces" && id && !surfaceById(id) ? "warning" : "info");
    },
  });
}
