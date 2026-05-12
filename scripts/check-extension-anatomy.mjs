#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionsRoot = join(root, "extensions");
const resourceScanners = {
  skills: (dir) => countFiles(dir, (name) => name === "SKILL.md"),
  prompts: (dir) => countFiles(dir, (name) => extname(name) === ".md"),
  themes: (dir) => countFiles(dir, (name) => extname(name) === ".json"),
};

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function countFiles(dir, predicate) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(path, predicate);
    else if (entry.isFile() && predicate(entry.name)) count += 1;
  }
  return count;
}

function collectSourceText(dir) {
  let text = "";
  if (!existsSync(dir)) return text;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += collectSourceText(path);
    else if (entry.isFile() && [".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name))) text += `\n${safeRead(path)}`;
  }
  return text;
}

function srcLayers(dir) {
  const src = join(dir, "src");
  if (!existsSync(src)) return "none";
  const entries = readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length) return "empty";
  const layers = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  return layers.join(",");
}

function discoveredResources(dir) {
  const resources = ["extension"];
  for (const [name, scanner] of Object.entries(resourceScanners)) {
    const count = scanner(join(dir, name));
    if (count) resources.push(`${name}:${count}`);
  }
  const schemas = countFiles(dir, (name) => name.endsWith(".schema.json"));
  if (schemas) resources.push(`schemas:${schemas}`);
  return resources.join(",");
}

function hasDeclaration(indexText) {
  return /export\s+default\s+(async\s+)?function\s+\w+\s*\(\s*\w+\s*:\s*ExtensionAPI/.test(indexText);
}

function classifyMode(extensionText, resources) {
  if (/\bpi\.(registerTool|registerCommand|on|registerWidget|sendUserMessage)\b|\bctx\.ui\.setStatus\b/.test(extensionText)) return "runtime";
  if (/\bregisterPi[A-Z]\w*\s*\(/.test(extensionText)) return "runtime-delegated";
  if (/\bskills:\d+\b|\bprompts:\d+\b|\bthemes:\d+\b/.test(resources)) return "resource-hub";
  return "declared";
}

function extensionRows() {
  if (!existsSync(extensionsRoot)) return [];
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(extensionsRoot, entry.name);
      const indexPath = join(dir, "index.ts");
      const indexText = safeRead(indexPath);
      const allText = `${indexText}\n${collectSourceText(join(dir, "src"))}`;
      const resources = discoveredResources(dir);
      return {
        name: entry.name,
        readme: existsSync(join(dir, "README.md")) ? "yes" : "no",
        declaration: hasDeclaration(indexText) ? "yes" : "no",
        mode: classifyMode(allText, resources),
        indexLines: countLines(indexText),
        src: srcLayers(dir),
        resources,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

try {
  const rows = extensionRows();
  console.log(`check-extension-anatomy: report-only (${rows.length} extensions)`);
  console.log("check-extension-anatomy: rules=report-only; gaps are warnings, never failures");
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(13)} readme=${row.readme.padEnd(3)} decl=${row.declaration.padEnd(3)} mode=${row.mode.padEnd(17)} index=${String(row.indexLines).padStart(3)} src=${row.src} resources=${row.resources}`,
    );
  }
} catch (error) {
  console.log(`check-extension-anatomy: report-only warning: ${error instanceof Error ? error.message : String(error)}`);
}
