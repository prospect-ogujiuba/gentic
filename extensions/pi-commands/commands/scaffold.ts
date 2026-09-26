import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rootActionCompletions } from "../../../src/command-guidance.ts";
import type { PiCommandModule } from "../types.ts";
import { createScaffoldPlan, parseScaffoldArgs, resolveScaffoldProjectRoot, SCAFFOLD_COMMAND_ACTIONS } from "../scaffold/planning.ts";
import { renderScaffoldPlan } from "../scaffold/rendering.ts";
import { applyScaffoldPreview } from "../scaffold/application.ts";
import type { ScaffoldKind, ScaffoldVariant, ScaffoldMode, ScaffoldPreview, ScaffoldApplyResult, ScaffoldOptions } from "../scaffold/types.ts";

export type { ScaffoldPreviewFile, ScaffoldPreview, ScaffoldApplyResult, ScaffoldOptions } from "../scaffold/types.ts";
export { resolveScaffoldProjectRoot } from "../scaffold/planning.ts";

export function createScaffoldPreview(
  kind: ScaffoldKind,
  name: string,
  variant?: ScaffoldVariant,
  mode: ScaffoldMode = "dry-run",
  options?: ScaffoldOptions,
): ScaffoldPreview {
  return renderScaffoldPlan(createScaffoldPlan(kind, name, variant, mode, options));
}

export function applyScaffold(kind: ScaffoldKind, name: string, variant?: ScaffoldVariant, options?: ScaffoldOptions): ScaffoldApplyResult {
  return applyScaffoldPreview(createScaffoldPreview(kind, name, variant, "apply", options), options);
}

export function formatScaffoldPreview(preview: ScaffoldPreview): string {
  const heading = [preview.kind, preview.name, preview.variant].filter(Boolean).join(" ");
  return [`Dry-run scaffold: ${heading}`, `Project root: ${preview.projectRoot}`, "No files written.", ...preview.files.map((file) => `- ${file.target} — ${file.description}; ${file.summary}`)].join("\n");
}
export function formatScaffoldApplyResult(result: ScaffoldApplyResult): string {
  const heading = [result.kind, result.name, result.variant].filter(Boolean).join(" ");
  const nextSteps = result.kind === "primitive"
    ? [`- next: import ${result.name} in extensions/pi-primitives/index.ts and add it to EXPLICIT_PRIMITIVES`]
    : [];
  return [`Applied scaffold: ${heading}`, `Project root: ${result.projectRoot}`, ...result.createdPaths.map((path) => `- created ${path}`), ...nextSteps].join("\n");
}

const OPTION_DESCRIPTIONS: Record<string, string> = {
  "--minimal": "Generate the minimal extension variant",
  "--layered": "Generate domain/app/Pi layered extension files",
  "--simple": "Generate a single-file skill",
  "--directory": "Generate a skill directory with supporting resources",
  "--dry-run": "Preview files without writing (default)",
  "--apply": "Write the scaffold after validation",
};

export function completeScaffoldArgument(prefix: string): Array<{ value: string; label: string; description: string }> {
  const normalized = prefix.trimStart();
  const trailingSpace = /\s$/.test(normalized);
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const query = tokens[0] ?? "";
    return rootActionCompletions(query, SCAFFOLD_COMMAND_ACTIONS);
  }
  if (tokens.length < 2 || (tokens.length === 2 && !trailingSpace)) return [];
  const kind = tokens[0];
  const current = trailingSpace ? "" : tokens.at(-1) ?? "";
  const completed = trailingSpace ? tokens : tokens.slice(0, -1);
  const values = kind === "extension" ? ["--minimal", "--layered", "--dry-run", "--apply"]
    : kind === "skill" ? ["--simple", "--directory", "--dry-run", "--apply"]
      : ["--dry-run", "--apply"];
  const exclusiveGroups = [
    ["--minimal", "--layered"],
    ["--simple", "--directory"],
    ["--dry-run", "--apply"],
  ];
  return values
    .filter((value) => !completed.includes(value) && value.startsWith(current))
    .filter((value) => !exclusiveGroups.some((group) => group.includes(value) && group.some((member) => completed.includes(member))))
    .map((value) => ({ value: [...completed, value].join(" "), label: value, description: OPTION_DESCRIPTIONS[value]! }));
}

export const scaffoldCommand: PiCommandModule = {
  name: "scaffold",
  register(pi: ExtensionAPI): void {
    pi.registerCommand("scaffold", {
      description: "/scaffold <kind> <name> [variant] [--dry-run|--apply] — preview or apply native Pi scaffolds",
      getArgumentCompletions: completeScaffoldArgument,
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
