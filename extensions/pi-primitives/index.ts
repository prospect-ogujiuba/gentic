import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type PrimitiveContext = {
  name: string;
  dir: string;
  path(path: string): string;
  readText(path: string): string;
};

export type Primitive = (pi: ExtensionAPI, ctx: PrimitiveContext) => void | Promise<void>;

const ROOT = new URL(".", import.meta.url).pathname;
const PRIMITIVES_DIR = join(ROOT, "primitives");

function primitivePath(dir: string, path: string): string {
  const resolved = resolve(dir, path);
  const rel = relative(dir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Primitive path escapes primitive directory: ${path}`);
  }
  return resolved;
}

async function loadPrimitive(pi: ExtensionAPI, name: string): Promise<void> {
  const dir = join(PRIMITIVES_DIR, name);
  const entrypoint = join(dir, "index.ts");
  if (!existsSync(entrypoint)) return;

  const mod = (await import(pathToFileURL(entrypoint).href)) as { default?: Primitive };
  if (typeof mod.default !== "function") return;

  await mod.default(pi, {
    name,
    dir,
    path(path) {
      return primitivePath(dir, path);
    },
    readText(path) {
      return readFileSync(primitivePath(dir, path), "utf8");
    },
  });
}

/**
 * Primitives are discovered from self-contained directories under primitives/.
 * Each primitive owns an index.ts entrypoint and may carry supporting markdown,
 * scripts, config, or helper files beside it. This extension is the host for
 * small reusable Gentic runtime building blocks that do not need dedicated
 * top-level extensions.
 */
export default async function piPrimitives(pi: ExtensionAPI): Promise<void> {
  if (!existsSync(PRIMITIVES_DIR)) return;

  const primitiveNames = readdirSync(PRIMITIVES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const name of primitiveNames) {
    await loadPrimitive(pi, name);
  }
}
