import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const APPROVED_ARTIFACT_KINDS = ["reports", "plans", "findings", "logs", "specs", "todo"] as const;
const approvedArtifactKinds = new Set<string>(APPROVED_ARTIFACT_KINDS);
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ResourceIssue {
  path: string;
  message: string;
}

export interface PackageResourceInventory {
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/^!/, "").replace(/^\.\//, "").replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesManifestPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/^\.\//, "").replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/^!/, "").replace(/^\.\//, "").replace(/\\/g, "/");
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
  }
  const exact = globPattern(pattern);
  if (exact.test(normalizedPath)) return true;
  const lastSegment = normalizedPattern.split("/").at(-1) ?? "";
  if (!/[.*?]/.test(lastSegment)) {
    return new RegExp(exact.source.replace(/\$$/, "(?:/.*)?$")).test(normalizedPath);
  }
  return false;
}

function selectedByPatterns(path: string, patterns: readonly string[]): boolean {
  const included = patterns.some((pattern) => !pattern.startsWith("!") && matchesManifestPattern(path, pattern));
  const excluded = patterns.some((pattern) => pattern.startsWith("!") && matchesManifestPattern(path, pattern));
  return included && !excluded;
}

export function discoverPackageResources(root: string, manifest: Record<string, string[]>): PackageResourceInventory {
  const files = walkFiles(root)
    .map((path) => normalizeRelative(root, path))
    .filter((path) => !path.startsWith("node_modules/") && !path.startsWith(".git/") && !path.startsWith(".model-artifacts/"));

  const candidates = {
    extensions: files.filter((path) => /^extensions\/(?:[^/]+\/index|[^/]+)\.(?:ts|js)$/.test(path)),
    skills: files.filter((path) => /(^|\/)SKILL\.md$/.test(path) || /(^|\/)skills\/[^/]+\.md$/.test(path)),
    prompts: files.filter((path) => extname(path) === ".md"),
    themes: files.filter((path) => extname(path) === ".json"),
  };

  return {
    extensions: candidates.extensions.filter((path) => selectedByPatterns(path, manifest.extensions ?? [])).sort(),
    skills: candidates.skills.filter((path) => selectedByPatterns(path, manifest.skills ?? [])).sort(),
    prompts: candidates.prompts.filter((path) => selectedByPatterns(path, manifest.prompts ?? [])).sort(),
    themes: candidates.themes.filter((path) => selectedByPatterns(path, manifest.themes ?? [])).sort(),
  };
}

export function parseFrontmatter(content: string): { fields: Record<string, string>; error?: string } {
  if (!content.startsWith("---\n")) return { fields: {}, error: "missing YAML frontmatter" };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { fields: {}, error: "unterminated YAML frontmatter" };
  const fields: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.*?)\s*$/i);
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields };
}

export function validateSkill(path: string): ResourceIssue[] {
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  const issues: ResourceIssue[] = [];
  if (parsed.error) issues.push({ path, message: parsed.error });
  const name = parsed.fields.name ?? "";
  const description = parsed.fields.description ?? "";
  if (!name) issues.push({ path, message: "skill frontmatter requires name" });
  else {
    if (name.length > 64 || !skillNamePattern.test(name)) issues.push({ path, message: `invalid skill name: ${name}` });
    if (basename(path) === "SKILL.md") {
      const directoryName = basename(dirname(path));
      if (name !== directoryName) issues.push({ path, message: `skill name ${name} must match parent directory ${directoryName}` });
    }
  }
  if (!description) issues.push({ path, message: "skill frontmatter requires description" });
  else if (description.length > 1024) issues.push({ path, message: "skill description exceeds 1024 characters" });
  return issues;
}

export function validatePrompt(path: string): ResourceIssue[] {
  const content = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(content);
  const issues: ResourceIssue[] = [];
  if (parsed.error) issues.push({ path, message: parsed.error });
  if (!parsed.fields.description) issues.push({ path, message: "prompt frontmatter requires description" });
  if (/\$(?:[1-9]|@|ARGUMENTS|\{)/.test(content) && !parsed.fields["argument-hint"]) {
    issues.push({ path, message: "prompt using arguments requires argument-hint" });
  }
  return issues;
}

export function validateTheme(path: string, schemaPath: string): ResourceIssue[] {
  const issues: ResourceIssue[] = [];
  const theme = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: { colors: { required: string[]; properties: Record<string, unknown> } };
  };
  const name = theme.name;
  const colors = (theme.colors ?? {}) as Record<string, unknown>;
  const vars = (theme.vars ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !name || name.includes("/")) issues.push({ path, message: "theme requires a unique name without /" });
  for (const role of schema.properties.colors.required) {
    if (!(role in colors)) issues.push({ path, message: `missing required theme role: ${role}` });
  }
  for (const role of Object.keys(colors)) {
    if (!(role in schema.properties.colors.properties)) issues.push({ path, message: `unknown theme role: ${role}` });
    const value = colors[role];
    if (typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 255)) issues.push({ path, message: `invalid color value for ${role}` });
    if (typeof value === "string" && value && !/^#[0-9a-f]{6}$/i.test(value) && !(value in vars)) issues.push({ path, message: `unknown color variable for ${role}: ${value}` });
    if (typeof value !== "string" && typeof value !== "number") issues.push({ path, message: `invalid color value for ${role}` });
  }
  return issues;
}

export function validateArtifactRoots(paths: readonly string[]): ResourceIssue[] {
  const issues: ResourceIssue[] = [];
  for (const path of paths) {
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(/\.model-artifacts\/([a-z-]+)/g)) {
      if (!approvedArtifactKinds.has(match[1])) issues.push({ path, message: `unapproved model artifact kind: ${match[1]}` });
    }
  }
  return issues;
}

export function validatePackageResources(root: string): { inventory: PackageResourceInventory; issues: ResourceIssue[] } {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { pi?: Record<string, string[]> };
  const manifest = packageJson.pi ?? {};
  const inventory = discoverPackageResources(root, manifest);
  const issues = [
    ...inventory.skills.flatMap((path) => validateSkill(join(root, path))),
    ...inventory.prompts.flatMap((path) => validatePrompt(join(root, path))),
  ];
  const themeSchema = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json");
  const themeNames = new Map<string, string>();
  for (const resourcePath of inventory.themes) {
    const path = join(root, resourcePath);
    issues.push(...validateTheme(path, themeSchema));
    const name = (JSON.parse(readFileSync(path, "utf8")) as { name?: string }).name;
    if (name) {
      const previous = themeNames.get(name);
      if (previous) issues.push({ path, message: `duplicate theme name ${name} (also ${previous})` });
      else themeNames.set(name, resourcePath);
    }
  }

  const invocations = new Map<string, string>();
  for (const path of inventory.prompts) {
    const invocation = basename(path, ".md");
    const previous = invocations.get(invocation);
    if (previous) issues.push({ path, message: `duplicate invocation /${invocation} (also ${previous})` });
    else invocations.set(invocation, path);
  }
  for (const path of inventory.skills) {
    const name = parseFrontmatter(readFileSync(join(root, path), "utf8")).fields.name;
    if (!name) continue;
    const invocation = `skill:${name}`;
    const previous = invocations.get(invocation);
    if (previous) issues.push({ path, message: `duplicate invocation /${invocation} (also ${previous})` });
    else invocations.set(invocation, path);
  }

  const artifactSourcePaths = new Set([
    ...inventory.skills.map((path) => join(root, path)),
    ...inventory.prompts.map((path) => join(root, path)),
    ...walkFiles(join(root, "extensions")).filter((path) => [".md", ".ts", ".json"].includes(extname(path))),
  ]);
  issues.push(...validateArtifactRoots([...artifactSourcePaths]));
  return { inventory, issues };
}
