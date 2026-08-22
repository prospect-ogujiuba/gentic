import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("contributor clean-checkout and release commands resolve to package scripts", () => {
  const contributing = read("CONTRIBUTING.md");
  const packageJson = JSON.parse(read("package.json")) as { private: boolean; scripts: Record<string, string> };
  for (const script of ["typecheck", "check", "check:commands", "check:performance", "test", "release:verify", "pi:update"]) {
    assert.ok(packageJson.scripts[script], `missing npm script ${script}`);
    assert.match(contributing, new RegExp(`npm (?:run )?${script.replaceAll(":", "\\:")}`));
  }
  assert.equal(packageJson.private, true);
  assert.doesNotMatch(read("README.md"), /pi install(?: -l)? npm:gentic/);
});

test("plugin guide documents every supported scaffold kind and truthful anatomy policy", () => {
  const guide = read("docs/plugin-guide.md");
  for (const kind of ["extension", "tool", "command", "event", "shortcut", "flag", "provider", "widget", "footer", "overlay", "skill", "prompt", "theme", "primitive"]) {
    assert.match(guide, new RegExp(`/scaffold ${kind} `));
  }
  for (const entry of readdirSync(join(root, "extensions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const path = join(root, "extensions", entry.name, "README.md");
    const content = readFileSync(path, "utf8");
    const declarationLine = content.split(/\r?\n/).find((line) => line.includes("Machine declaration:"));
    if (declarationLine) assert.match(declarationLine, /optional handwritten/);
  }
});
