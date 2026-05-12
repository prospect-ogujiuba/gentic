import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PI_PACKAGE_RESOURCE_KEYS, type PiPackageResourceKey } from "../../../src/pi-contract.ts";

export type PackageJson = {
  name?: string;
  version?: string;
  pi?: Partial<Record<PiPackageResourceKey, string[]>> & Record<string, string[] | undefined>;
};

const RESOURCE_KEYS = [...PI_PACKAGE_RESOURCE_KEYS];

export function readPackageJson(root: string): PackageJson {
  const path = join(root, "package.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

export function formatPackageSummary(pkg: PackageJson): string {
  const resourceKeys = [
    ...RESOURCE_KEYS,
    ...Object.keys(pkg.pi || {}).filter((key) => !RESOURCE_KEYS.includes(key as PiPackageResourceKey)),
  ];
  const resources = resourceKeys
    .map((key) => {
      const values = pkg.pi?.[key];
      return Array.isArray(values) ? `${key}: ${values.length}` : undefined;
    })
    .filter(Boolean)
    .join(" • ");

  return `${pkg.name || "gentic"}@${pkg.version || "unknown"}\n${resources || "no pi resources declared"}`;
}

export function packageSummary(root: string): string {
  return formatPackageSummary(readPackageJson(root));
}
