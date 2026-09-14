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

function ensureSafeReportDirectory(root: string): string {
  let current = root;
  for (const segment of REPORT_SEGMENTS) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("pi-context export containment rejected an unsafe report directory");
    }
    const resolved = fs.realpathSync(current);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("pi-context export containment rejected an escaping report directory");
    }
  }
  return current;
}

export function writeNativeContextExport(
  snapshot: NativeContextSnapshot,
  options: NativeContextExportOptions,
): NativeContextExportArtifact {
  const cwd = options.cwd ?? process.cwd();
  const root = fs.realpathSync(path.resolve(cwd));
  const dir = ensureSafeReportDirectory(root);
  const extension = options.format === "json" ? "json" : "md";
  const capturedAt = new Date(sanitizeNativeContextSnapshot(snapshot).capturedAt).toISOString();
  const timestamp = `${capturedAt.slice(0, 10)}_${capturedAt.slice(11, 16).replace(":", "")}`;
  const uniqueSuffix = capturedAt.slice(17, 23).replace(".", "-");
  const filename = `${timestamp}-pi-context-${uniqueSuffix}.${extension}`;
  const relativePath = path.join(REPORT_DIR, filename);
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) throw new Error("pi-context export destination already exists or is unsafe");
  const content = options.format === "json" ? renderNativeContextJson(snapshot) : renderNativeContextMarkdown(snapshot);
  fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx" });
  return { path: filePath, relativePath, format: options.format };
}
