import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { discoverPackageResources, type PackageResourceInventory } from "../package-resource-validation.ts";

export const GENTIC_INVENTORY_SCHEMA_VERSION = 1 as const;

export type RegistrationInventory = {
  commands: string[];
  tools: string[];
  events: string[];
  shortcuts: string[];
  flags: string[];
  providers: string[];
  renderers: string[];
  markdownTransformers: number;
  uiSurfaces: string[];
};

export type ExtensionInventory = {
  owner: string;
  entrypoint: string;
  sourceFiles: string[];
  registrations: RegistrationInventory;
};

export type GenticInventory = {
  schemaVersion: typeof GENTIC_INVENTORY_SCHEMA_VERSION;
  package: { name: string; version: string; private: boolean; piVersion: string; node: string };
  manifest: Record<string, string[]>;
  resources: PackageResourceInventory;
  extensions: ExtensionInventory[];
  profiles: Array<{ id: string; path: string; extensions: string[] }>;
};

function normalize(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function walkSource(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["templates", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSource(path));
    else if (entry.isFile() && [".ts", ".js", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function literals(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function registeredNames(source: string, literalPattern: RegExp, referencePattern: RegExp): string[] {
  const assignments = new Map<string, Set<string>>();
  for (const match of source.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)) {
    const values = assignments.get(match[1]) ?? new Set<string>();
    values.add(match[2]);
    assignments.set(match[1], values);
  }
  const references = literals(source, referencePattern).map((name) => {
    const values = [...(assignments.get(name) ?? [])];
    if (values.length !== 1) throw new Error(`Registration constant ${name} must have one literal string assignment`);
    return values[0];
  });
  return [...literals(source, literalPattern), ...references];
}

function registrations(source: string): RegistrationInventory {
  const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    commands: unique(registeredNames(
      source,
      /\bpi\.registerCommand\(\s*["']([^"']+)["']/g,
      /\bpi\.registerCommand\(\s*([A-Z][A-Z0-9_]*)/g,
    )),
    tools: unique(registeredNames(
      source,
      /\bpi\.registerTool\(\s*\{[\s\S]{0,800}?\bname:\s*["']([^"']+)["']/g,
      /\bpi\.registerTool\(\s*\{[\s\S]{0,800}?\bname:\s*([A-Z][A-Z0-9_]*)/g,
    )),
    events: unique(literals(source, /\bpi\.on\(\s*["']([^"']+)["']/g)),
    shortcuts: unique(literals(source, /\bpi\.registerShortcut\(\s*["']([^"']+)["']/g)),
    flags: unique(literals(source, /\bpi\.registerFlag\(\s*["']([^"']+)["']/g)),
    providers: unique(literals(source, /\bpi\.registerProvider\(\s*["']([^"']+)["']/g)),
    renderers: unique([
      ...literals(source, /\bpi\.(registerMessageRenderer|registerEntryRenderer)\(/g),
      ...literals(source, /\b(renderCall|renderResult)\s*[:(]/g),
    ]),
    markdownTransformers: [...source.matchAll(/\bpi\.registerMarkdownTransformer\(/g)].length,
    uiSurfaces: unique(literals(source, /\b(?:ctx|context)\.ui\.(setStatus|setWidget|setFooter|custom|notify|addAutocompleteProvider|setWorkingIndicator)\(/g)),
  };
}

function extensionOwner(entrypoint: string): string {
  const parts = entrypoint.split("/");
  if (parts[0] === "node_modules") return (parts[1]?.startsWith("@") ? parts[2] : parts[1]) ?? "external";
  return parts.length === 2 ? parts[1].replace(/\.(?:ts|js)$/, "") : parts[1];
}

function profileInventory(root: string, extensionPaths: ReadonlySet<string>): GenticInventory["profiles"] {
  const profileRoot = join(root, "profiles");
  if (!existsSync(profileRoot)) return [];
  return readdirSync(profileRoot)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const path = join(profileRoot, name);
      const value = JSON.parse(readFileSync(path, "utf8")) as { id?: string; package?: { extensions?: string[] } };
      const extensions = value.package?.extensions ?? [];
      for (const entry of extensions) {
        const normalized = entry.replace(/^\+/, "").replace(/^\.\//, "");
        if (!extensionPaths.has(normalized)) throw new Error(`Profile ${name} references unknown extension ${entry}`);
      }
      return { id: value.id ?? name.replace(/\.json$/, ""), path: normalize(root, path), extensions };
    });
}

export function generateGenticInventory(rootPath: string): GenticInventory {
  const root = resolve(rootPath);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    pi?: Record<string, string[]>;
  };
  const manifest = packageJson.pi ?? {};
  const resources = discoverPackageResources(root, manifest);
  const extensions = resources.extensions.map((entrypoint) => {
    const absoluteEntrypoint = join(root, entrypoint);
    const external = entrypoint.startsWith("node_modules/");
    const sourceRoot = !external && (entrypoint.endsWith("/index.ts") || entrypoint.endsWith("/index.js")) ? dirname(absoluteEntrypoint) : absoluteEntrypoint;
    const sourceFiles = sourceRoot === absoluteEntrypoint ? [absoluteEntrypoint] : walkSource(sourceRoot);
    const source = sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
    return {
      owner: extensionOwner(entrypoint),
      entrypoint,
      sourceFiles: sourceFiles.map((path) => normalize(root, path)).sort(),
      registrations: registrations(source),
    };
  });
  const extensionPaths = new Set(resources.extensions);
  return {
    schemaVersion: GENTIC_INVENTORY_SCHEMA_VERSION,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      private: packageJson.private === true,
      piVersion: packageJson.dependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown",
      node: packageJson.engines?.node ?? "unknown",
    },
    manifest,
    resources,
    extensions,
    profiles: profileInventory(root, extensionPaths),
  };
}
