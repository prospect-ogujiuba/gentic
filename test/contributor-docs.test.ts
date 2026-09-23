import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("model artifact versioning tracks authority selectively and ignores runtime logs", () => {
  const policy = read("docs/model-artifacts.md");
  const ignore = read(".gitignore");
  assert.match(policy, /workflow\.json.*Track for substantial or shared initiatives/i);
  for (const kind of ["specs/", "plans/", "findings/", "reports/", "todo/", "logs/"]) assert.match(policy, new RegExp(kind.replace("/", "\\/")));
  assert.match(policy, /Never use `git add \.model-artifacts`/);
  assert.match(ignore, /^\/\.model-artifacts\/initiatives\/\*\/logs\/$/m);
  assert.match(ignore, /^\/\.model-artifacts\/system\/logs\/$/m);

  const ignored = (path: string) => spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], { cwd: root }).status === 0;
  assert.equal(ignored(".model-artifacts/initiatives/demo/logs/2026-05-01_1200-runtime.md"), true);
  assert.equal(ignored(".model-artifacts/system/logs/runtime/2026-05-01_1200-session.md"), true);
  for (const path of [
    ".model-artifacts/initiatives/demo/workflow.json",
    ".model-artifacts/initiatives/demo/specs/2026-05-01_1200-spec.md",
    ".model-artifacts/initiatives/demo/plans/2026-05-01_1200-plan.md",
    ".model-artifacts/initiatives/demo/findings/2026-05-01_1200-finding.md",
    ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-report.md",
  ]) assert.equal(ignored(path), false, `${path} must remain selectively trackable`);
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
