import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiCommandModule } from "../types.ts";

type ScaffoldKind =
  | "extension"
  | "tool"
  | "command"
  | "event"
  | "shortcut"
  | "flag"
  | "provider"
  | "widget"
  | "footer"
  | "overlay"
  | "skill"
  | "prompt"
  | "theme"
  | "primitive";
type ScaffoldVariant = "minimal" | "simple" | "layered" | "directory";
type ScaffoldMode = "dry-run" | "apply";

type TemplateSpec = { template: string; target: string; description: string };

export type ScaffoldPreviewFile = TemplateSpec & { renderedContent: string; summary: string };
export type ScaffoldPreview = {
  kind: ScaffoldKind;
  name: string;
  mode: ScaffoldMode;
  variant?: ScaffoldVariant;
  projectRoot: string;
  files: ScaffoldPreviewFile[];
};
export type ScaffoldApplyResult = ScaffoldPreview & { createdPaths: string[]; updatedPaths: string[] };
export type ScaffoldOptions = { projectRoot?: string; failAtStep?: number };

type ParseResult =
  | { ok: true; kind: ScaffoldKind; name: string; mode: ScaffoldMode; variant?: ScaffoldVariant }
  | { ok: false; message: string };

const selfHostRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const templateRoot = fileURLToPath(new URL("../../pi-catalog/templates/", import.meta.url));
const validKinds = [
  "extension", "tool", "command", "event", "shortcut", "flag", "provider", "widget", "footer", "overlay", "skill", "prompt", "theme", "primitive",
] as const;
const extensionBackedKinds = new Set<ScaffoldKind>(["tool", "command", "event", "shortcut", "flag", "provider", "widget", "footer", "overlay"]);
const usage = [
  "Usage: /scaffold <kind> <name> [variant] [--dry-run|--apply]",
  "Kinds: extension, tool, command, event, shortcut, flag, provider, widget, footer, overlay, skill, prompt, theme, primitive",
  "Variants: extension --minimal|--layered; skill --simple|--directory",
  "Dry-run is the default. Apply targets the nearest package.json with a pi manifest.",
].join("\n");

function toCamelName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}
function toPascalName(name: string): string {
  const camelName = toCamelName(name);
  return `${camelName.slice(0, 1).toUpperCase()}${camelName.slice(1)}`;
}
function toTitle(name: string): string {
  return name.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}
function validateName(name: string): string | undefined {
  if (!name) return "Missing scaffold name.";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
    return `Invalid name: ${name}. Use kebab-case letters, numbers, and single hyphen-separated words.`;
  }
  return undefined;
}
function assertSafeTarget(target: string): void {
  if (target.startsWith("/") || target.split("/").includes("..")) throw new Error(`Unsafe scaffold target path: ${target}`);
}

function isPiProjectRoot(path: string): boolean {
  const manifest = join(path, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as { pi?: unknown };
    return typeof value.pi === "object" && value.pi !== null;
  } catch {
    return false;
  }
}

export function resolveScaffoldProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (isPiProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Refusing scaffold outside a Pi project: no package.json with a pi manifest above ${resolve(start)}.`);
}

function parseScaffoldArgs(args: string): ParseResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [kindToken, name, ...flags] = tokens;
  if (!kindToken) return { ok: false, message: usage };
  if (!validKinds.includes(kindToken as ScaffoldKind)) return { ok: false, message: `Unknown scaffold kind: ${kindToken}.\n\n${usage}` };
  const nameError = validateName(name);
  if (nameError) return { ok: false, message: `${nameError}\n\n${usage}` };
  const modeFlags = flags.filter((flag) => ["--dry-run", "--apply"].includes(flag));
  const variantFlags = flags.filter((flag) => ["--minimal", "--simple", "--layered", "--directory"].includes(flag));
  const unknownFlags = flags.filter((flag) => !["--dry-run", "--apply", "--minimal", "--simple", "--layered", "--directory"].includes(flag));
  if (unknownFlags.length) return { ok: false, message: `Unknown scaffold flag(s): ${unknownFlags.join(", ")}.\n\n${usage}` };
  if (modeFlags.length > 1) return { ok: false, message: "Choose one scaffold mode: --dry-run or --apply." };
  if (variantFlags.length > 1) return { ok: false, message: `Choose one scaffold variant: ${variantFlags.join(", ")}.` };

  const kind = kindToken as ScaffoldKind;
  const mode: ScaffoldMode = modeFlags[0] === "--apply" ? "apply" : "dry-run";
  let variant = variantFlags[0]?.slice(2) as ScaffoldVariant | undefined;
  if (kind === "extension") {
    if (variant === "simple") variant = "minimal";
    if (!variant) variant = "minimal";
    if (!["minimal", "layered"].includes(variant)) return { ok: false, message: "Extension scaffolds support --minimal or --layered." };
  } else if (kind === "skill") {
    if (!variant) variant = "simple";
    if (!["simple", "directory"].includes(variant)) return { ok: false, message: "Skill scaffolds support --simple or --directory." };
  } else if (variant) {
    return { ok: false, message: `${kind} scaffolds do not support --${variant}.` };
  }
  return { ok: true, kind, name, mode, variant };
}

function specsFor(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant): TemplateSpec[] {
  if (kind === "extension") {
    const templateDir = variant === "layered" ? "extension-layered" : "extension-simple";
    const files = [
      { template: `${templateDir}/README.template.md`, target: `extensions/${name}/README.md`, description: `${variant} extension README` },
      { template: `${templateDir}/index.template.ts`, target: `extensions/${name}/index.ts`, description: `${variant} extension entrypoint` },
    ];
    if (variant === "layered") files.push(
      { template: `${templateDir}/src/domain/types.template.ts`, target: `extensions/${name}/src/domain/types.ts`, description: "domain types" },
      { template: `${templateDir}/src/app/use-case.template.ts`, target: `extensions/${name}/src/app/use-case.ts`, description: "application use case" },
      { template: `${templateDir}/src/pi/register.template.ts`, target: `extensions/${name}/src/pi/register.ts`, description: "Pi adapter" },
      { template: `${templateDir}/src/ui/render.template.ts`, target: `extensions/${name}/src/ui/render.ts`, description: "UI renderer" },
    );
    return files;
  }
  if (extensionBackedKinds.has(kind)) return [
    { template: "native/README.template.md", target: `extensions/${name}/README.md`, description: `${kind} extension README` },
    { template: `${kind}/index.template.ts`, target: `extensions/${name}/index.ts`, description: `native ${kind} extension` },
  ];
  if (kind === "skill") {
    const templateDir = variant === "directory" ? "skill-directory" : "skill-simple";
    const files = [{ template: `${templateDir}/SKILL.template.md`, target: `skills/${name}/SKILL.md`, description: `${variant} skill definition` }];
    if (variant === "directory") files.push(
      { template: `${templateDir}/references/reference.template.md`, target: `skills/${name}/references/reference.md`, description: "skill reference" },
      { template: `${templateDir}/scripts/helper.template.sh`, target: `skills/${name}/scripts/helper.sh`, description: "skill helper" },
    );
    return files;
  }
  if (kind === "prompt") return [{ template: "prompt-simple/prompt.template.md", target: `prompts/${name}.md`, description: "prompt template" }];
  if (kind === "theme") return [{ template: "theme/theme.template.json", target: `themes/${name}.json`, description: "Pi theme" }];
  return [
    { template: "primitive/index.template.ts", target: `extensions/pi-primitives/primitives/${name}/index.ts`, description: "primitive entrypoint" },
    { template: "primitive/supporting-file.template.md", target: `extensions/pi-primitives/primitives/${name}/supporting-file.md`, description: "primitive supporting context" },
    { template: "primitive/triggers.template.json", target: `extensions/pi-primitives/primitives/${name}/triggers.json`, description: "primitive triggers" },
  ];
}

function renderTemplate(template: string, name: string, kind: ScaffoldKind): string {
  const camelName = toCamelName(name);
  const values: Record<string, string> = {
    kebabName: name, camelName, pascalName: toPascalName(name), commandName: name, kindName: kind,
    skillName: name, skillTitle: toTitle(name), promptName: name, primitiveName: name,
    description: `TODO: describe ${kind} ${name}`, registeredSurfaces: `native ${kind}`, eventNames: "none yet",
    stateAndConfig: "none yet", verificationCommand: "npm run typecheck && npm test", boundaries: "TODO: list non-goals",
    statusText: `${name} ready`, argumentHint: "<args>", promptTask: `TODO: define the ${name} prompt task.`,
    firstArgumentDescription: "primary input", allArgumentsDescription: "all prompt arguments", successCriterion: "TODO: define success",
    activationCondition: `the ${name} workflow is requested`, inputDescription: "task input", stepOne: "Inspect the request.",
    stepTwo: "Do the smallest useful work.", stepThree: "Report changed paths.", verificationStep: "Run the relevant targeted check.",
    supportingFileName: "supporting-file.md", triggerPhrase: name, pathPattern: `**/${name}/**`,
    enabledText: "enabled", disabledText: "disabled", statusPrefix: toTitle(name), referenceNote: "Add detailed reference material here.",
    helperOutput: `${name} helper ready`,
  };
  return template.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? `{{${key}}`);
}

function summarizeRenderedContent(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "---" && !line.startsWith("import type"))?.slice(0, 96) ?? "rendered template";
}
function projectRootFor(options?: ScaffoldOptions): string {
  return options?.projectRoot ? resolveScaffoldProjectRoot(options.projectRoot) : selfHostRoot;
}

export function createScaffoldPreview(
  kind: ScaffoldKind,
  name: string,
  variant?: ScaffoldVariant,
  mode: ScaffoldMode = "dry-run",
  options?: ScaffoldOptions,
): ScaffoldPreview {
  const projectRoot = projectRootFor(options);
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);
  const files = specsFor(kind, name, variant).map((spec) => {
    assertSafeTarget(spec.target);
    const templatePath = join(templateRoot, spec.template);
    const renderedContent = renderTemplate(readFileSync(templatePath, "utf8"), name, kind);
    if (renderedContent.includes("{{")) throw new Error(`Unresolved placeholder in ${spec.template}`);
    return { ...spec, template: relative(templateRoot, templatePath), renderedContent, summary: summarizeRenderedContent(renderedContent) };
  });
  return { kind, name, mode, variant, projectRoot, files };
}

function absoluteTarget(preview: ScaffoldPreview, target: string): string {
  assertSafeTarget(target);
  const result = resolve(preview.projectRoot, target);
  if (relative(preview.projectRoot, result).startsWith("..")) throw new Error(`Scaffold target escapes project root: ${target}`);
  return result;
}
function removeEmptyParents(path: string, root: string): void {
  let current = dirname(path);
  while (current !== root && relative(root, current) && !relative(root, current).startsWith("..")) {
    try { rmdirSync(current); } catch { break; }
    current = dirname(current);
  }
}

export function applyScaffold(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant, options?: ScaffoldOptions): ScaffoldApplyResult {
  const preview = createScaffoldPreview(kind, name, variant, "apply", options);
  for (const file of preview.files) if (existsSync(absoluteTarget(preview, file.target))) throw new Error(`Refusing to overwrite existing scaffold target: ${file.target}`);

  const staged = new Map<string, string>();
  const committed: string[] = [];
  let step = 0;
  const checkpoint = (label: string) => {
    step += 1;
    if (options?.failAtStep === step) throw new Error(`Injected scaffold failure at step ${step}: ${label}`);
  };

  try {
    for (const file of preview.files) {
      const target = absoluteTarget(preview, file.target);
      const temporary = `${target}.gentic-scaffold-${process.pid}-${step + 1}.tmp`;
      checkpoint(`stage ${file.target}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temporary, file.renderedContent, { flag: "wx" });
      staged.set(target, temporary);
    }
    for (const file of preview.files) {
      const target = absoluteTarget(preview, file.target);
      checkpoint(`commit ${file.target}`);
      renameSync(staged.get(target)!, target);
      staged.delete(target);
      committed.push(target);
    }
  } catch (error) {
    for (const temporary of staged.values()) rmSync(temporary, { force: true });
    for (const target of committed.reverse()) rmSync(target, { force: true });
    for (const file of [...preview.files].reverse()) removeEmptyParents(absoluteTarget(preview, file.target), preview.projectRoot);
    throw new Error(`Scaffold transaction rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ...preview, createdPaths: preview.files.map((file) => file.target), updatedPaths: [] };
}

export function formatScaffoldPreview(preview: ScaffoldPreview): string {
  const heading = [preview.kind, preview.name, preview.variant].filter(Boolean).join(" ");
  return [`Dry-run scaffold: ${heading}`, `Project root: ${preview.projectRoot}`, "No files written.", ...preview.files.map((file) => `- ${file.target} — ${file.description}; ${file.summary}`)].join("\n");
}
export function formatScaffoldApplyResult(result: ScaffoldApplyResult): string {
  const heading = [result.kind, result.name, result.variant].filter(Boolean).join(" ");
  return [`Applied scaffold: ${heading}`, `Project root: ${result.projectRoot}`, ...result.createdPaths.map((path) => `- created ${path}`)].join("\n");
}

function completions(prefix: string) {
  const tokens = prefix.trimStart().split(/\s+/);
  if (tokens.length <= 1 && !prefix.endsWith(" ")) {
    return validKinds.filter((value) => value.startsWith(tokens[0] ?? "")).map((value) => ({ value, label: value }));
  }
  const kind = tokens[0];
  const last = tokens.at(-1) ?? "";
  const values = kind === "extension" ? ["--minimal", "--layered", "--dry-run", "--apply"]
    : kind === "skill" ? ["--simple", "--directory", "--dry-run", "--apply"]
      : ["--dry-run", "--apply"];
  return values.filter((value) => value.startsWith(last)).map((value) => ({ value: `${tokens.slice(0, -1).join(" ")} ${value}`.trim(), label: value }));
}

export const scaffoldCommand: PiCommandModule = {
  name: "scaffold",
  register(pi: ExtensionAPI): void {
    pi.registerCommand("scaffold", {
      description: "Preview or atomically apply native Pi scaffolds in the current project",
      getArgumentCompletions: completions,
      handler: async (args, ctx) => {
        const parsed = parseScaffoldArgs(args);
        if (!parsed.ok) return ctx.ui.notify(parsed.message, "warning");
        try {
          const projectRoot = resolveScaffoldProjectRoot(ctx.cwd);
          const options = { projectRoot };
          const output = parsed.mode === "apply"
            ? formatScaffoldApplyResult(applyScaffold(parsed.kind, parsed.name, parsed.variant, options))
            : formatScaffoldPreview(createScaffoldPreview(parsed.kind, parsed.name, parsed.variant, "dry-run", options));
          ctx.ui.notify(output, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
      },
    });
  },
};
