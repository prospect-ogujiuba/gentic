import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiCommandModule } from "../types.ts";

type ScaffoldKind = "extension" | "command" | "skill" | "prompt" | "primitive";
type ScaffoldVariant = "simple" | "layered" | "directory";

type TemplateSpec = {
  template: string;
  target: string;
  description: string;
};

export type ScaffoldPreviewFile = TemplateSpec & {
  renderedContent: string;
  summary: string;
};

export type ScaffoldPreview = {
  kind: ScaffoldKind;
  name: string;
  variant?: ScaffoldVariant;
  files: ScaffoldPreviewFile[];
};

type ParseResult =
  | { ok: true; kind: ScaffoldKind; name: string; variant?: ScaffoldVariant }
  | { ok: false; message: string };

const templateRoot = fileURLToPath(new URL("../../pi-catalog/templates/", import.meta.url));
const validKinds = ["extension", "command", "skill", "prompt", "primitive"] as const;
const usage = [
  "Usage:",
  "  /scaffold extension <name> --simple --dry-run",
  "  /scaffold extension <name> --layered --dry-run",
  "  /scaffold command <name> --dry-run",
  "  /scaffold skill <name> --simple --dry-run",
  "  /scaffold skill <name> --directory --dry-run",
  "  /scaffold prompt <name> --dry-run",
  "  /scaffold primitive <name> --dry-run",
].join("\n");

function toCamelName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function toPascalName(name: string): string {
  const camelName = toCamelName(name);
  return `${camelName.slice(0, 1).toUpperCase()}${camelName.slice(1)}`;
}

function toTitle(name: string): string {
  return name
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function validateName(name: string): string | undefined {
  if (!name) return "Missing scaffold name.";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return `Invalid name: ${name}. Use kebab-case letters, numbers, and single hyphen-separated words.`;
  }
  if (name.includes("--")) return `Invalid name: ${name}. Collapse repeated hyphens.`;
  return undefined;
}

function assertSafeTarget(target: string): void {
  if (target.startsWith("/") || target.split("/").includes("..")) {
    throw new Error(`Unsafe scaffold target path: ${target}`);
  }
}

function parseScaffoldArgs(args: string): ParseResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [kindToken, name, ...flags] = tokens;

  if (!kindToken) return { ok: false, message: `${usage}\n\nAdd --dry-run; write mode is not available yet.` };
  if (!validKinds.includes(kindToken as ScaffoldKind)) {
    return { ok: false, message: `Unknown scaffold kind: ${kindToken}.\n\n${usage}` };
  }

  const nameError = validateName(name);
  if (nameError) return { ok: false, message: `${nameError}\n\n${usage}` };
  if (!flags.includes("--dry-run")) {
    return { ok: false, message: "Only dry-run scaffolds are supported in this phase. Add --dry-run; no files will be written." };
  }

  const variantFlags = flags.filter((flag) => ["--simple", "--layered", "--directory"].includes(flag));
  const unknownFlags = flags.filter((flag) => !["--dry-run", "--simple", "--layered", "--directory"].includes(flag));
  if (unknownFlags.length > 0) return { ok: false, message: `Unknown scaffold flag(s): ${unknownFlags.join(", ")}.\n\n${usage}` };
  if (variantFlags.length > 1) return { ok: false, message: `Choose one scaffold variant: ${variantFlags.join(", ")}.` };

  const kind = kindToken as ScaffoldKind;
  const variant = variantFlags[0]?.slice(2) as ScaffoldVariant | undefined;

  if (kind === "extension" && !["simple", "layered"].includes(variant ?? "")) {
    return { ok: false, message: "Extension scaffolds require --simple or --layered." };
  }
  if (kind === "skill" && !["simple", "directory"].includes(variant ?? "")) {
    return { ok: false, message: "Skill scaffolds require --simple or --directory." };
  }
  if (!["extension", "skill"].includes(kind) && variant) {
    return { ok: false, message: `${kind} scaffolds do not support --${variant}.` };
  }

  return { ok: true, kind, name, variant };
}

function specsFor(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant): TemplateSpec[] {
  if (kind === "extension") {
    const templateDir = variant === "layered" ? "extension-layered" : "extension-simple";
    return [
      { template: `${templateDir}/README.template.md`, target: `extensions/${name}/README.md`, description: `${variant} extension README` },
      { template: `${templateDir}/index.template.ts`, target: `extensions/${name}/index.ts`, description: `${variant} extension entrypoint` },
      { template: `${templateDir}/extension.anatomy.template.json`, target: `extensions/${name}/extension.anatomy.json`, description: `${variant} extension anatomy declaration` },
    ];
  }
  if (kind === "command") {
    return [
      { template: "command/command.template.ts", target: `extensions/pi-commands/commands/${name}.ts`, description: "slash command module" },
      { template: "command/README.md", target: "extensions/pi-commands/commands/index.ts", description: "registry update: import and add command module" },
    ];
  }
  if (kind === "skill") {
    const templateDir = variant === "directory" ? "skill-directory" : "skill-simple";
    return [
      { template: `${templateDir}/SKILL.template.md`, target: `extensions/pi-skills/skills/${name}/SKILL.md`, description: `${variant} skill definition` },
    ];
  }
  if (kind === "prompt") {
    return [
      { template: "prompt-simple/prompt.template.md", target: `extensions/pi-prompts/prompts/${name}.md`, description: "prompt template" },
    ];
  }
  return [
    { template: "primitive/index.template.ts", target: `extensions/pi-primitives/primitives/${name}/index.ts`, description: "primitive entrypoint" },
    { template: "primitive/supporting-file.template.md", target: `extensions/pi-primitives/primitives/${name}/supporting-file.md`, description: "primitive supporting context" },
    { template: "primitive/triggers.template.json", target: `extensions/pi-primitives/primitives/${name}/triggers.json`, description: "primitive triggers" },
  ];
}

function renderTemplate(template: string, name: string, kind: ScaffoldKind): string {
  const camelName = toCamelName(name);
  const values: Record<string, string> = {
    kebabName: name,
    camelName,
    pascalName: toPascalName(name),
    commandName: name,
    skillName: name,
    skillTitle: toTitle(name),
    promptName: name,
    primitiveName: name,
    ownerExtension: kind === "prompt" ? "pi-prompts" : "pi-skills",
    description: `TODO: describe ${kind} ${name}`,
    registeredSurfaces: "TODO: list commands/tools/resources",
    eventNames: "none yet",
    stateAndConfig: "none yet",
    verificationCommand: "npm test",
    boundaries: "TODO: list non-goals",
    statusText: `${name} ready`,
    argumentHint: "<args>",
    promptTask: `TODO: define the ${name} prompt task.`,
    firstArgumentDescription: "primary input",
    allArgumentsDescription: "all prompt arguments",
    successCriterion: "TODO: define success",
    activationCondition: `the ${name} workflow is requested`,
    inputDescription: "task input",
    stepOne: "Inspect the request.",
    stepTwo: "Do the smallest useful work.",
    stepThree: "Report changed paths.",
    verificationStep: "Run the relevant targeted check.",
    supportingFileName: "supporting-file.md",
    triggerPhrase: name,
    pathPattern: `**/${name}/**`,
  };

  return template.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? `{{${key}}}`);
}

function summarizeRenderedContent(renderedContent: string): string {
  const firstMeaningfulLine = renderedContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && line !== "---" && !line.startsWith("import type"));
  return firstMeaningfulLine?.slice(0, 96) || "rendered template";
}

export function createScaffoldPreview(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant): ScaffoldPreview {
  const files = specsFor(kind, name, variant).map((spec) => {
    assertSafeTarget(spec.target);
    const templatePath = `${templateRoot}${spec.template}`;
    const template = readFileSync(templatePath, "utf8");
    const renderedContent = renderTemplate(template, name, kind);
    return {
      ...spec,
      template: relative(templateRoot, templatePath),
      renderedContent,
      summary: summarizeRenderedContent(renderedContent),
    };
  });

  return { kind, name, variant, files };
}

export function formatScaffoldPreview(preview: ScaffoldPreview): string {
  const heading = [preview.kind, preview.name, preview.variant].filter(Boolean).join(" ");
  return [
    `Dry-run scaffold: ${heading}`,
    "No files written.",
    ...preview.files.map((file) => `- ${file.target} — ${file.description}; ${file.summary}`),
  ].join("\n");
}

export const scaffoldCommand: PiCommandModule = {
  name: "scaffold",
  register(pi: ExtensionAPI): void {
    pi.registerCommand("scaffold", {
      description: "Preview Gentic package resource scaffolds without writing files",
      getArgumentCompletions: (prefix) =>
        ["extension", "command", "skill", "prompt", "primitive", "--simple", "--layered", "--directory", "--dry-run"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const parsed = parseScaffoldArgs(args);
        if (!parsed.ok) {
          ctx.ui.notify(parsed.message, "warning");
          return;
        }

        const preview = createScaffoldPreview(parsed.kind, parsed.name, parsed.variant);
        ctx.ui.notify(formatScaffoldPreview(preview), "info");
      },
    });
  },
};
