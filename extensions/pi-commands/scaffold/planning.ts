import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandActionSpec } from "../../../src/command-guidance.ts";
import type { ScaffoldKind, ScaffoldVariant, ScaffoldMode, ScaffoldOptions, ScaffoldPlan, TemplateSpec } from "./types.ts";

type ParseResult =
  | { ok: true; kind: ScaffoldKind; name: string; mode: ScaffoldMode; variant?: ScaffoldVariant }
  | { ok: false; message: string };

const selfHostRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const SCAFFOLD_COMMAND_ACTIONS = [
  { action: "extension", syntax: "/scaffold extension <name> [--minimal|--layered]", description: "Create a minimal or layered Pi extension" },
  { action: "tool", syntax: "/scaffold tool <name>", description: "Create an extension-backed model-callable tool" },
  { action: "command", syntax: "/scaffold command <name>", description: "Create a runtime slash command" },
  { action: "event", syntax: "/scaffold event <name>", description: "Create an extension lifecycle event handler" },
  { action: "shortcut", syntax: "/scaffold shortcut <name>", description: "Create a keyboard shortcut extension" },
  { action: "flag", syntax: "/scaffold flag <name>", description: "Create a CLI flag extension" },
  { action: "provider", syntax: "/scaffold provider <name>", description: "Create a custom provider extension" },
  { action: "widget", syntax: "/scaffold widget <name>", description: "Create a widget extension" },
  { action: "footer", syntax: "/scaffold footer <name>", description: "Create a custom footer extension" },
  { action: "overlay", syntax: "/scaffold overlay <name>", description: "Create an overlay UI extension" },
  { action: "skill", syntax: "/scaffold skill <name> [--simple|--directory]", description: "Create a simple or directory skill" },
  { action: "prompt", syntax: "/scaffold prompt <name>", description: "Create a prompt template" },
  { action: "theme", syntax: "/scaffold theme <name>", description: "Create a Pi theme" },
  { action: "primitive", syntax: "/scaffold primitive <name>", description: "Create a Gentic primitive" },
] as const satisfies readonly CommandActionSpec<ScaffoldKind>[];
const validKinds: readonly ScaffoldKind[] = SCAFFOLD_COMMAND_ACTIONS.map((item) => item.action);
const extensionBackedKinds = new Set<ScaffoldKind>(["tool", "command", "event", "shortcut", "flag", "provider", "widget", "footer", "overlay"]);
const usage = [
  "Usage: /scaffold <kind> <name> [variant] [--dry-run|--apply]",
  "Kinds: extension, tool, command, event, shortcut, flag, provider, widget, footer, overlay, skill, prompt, theme, primitive",
  "Variants: extension --minimal|--layered; skill --simple|--directory",
  "Dry-run is the default. Apply targets the nearest package.json with a pi manifest.",
].join("\n");

function validateName(name: string): string | undefined {
  if (!name) return "Missing scaffold name.";
  if (!/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
    return `Invalid name: ${name}. Use kebab-case starting with a letter, followed by letters, numbers, and single hyphen-separated words.`;
  }
  return undefined;
}
export function assertSafeTarget(target: string): void {
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

export function parseScaffoldArgs(args: string): ParseResult {
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
    { template: "primitive/supporting-file.template.md", target: `extensions/pi-primitives/primitives/${name}/injection.md`, description: "bounded primitive prompt policy" },
    { template: "primitive/triggers.template.json", target: `extensions/pi-primitives/primitives/${name}/triggers.json`, description: "primitive triggers" },
  ];
}

function projectRootFor(options?: ScaffoldOptions): string {
  return options?.projectRoot ? resolveScaffoldProjectRoot(options.projectRoot) : selfHostRoot;
}

export function createScaffoldPlan(
  kind: ScaffoldKind,
  name: string,
  variant?: ScaffoldVariant,
  mode: ScaffoldMode = "dry-run",
  options?: ScaffoldOptions,
): ScaffoldPlan {
  const projectRoot = projectRootFor(options);
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);
  const files = specsFor(kind, name, variant);
  for (const file of files) assertSafeTarget(file.target);
  return { kind, name, mode, variant, projectRoot, files };
}
