import { createHash } from "node:crypto";
import path from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { byteLength, normalizeLedgerEntry, type ContextLedgerEntry, type ContextSourceKind, type ContextSourceMetadata } from "../domain/index.ts";

export type StaticInventoryContextFile = {
  path: string;
  content?: string;
};

export type StaticInventorySourceInfo = {
  path?: string;
  source?: string;
  scope?: string;
  origin?: string;
  baseDir?: string;
};

export type StaticInventorySkill = {
  name: string;
  description?: string;
  filePath?: string;
  baseDir?: string;
  sourceInfo?: StaticInventorySourceInfo;
  disableModelInvocation?: boolean;
};

export type StaticInventorySystemPromptOptions = {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: StaticInventoryContextFile[];
  skills?: StaticInventorySkill[];
};

export type StaticInventoryInput = {
  at?: string;
  cwd?: string;
  homeDir?: string;
  systemPrompt?: string;
  systemPromptOptions?: StaticInventorySystemPromptOptions;
};

export type StaticInventoryResult = {
  entries: ContextLedgerEntry[];
  warnings: string[];
};

export function collectStaticInventory(input: StaticInventoryInput): StaticInventoryResult {
  const at = input.at ?? new Date().toISOString();
  const options = input.systemPromptOptions ?? {};
  const cwd = options.cwd ?? input.cwd;
  const homeDir = input.homeDir ?? process.env.HOME;
  const entries: ContextLedgerEntry[] = [];
  const warnings: string[] = [];

  addMeasured(entries, {
    id: "static:system:effective-system-prompt",
    kind: "system",
    label: "Effective system prompt",
    origin: "ctx.getSystemPrompt",
    content: input.systemPrompt,
    at,
    metadata: { resourceType: "system_prompt", displayPath: "system prompt", status: input.systemPrompt === undefined ? "unknown" : "present" },
    unknownWarning: "effective system prompt was not exposed",
  });

  addMeasured(entries, {
    id: "static:system:custom-prompt",
    kind: "system",
    label: "Custom system prompt",
    origin: "SYSTEM.md or --system-prompt",
    content: options.customPrompt,
    at,
    metadata: { resourceType: "system_prompt", displayPath: "SYSTEM.md", status: options.customPrompt === undefined ? "absent" : "present" },
  });

  addMeasured(entries, {
    id: "static:system:append-system-prompt",
    kind: "system",
    label: "Append system prompt",
    origin: "APPEND_SYSTEM.md or --append-system-prompt",
    content: options.appendSystemPrompt,
    at,
    metadata: { resourceType: "append_system_prompt", displayPath: "APPEND_SYSTEM.md", status: options.appendSystemPrompt === undefined ? "absent" : "present" },
  });

  if (options.promptGuidelines?.length) {
    addMeasured(entries, {
      id: "static:system:prompt-guidelines",
      kind: "system",
      label: "Extension prompt guidelines",
      origin: "systemPromptOptions.promptGuidelines",
      content: options.promptGuidelines.join("\n"),
      at,
      metadata: { resourceType: "prompt_guidelines", status: "present" },
    });
  }

  for (const contextFile of options.contextFiles ?? []) {
    const classification = classifyContextFile(contextFile.path, cwd, homeDir);
    addMeasured(entries, {
      id: `static:${classification.kind}:context-file:${hashText(normalizePath(contextFile.path)).slice(0, 16)}`,
      kind: classification.kind,
      label: path.basename(contextFile.path),
      origin: contextFile.path,
      content: contextFile.content,
      at,
      metadata: {
        resourceType: "context_file",
        displayPath: contextFile.path,
        scope: classification.scope,
        status: contextFile.content === undefined ? "unknown" : "present",
      },
      unknownWarning: `context file ${contextFile.path} had no measurable content`,
    });
  }

  addAbsentOptionalContextFiles(entries, options.contextFiles, cwd, homeDir, at);

  for (const toolName of options.selectedTools ?? []) {
    const snippet = options.toolSnippets?.[toolName];
    entries.push(
      normalizeLedgerEntry({
        id: `static:tool:${toolName}`,
        kind: "tool",
        label: toolName,
        origin: "systemPromptOptions.selectedTools",
        byteCount: snippet === undefined ? byteLength(toolName) : byteLength(snippet),
        tokenConfidence: snippet === undefined ? "unknown" : "estimated",
        seenAt: at,
        sourceMetadata: {
          resourceType: "tool",
          displayPath: toolName,
          hash: hashText(snippet ?? toolName),
          hashAlgorithm: "sha256",
          contentStored: false,
          status: "present",
          warning: snippet === undefined ? "tool prompt snippet was not exposed" : undefined,
        },
      }),
    );
  }

  const packageNames = new Set<string>();
  for (const skill of options.skills ?? []) {
    const sourceInfo = skill.sourceInfo;
    const kind = classifyResourceKind(sourceInfo);
    const origin = skill.filePath ?? sourceInfo?.path ?? sourceInfo?.source;
    const packageName = sourceInfo?.origin === "package" ? sourceInfo.source : undefined;
    if (packageName) packageNames.add(packageName);
    addMeasured(entries, {
      id: `static:${kind}:skill:${hashText(`${sourceInfo?.source ?? "local"}:${skill.name}:${origin ?? ""}`).slice(0, 16)}`,
      kind,
      label: `skill:${skill.name}`,
      origin,
      content: `${skill.name}\n${skill.description ?? ""}`,
      at,
      metadata: {
        resourceType: "skill",
        displayPath: origin,
        packageName,
        source: sourceInfo?.source,
        scope: sourceInfo?.scope,
        origin: sourceInfo?.origin,
        status: "present",
      },
    });
  }

  for (const packageName of [...packageNames].sort()) {
    entries.push(
      normalizeLedgerEntry({
        id: `static:extension:package:${hashText(packageName).slice(0, 16)}`,
        kind: "extension",
        label: packageName,
        origin: packageName,
        byteCount: 0,
        tokenConfidence: "unknown",
        seenAt: at,
        sourceMetadata: {
          resourceType: "package",
          packageName,
          source: packageName,
          status: "present",
          contentStored: false,
          warning: "package manifest content was not measured",
        },
      }),
    );
  }

  for (const entry of entries) {
    if (entry.sourceMetadata?.warning) warnings.push(entry.sourceMetadata.warning);
  }
  return { entries, warnings: [...new Set(warnings)] };
}

export function collectStaticInventoryFromBeforeAgentStart(event: BeforeAgentStartEvent, input: { cwd?: string; homeDir?: string; at?: string } = {}): StaticInventoryResult {
  return collectStaticInventory({
    at: input.at,
    cwd: event.systemPromptOptions.cwd ?? input.cwd,
    homeDir: input.homeDir,
    systemPrompt: event.systemPrompt,
    systemPromptOptions: event.systemPromptOptions,
  });
}

function addMeasured(
  entries: ContextLedgerEntry[],
  input: {
    id: string;
    kind: ContextSourceKind;
    label: string;
    origin?: string;
    content?: string;
    at: string;
    metadata: ContextSourceMetadata;
    unknownWarning?: string;
  },
): void {
  if (input.content === undefined) {
    entries.push(
      normalizeLedgerEntry({
        id: input.id,
        kind: input.kind,
        label: input.label,
        origin: input.origin,
        byteCount: 0,
        tokenConfidence: "unknown",
        seenAt: input.at,
        sourceMetadata: { ...input.metadata, contentStored: false, warning: input.unknownWarning },
      }),
    );
    return;
  }

  const originalByteCount = byteLength(input.content);
  entries.push(
    normalizeLedgerEntry({
      id: input.id,
      kind: input.kind,
      label: input.label,
      origin: input.origin,
      byteCount: originalByteCount,
      tokenConfidence: "estimated",
      seenAt: input.at,
      redaction: { redacted: true, reason: "static source content is not stored", originalByteCount },
      sourceMetadata: {
        ...input.metadata,
        hash: hashText(input.content),
        hashAlgorithm: "sha256",
        contentStored: false,
      },
    }),
  );
}

function addAbsentOptionalContextFiles(
  entries: ContextLedgerEntry[],
  contextFiles: StaticInventoryContextFile[] | undefined,
  cwd: string | undefined,
  homeDir: string | undefined,
  at: string,
): void {
  if (!contextFiles) return;
  const loaded = new Set(contextFiles.map((file) => normalizePath(file.path)));
  const optionalFiles: Array<{ path: string; kind: ContextSourceKind; scope: string; label: string }> = [];
  if (homeDir) optionalFiles.push({ path: path.join(homeDir, ".pi", "agent", "AGENTS.md"), kind: "user", scope: "user", label: "global AGENTS.md" });
  if (cwd) {
    optionalFiles.push({ path: path.join(cwd, "AGENTS.md"), kind: "project", scope: "project", label: "project AGENTS.md" });
    optionalFiles.push({ path: path.join(cwd, "CLAUDE.md"), kind: "project", scope: "project", label: "project CLAUDE.md" });
  }

  for (const optional of optionalFiles) {
    const normalized = normalizePath(optional.path);
    if (loaded.has(normalized)) continue;
    entries.push(
      normalizeLedgerEntry({
        id: `static:${optional.kind}:absent-context-file:${hashText(normalized).slice(0, 16)}`,
        kind: optional.kind,
        label: optional.label,
        origin: optional.path,
        byteCount: 0,
        tokenConfidence: "unknown",
        seenAt: at,
        sourceMetadata: {
          resourceType: "context_file",
          displayPath: optional.path,
          scope: optional.scope,
          status: "absent",
          contentStored: false,
        },
      }),
    );
  }
}

function classifyContextFile(filePath: string, cwd: string | undefined, homeDir: string | undefined): { kind: ContextSourceKind; scope: string } {
  const normalized = normalizePath(filePath);
  if (homeDir && isSameOrChild(normalized, path.join(homeDir, ".pi", "agent"))) return { kind: "user", scope: "user" };
  if (cwd) {
    const normalizedCwd = normalizePath(cwd);
    const dir = normalizePath(path.dirname(normalized));
    if (isSameOrChild(normalized, normalizedCwd) || isSameOrChild(normalizedCwd, dir)) return { kind: "project", scope: "project" };
  }
  return { kind: "unknown", scope: "unknown" };
}

function classifyResourceKind(sourceInfo: StaticInventorySourceInfo | undefined): ContextSourceKind {
  if (sourceInfo?.origin === "package") return "extension";
  if (sourceInfo?.scope === "user") return "user";
  if (sourceInfo?.scope === "project") return "project";
  return "extension";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isSameOrChild(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
