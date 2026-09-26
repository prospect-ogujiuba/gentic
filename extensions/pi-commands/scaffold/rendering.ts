import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScaffoldKind, ScaffoldPlan, ScaffoldPreview } from "./types.ts";

const templateRoot = fileURLToPath(new URL("../templates/", import.meta.url));

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
    supportingFileName: "injection.md", triggerPhrase: name, pathPattern: `(?:^|/)${name}(?:/|$)`,
    enabledText: "enabled", disabledText: "disabled", statusPrefix: toTitle(name), referenceNote: "Add detailed reference material here.",
    helperOutput: `${name} helper ready`,
  };
  return template.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? `{{${key}}`);
}

function summarizeRenderedContent(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "---" && !line.startsWith("import type"))?.slice(0, 96) ?? "rendered template";
}
export function renderScaffoldPlan(plan: ScaffoldPlan): ScaffoldPreview {
  const files = plan.files.map((spec) => {
    const templatePath = resolve(templateRoot, spec.template);
    const lexical = relative(templateRoot, templatePath);
    if (isAbsolute(spec.template) || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      throw new Error(`Scaffold template escapes template root: ${spec.template}`);
    }
    const physical = relative(realpathSync(templateRoot), realpathSync(templatePath));
    if (physical === ".." || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
      throw new Error(`Scaffold template escapes template root: ${spec.template}`);
    }
    const renderedContent = renderTemplate(readFileSync(templatePath, "utf8"), plan.name, plan.kind);
    if (renderedContent.includes("{{")) throw new Error(`Unresolved placeholder in ${spec.template}`);
    return { ...spec, template: relative(templateRoot, templatePath), renderedContent, summary: summarizeRenderedContent(renderedContent) };
  });
  return { ...plan, files };
}
