import fs from "node:fs";
import path from "node:path";

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

const REPORT_DIR = path.join(".model-artifacts", "system", "reports", "pi-context");

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
  const cwd = options.cwd ?? process.cwd();
  const dir = path.resolve(cwd, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const extension = options.format === "json" ? "json" : "md";
  const safeTimestamp = sanitizeNativeContextSnapshot(snapshot).capturedAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "");
  const relativePath = path.join(REPORT_DIR, `${safeTimestamp}-pi-context.${extension}`);
  const filePath = path.resolve(cwd, relativePath);
  const content = options.format === "json" ? renderNativeContextJson(snapshot) : renderNativeContextMarkdown(snapshot);
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, relativePath, format: options.format };
}
