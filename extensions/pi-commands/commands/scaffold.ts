import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiCommandModule } from "../types.ts";

type ScaffoldKind = "extension" | "command" | "skill" | "prompt" | "primitive";
type ScaffoldVariant = "simple" | "layered" | "directory";
type ScaffoldMode = "dry-run" | "apply";

type TemplateSpec = {
  template: string;
  target: string;
  description: string;
  operation?: "create" | "update-command-index";
};

export type ScaffoldPreviewFile = TemplateSpec & {
  renderedContent: string;
  summary: string;
};

export type ScaffoldPreview = {
  kind: ScaffoldKind;
  name: string;
  mode: ScaffoldMode;
  variant?: ScaffoldVariant;
  files: ScaffoldPreviewFile[];
};

export type ScaffoldApplyResult = ScaffoldPreview & {
  createdPaths: string[];
  updatedPaths: string[];
};

type ParseResult =
  | { ok: true; kind: ScaffoldKind; name: string; mode: ScaffoldMode; variant?: ScaffoldVariant }
  | { ok: false; message: string };

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const templateRoot = fileURLToPath(new URL("../../pi-catalog/templates/", import.meta.url));
const validKinds = ["extension", "command", "skill", "prompt", "primitive"] as const;
const usage = [
  "Usage:",
  "  /scaffold extension <name> --simple [--dry-run|--apply]",
  "  /scaffold extension <name> --layered [--dry-run|--apply]",
  "  /scaffold command <name> [--dry-run|--apply]",
  "  /scaffold skill <name> --simple [--dry-run|--apply]",
  "  /scaffold skill <name> --directory [--dry-run|--apply]",
  "  /scaffold prompt <name> [--dry-run|--apply]",
  "  /scaffold primitive <name> [--dry-run|--apply]",
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

  if (!kindToken) return { ok: false, message: `${usage}\n\nAdd --apply to write files; without --apply scaffolds stay in safe preview mode.` };
  if (!validKinds.includes(kindToken as ScaffoldKind)) {
    return { ok: false, message: `Unknown scaffold kind: ${kindToken}.\n\n${usage}` };
  }

  const nameError = validateName(name);
  if (nameError) return { ok: false, message: `${nameError}\n\n${usage}` };
  const modeFlags = flags.filter((flag) => ["--dry-run", "--apply"].includes(flag));
  const variantFlags = flags.filter((flag) => ["--simple", "--layered", "--directory"].includes(flag));
  const unknownFlags = flags.filter((flag) => !["--dry-run", "--apply", "--simple", "--layered", "--directory"].includes(flag));
  if (unknownFlags.length > 0) return { ok: false, message: `Unknown scaffold flag(s): ${unknownFlags.join(", ")}.\n\n${usage}` };
  if (modeFlags.length > 1) return { ok: false, message: "Choose one scaffold mode: --dry-run or --apply." };
  if (variantFlags.length > 1) return { ok: false, message: `Choose one scaffold variant: ${variantFlags.join(", ")}.` };

  const kind = kindToken as ScaffoldKind;
  const mode: ScaffoldMode = modeFlags[0] === "--apply" ? "apply" : "dry-run";
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

  return { ok: true, kind, name, mode, variant };
}

function specsFor(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant): TemplateSpec[] {
  if (kind === "extension") {
    const templateDir = variant === "layered" ? "extension-layered" : "extension-simple";
    return [
      { template: `${templateDir}/README.template.md`, target: `extensions/${name}/README.md`, description: `${variant} extension README` },
      { template: `${templateDir}/index.template.ts`, target: `extensions/${name}/index.ts`, description: `${variant} extension entrypoint` },
    ];
  }
  if (kind === "command") {
    return [
      { template: "command/command.template.ts", target: `extensions/pi-commands/commands/${name}.ts`, description: "slash command module" },
      {
        template: "command/README.md",
        target: "extensions/pi-commands/commands/index.ts",
        description: "registry update: import and add command module",
        operation: "update-command-index",
      },
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

export function createScaffoldPreview(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant, mode: ScaffoldMode = "dry-run"): ScaffoldPreview {
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

  return { kind, name, mode, variant, files };
}

function absoluteTarget(target: string): string {
  assertSafeTarget(target);
  return join(projectRoot, target);
}

function commandExportName(name: string): string {
  return `${toCamelName(name)}Command`;
}

function renderCommandIndexUpdate(name: string): { target: string; content: string } {
  const target = "extensions/pi-commands/commands/index.ts";
  const path = absoluteTarget(target);
  if (!existsSync(path)) {
    throw new Error(`Cannot update command barrel automatically: ${target} does not exist. Manually export ${commandExportName(name)}.`);
  }

  const original = readFileSync(path, "utf8");
  const exportName = commandExportName(name);
  const importLine = `import { ${exportName} } from "./${name}.ts";`;
  if (original.includes(importLine) || new RegExp(`\\b${exportName}\\b`).test(original)) {
    throw new Error(`Command barrel already references ${exportName}; refusing to duplicate ${target}.`);
  }

  const importMatches = [...original.matchAll(/^import \{ \w+Command \} from "\.\/[^\"]+\.ts";$/gm)].map((match) => match[0]);
  if (importMatches.length === 0) {
    throw new Error(`Cannot update command barrel automatically: no command import block found in ${target}. Manually add ${importLine}.`);
  }
  const sortedImports = [...importMatches, importLine].sort((a, b) => a.localeCompare(b)).join("\n");
  let content = original.replace(importMatches.join("\n"), sortedImports);

  const arrayMatch = content.match(/export const commands: PiCommandModule\[] = \[([^\]]*)\];/s);
  if (!arrayMatch) {
    throw new Error(`Cannot update command barrel automatically: commands array not found in ${target}. Manually add ${exportName}.`);
  }
  const commandNames = arrayMatch[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sortedCommandNames = [...commandNames, exportName].sort((a, b) => a.localeCompare(b));
  content = content.replace(arrayMatch[0], `export const commands: PiCommandModule[] = [${sortedCommandNames.join(", ")}];`);
  return { target, content };
}

function preflightApply(preview: ScaffoldPreview): Map<string, string> {
  const updates = new Map<string, string>();
  for (const file of preview.files) {
    if (file.operation === "update-command-index") {
      const update = renderCommandIndexUpdate(preview.name);
      updates.set(update.target, update.content);
      continue;
    }
    if (existsSync(absoluteTarget(file.target))) {
      throw new Error(`Refusing to overwrite existing scaffold target: ${file.target}`);
    }
  }
  return updates;
}

export function applyScaffold(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant): ScaffoldApplyResult {
  const preview = createScaffoldPreview(kind, name, variant, "apply");
  const updates = preflightApply(preview);
  const createdPaths: string[] = [];
  const updatedPaths: string[] = [];

  for (const file of preview.files) {
    if (file.operation === "update-command-index") continue;
    const target = absoluteTarget(file.target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.renderedContent, { flag: "wx" });
    createdPaths.push(file.target);
  }
  for (const [target, content] of updates) {
    writeFileSync(absoluteTarget(target), content);
    updatedPaths.push(target);
  }

  return { ...preview, createdPaths, updatedPaths };
}

export function formatScaffoldPreview(preview: ScaffoldPreview): string {
  const heading = [preview.kind, preview.name, preview.variant].filter(Boolean).join(" ");
  return [
    `Dry-run scaffold: ${heading}`,
    "No files written.",
    ...preview.files.map((file) => `- ${file.target} — ${file.description}; ${file.summary}`),
  ].join("\n");
}

export function formatScaffoldApplyResult(result: ScaffoldApplyResult): string {
  const heading = [result.kind, result.name, result.variant].filter(Boolean).join(" ");
  const lines = [`Applied scaffold: ${heading}`];
  if (result.createdPaths.length) lines.push(...result.createdPaths.map((path) => `- created ${path}`));
  if (result.updatedPaths.length) lines.push(...result.updatedPaths.map((path) => `- updated ${path}`));
  return lines.join("\n");
}

export const scaffoldCommand: PiCommandModule = {
  name: "scaffold",
  register(pi: ExtensionAPI): void {
    pi.registerCommand("scaffold", {
      description: "Preview or apply Gentic package resource scaffolds",
      getArgumentCompletions: (prefix) =>
        ["extension", "command", "skill", "prompt", "primitive", "--simple", "--layered", "--directory", "--dry-run", "--apply"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const parsed = parseScaffoldArgs(args);
        if (!parsed.ok) {
          ctx.ui.notify(parsed.message, "warning");
          return;
        }

        try {
          if (parsed.mode === "apply") {
            const result = applyScaffold(parsed.kind, parsed.name, parsed.variant);
            ctx.ui.notify(formatScaffoldApplyResult(result), "info");
            return;
          }

          const preview = createScaffoldPreview(parsed.kind, parsed.name, parsed.variant);
          ctx.ui.notify(formatScaffoldPreview(preview), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
      },
    });
  },
};
