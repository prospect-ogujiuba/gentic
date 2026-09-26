import path from "node:path";

import {
  MAX_SAFE_PUBLICATION_BYTES,
  SafePublicationError,
  publishNewTextFile,
} from "../../../../src/services/safe-file-publication.ts";
import type { NativeContextSnapshot } from "./native-snapshot-contract.ts";
import { renderNativeContextSummary, sanitizeNativeContextSnapshot } from "./native-snapshot.ts";

export type NativeContextExportFormat = "markdown" | "json";
export type NativeContextExportOptions = {
  cwd?: string;
  format: NativeContextExportFormat;
};
export type NativeContextExportArtifact = {
  path: string;
  relativePath: string;
  format: NativeContextExportFormat;
};

const REPORT_SEGMENTS = [".model-artifacts", "system", "reports", "pi-context"] as const;
const REPORT_DIR = path.join(...REPORT_SEGMENTS);

export function renderNativeContextMarkdown(input: NativeContextSnapshot): string {
  const snapshot = sanitizeNativeContextSnapshot(input);
  const lines = [
    "# pi-context report",
    "",
    `Generated: ${snapshot.capturedAt}`,
    "",
    "## Summary",
    "",
    ...renderNativeContextSummary(snapshot).split("\n").slice(1).map((line) => line.startsWith("-") ? line : `- ${line}`),
    "",
    "## Bounds",
    "",
    `- Active branch entries scanned: ${snapshot.branch.scannedEntries} of ${snapshot.branch.totalEntries}`,
    `- Branch truncated: ${snapshot.branch.truncated}`,
    `- Maximum branch scan: ${snapshot.bounds.maxBranchEntriesScanned}`,
    `- Maximum contributors: ${snapshot.bounds.maxContributors}`,
    `- Maximum diagnostics: ${snapshot.bounds.maxDiagnostics}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderNativeContextJson(input: NativeContextSnapshot): string {
  return `${JSON.stringify(sanitizeNativeContextSnapshot(input), null, 2)}\n`;
}

export function writeNativeContextExport(
  snapshot: NativeContextSnapshot,
  options: NativeContextExportOptions,
): NativeContextExportArtifact {
  const root = options.cwd ?? process.cwd();
  const extension = options.format === "json" ? "json" : "md";
  const capturedAt = new Date(sanitizeNativeContextSnapshot(snapshot).capturedAt).toISOString();
  const timestamp = `${capturedAt.slice(0, 10)}_${capturedAt.slice(11, 16).replace(":", "")}`;
  const uniqueSuffix = capturedAt.slice(17, 23).replace(".", "-");
  const filename = `${timestamp}-pi-context-${uniqueSuffix}.${extension}`;
  const relativePath = path.join(REPORT_DIR, filename);
  const content = options.format === "json" ? renderNativeContextJson(snapshot) : renderNativeContextMarkdown(snapshot);
  let filePath: string;
  try {
    const published = publishNewTextFile({
      root,
      relativePath: [...REPORT_SEGMENTS, filename].join("/"),
      content,
      maxBytes: MAX_SAFE_PUBLICATION_BYTES,
      temporaryTag: "pi-context",
    });
    filePath = published.path;
  } catch (error) {
    if (error instanceof SafePublicationError) {
      if (error.code === "collision") throw new Error("pi-context export destination already exists or is unsafe");
      throw new Error(`pi-context export containment rejected unsafe publication: ${error.message}`);
    }
    throw error;
  }
  return { path: filePath, relativePath, format: options.format };
}
