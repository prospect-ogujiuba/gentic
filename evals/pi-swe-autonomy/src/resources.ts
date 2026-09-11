import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { DefaultResourceLoader, type InlineExtension } from "@earendil-works/pi-coding-agent";

export type ResourceProfile = {
  readonly profileId: string;
  readonly mode: "isolated" | "fidelity";
  readonly extensionPaths: readonly string[];
  readonly skillPaths: readonly string[];
  readonly contextFiles: readonly { readonly path: string; readonly content: string }[];
  readonly tools: readonly string[];
  readonly systemPrompt?: string;
};

export type ResourceManifest = {
  readonly profileId: string;
  readonly mode: ResourceProfile["mode"];
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly context: readonly string[];
  readonly tools: readonly string[];
};

export interface ResourceLoaderLike {
  reload(): Promise<void>;
  getExtensions(): { extensions: readonly { path: string; resolvedPath?: string }[]; errors: readonly { path?: string; error?: string }[] };
  getSkills(): { skills: readonly { name: string; filePath: string }[]; diagnostics: readonly { type?: string; message?: string; path?: string }[] };
  getAgentsFiles(): { agentsFiles: readonly { path: string; content: string }[] };
}

export type ResourceLoaderFactory = {
  createLoader(options: Record<string, unknown>): ResourceLoaderLike;
};

const SAFETY_EXTENSION_IDENTITY = "<inline:pi-swe-evaluation-trial-root>@1";

export class ResourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceMismatchError";
  }
}

export async function createTrialResources(
  profile: ResourceProfile & { readonly cwd: string; readonly agentDir: string; readonly settingsManager?: unknown },
  factory: ResourceLoaderFactory = {
    createLoader: (options) => new DefaultResourceLoader(options as ConstructorParameters<typeof DefaultResourceLoader>[0]),
  },
): Promise<{ readonly loader: ResourceLoaderLike; readonly manifest: ResourceManifest }> {
  const safety = createTrialRootSafetyExtension(profile.cwd);
  const isolated = profile.mode === "isolated";
  const loader = factory.createLoader({
    cwd: profile.cwd,
    agentDir: profile.agentDir,
    settingsManager: profile.settingsManager,
    additionalExtensionPaths: [...profile.extensionPaths],
    additionalSkillPaths: [...profile.skillPaths],
    extensionFactories: [safety],
    noExtensions: isolated,
    noSkills: isolated,
    noPromptTemplates: isolated,
    noThemes: isolated,
    noContextFiles: isolated,
    agentsFilesOverride: isolated ? () => ({ agentsFiles: [...profile.contextFiles] }) : undefined,
    systemPromptOverride: profile.systemPrompt === undefined ? undefined : () => profile.systemPrompt,
  });
  await loader.reload();

  const extensionResult = loader.getExtensions();
  const skillResult = loader.getSkills();
  const resourceErrors = [
    ...extensionResult.errors.map((error) => `${error.path ?? "extension"}: ${error.error ?? "load failed"}`),
    ...skillResult.diagnostics.filter((item) => item.type === "error").map((item) => `${item.path ?? "skill"}: ${item.message ?? "load failed"}`),
  ];
  if (resourceErrors.length) throw new ResourceMismatchError(resourceErrors.join("; "));

  const loadedExtensionPaths = extensionResult.extensions
    .filter((extension) => !extension.path.startsWith("<inline:"))
    .map((extension) => extension.resolvedPath ?? extension.path)
    .sort(compare);
  const loadedSkillPaths = skillResult.skills.map((skill) => skill.filePath);
  const extensions = [
    ...loadedExtensionPaths.map(resourceIdentity),
    SAFETY_EXTENSION_IDENTITY,
  ].sort(compare);
  const skills = skillResult.skills
    .map((skill) => `${skill.name}:${resourceIdentity(skill.filePath)}`)
    .sort(compare);
  const context = loader.getAgentsFiles().agentsFiles
    .map((file) => `${file.path}:sha256:${createHash("sha256").update(file.content, "utf8").digest("hex")}`)
    .sort(compare);

  if (isolated) {
    requireExact("extension", profile.extensionPaths, loadedExtensionPaths);
    requireExact("skill", profile.skillPaths, loadedSkillPaths);
    requireExact("context", profile.contextFiles.map((file) => file.path), loader.getAgentsFiles().agentsFiles.map((file) => file.path));
  }

  return {
    loader,
    manifest: {
      profileId: profile.profileId,
      mode: profile.mode,
      extensions,
      skills,
      context,
      tools: [...new Set(profile.tools)].sort(compare),
    },
  };
}

export function createTrialRootSafetyExtension(workspacePath: string): InlineExtension {
  const root = realpathSync.native(workspacePath);
  return {
    name: "pi-swe-evaluation-trial-root",
    factory(pi) {
      pi.on("tool_call", (event) => {
        const input = event.input as Record<string, unknown>;
        if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
          const path = input.path ?? input.filePath ?? input.file_path;
          if (typeof path === "string" && !inside(root, path)) {
            return { block: true, reason: `Path escapes evaluation workspace: ${path}`, terminate: true };
          }
        }
        if ((event.toolName === "bash" || event.toolName === "powershell") && typeof input.command === "string") {
          const absolutePaths = input.command.match(/(?:^|[\s'"=])\/(?:[^\s'";&|]+)/g) ?? [];
          if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input.command) || absolutePaths.some((value) => !inside(root, value.trim()))) {
            return { block: true, reason: "Shell command may escape the evaluation workspace", terminate: true };
          }
        }
        return undefined;
      });
    },
  };
}

function inside(root: string, path: string): boolean {
  const candidate = resolve(root, path.trim());
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function requireExact(kind: string, expected: readonly string[], actual: readonly string[]): void {
  const expectedPaths = [...new Set(expected.map((path) => resolve(path)))].sort(compare);
  const actualPaths = [...new Set(actual.map((path) => resolve(path)))].sort(compare);
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    throw new ResourceMismatchError(`${kind} resource mismatch: expected [${expectedPaths.join(", ")}], loaded [${actualPaths.join(", ")}]`);
  }
}

function resourceIdentity(path: string): string {
  const root = realpathSync.native(path);
  const entries: [string, string][] = [];
  const visit = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new ResourceMismatchError(`resource identity rejects symlink: ${candidate}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(candidate).sort(compare)) visit(join(candidate, entry));
      return;
    }
    if (!stat.isFile()) throw new ResourceMismatchError(`resource identity requires regular files: ${candidate}`);
    entries.push([
      relative(root, candidate).split(sep).join("/") || ".",
      createHash("sha256").update(readFileSync(candidate)).digest("hex"),
    ]);
  };
  visit(root);
  const digest = createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
  return `${root}:sha256:${digest}`;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, "en");
}
