import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PI_PACKAGE_RESOURCE_KEYS, type PiPackageResourceKey } from "../../../../src/pi-contract.ts";

export type PackageJson = {
  name?: string;
  version?: string;
  pi?: Partial<Record<PiPackageResourceKey, string[]>> & Record<string, string[] | undefined>;
};

const RESOURCE_KEYS = [...PI_PACKAGE_RESOURCE_KEYS];
const MAX_PACKAGE_FIELD_LENGTH = 128;

function normalizeField(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_PACKAGE_FIELD_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_PACKAGE_FIELD_LENGTH - 1)}…`;
}

export function readPackageJson(root: string): PackageJson {
  const path = join(root, "package.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

export function formatPackageSummary(pkg: PackageJson): string {
  const resources = RESOURCE_KEYS
    .map((key) => {
      const values = pkg.pi?.[key];
      return Array.isArray(values) ? `${key}: ${values.length}` : undefined;
    })
    .filter(Boolean)
    .join(" • ");

  const name = normalizeField(pkg.name, "gentic");
  const version = normalizeField(pkg.version, "unknown");
  return `${name}@${version}\n${resources || "no pi resources declared"}`;
}

export function packageSummary(root: string): string {
  return formatPackageSummary(readPackageJson(root));
}
