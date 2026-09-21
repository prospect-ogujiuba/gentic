import { posix } from "node:path";

import {
  INITIATIVE_ARTIFACT_KINDS,
  SYSTEM_ARTIFACT_KINDS,
  type CreateArtifactRequest,
  type InitiativeArtifactKind,
  type SystemArtifactKind,
} from "./types.ts";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GENERATED_MARKDOWN = /^\d{4}-\d{2}-\d{2}_\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const MAX_SEGMENT = 128;

export function artifactTimestamp(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error("artifact date is invalid");
  return date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
}

export function createArtifactPath(request: CreateArtifactRequest, date = new Date()): string {
  const name = kebab(request.name, "artifact name");
  const filename = `${artifactTimestamp(date)}-${name}.md`;

  if (request.scope === "initiative") {
    const topic = kebab(request.topic, "initiative topic");
    if (!INITIATIVE_ARTIFACT_KINDS.includes(request.kind)) throw new Error("invalid initiative artifact kind");
    return `.model-artifacts/initiatives/${topic}/${request.kind}/${filename}`;
  }

  if (!SYSTEM_ARTIFACT_KINDS.includes(request.kind)) throw new Error("invalid system artifact kind");
  const namespace = request.namespace === undefined ? "" : `/${kebab(request.namespace, "system namespace")}`;
  return `.model-artifacts/system/${request.kind}${namespace}/${filename}`;
}

export function validateCanonicalArtifactPath(path: string): void {
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\\") || path !== posix.normalize(path)) {
    throw new Error("artifact path must be a normalized project-relative POSIX path");
  }
  const parts = path.split("/");
  if (parts[0] !== ".model-artifacts") throw new Error("artifact path must be beneath .model-artifacts");

  if (parts[1] === "initiatives") {
    if (parts.length === 4 && parts[3] === "workflow.json") {
      kebab(parts[2]!, "initiative topic");
      return;
    }
    if (parts.length !== 5) throw new Error("initiative artifacts must be directly beneath a topic kind");
    kebab(parts[2]!, "initiative topic");
    if (!INITIATIVE_ARTIFACT_KINDS.includes(parts[3] as InitiativeArtifactKind)) throw new Error("invalid initiative artifact kind");
    if (!GENERATED_MARKDOWN.test(parts[4]!)) throw new Error("initiative artifact filename is not canonical");
    return;
  }

  if (parts[1] === "system") {
    if (parts.length !== 4 && parts.length !== 5) throw new Error("system artifacts support at most one namespace");
    if (!SYSTEM_ARTIFACT_KINDS.includes(parts[2] as SystemArtifactKind)) throw new Error("invalid system artifact kind");
    if (parts.length === 5) kebab(parts[3]!, "system namespace");
    if (!GENERATED_MARKDOWN.test(parts.at(-1)!)) throw new Error("system artifact filename is not canonical");
    return;
  }

  throw new Error("artifact path must use initiatives or system scope");
}

function kebab(value: string, label: string): string {
  if (typeof value !== "string" || value.length > MAX_SEGMENT || !KEBAB.test(value)) throw new Error(`${label} must be kebab-case`);
  return value;
}
