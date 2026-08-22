import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyScaffold,
  createScaffoldPreview,
  formatScaffoldApplyResult,
  formatScaffoldPreview,
  resolveScaffoldProjectRoot,
  scaffoldCommand,
} from "../extensions/pi-commands/commands/scaffold.ts";

const root = new URL("..", import.meta.url).pathname;
const extensionKinds = ["tool", "command", "event", "shortcut", "flag", "provider", "widget", "footer", "overlay"] as const;

function createProject(): string {
  const project = mkdtempSync(join(tmpdir(), "gentic-scaffold-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module", pi: { extensions: ["./extensions"] } }));
  symlinkSync(join(root, "node_modules"), join(project, "node_modules"), "dir");
  return project;
}
function options(project: string) { return { projectRoot: project }; }
function allFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.name === "node_modules" && lstatSync(child).isSymbolicLink()) return [];
    return entry.isDirectory() ? allFiles(child) : [child];
  });
}

function registerScaffoldCommand(cwd: string) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  scaffoldCommand.register({ registerCommand(name: string, command: never) { commands.set(name, command); } } as never);
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    command: commands.get("scaffold")!,
    notifications,
    ctx: { cwd, ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } } },
  };
}

test("scaffold dry-run is complete and project-aware", () => {
  const project = createProject();
  try {
    const preview = createScaffoldPreview("extension", "demo-extension", "layered", "dry-run", options(project));
    const text = formatScaffoldPreview(preview);
    assert.equal(preview.files.length, 6);
    assert.match(text, /Project root:/);
    assert.match(text, /src\/domain\/types\.ts/);
    assert.ok(preview.files.every((file) => !file.renderedContent.includes("{{")));
    assert.equal(existsSync(join(project, "extensions/demo-extension")), false);
    assert.equal(resolveScaffoldProjectRoot(join(project, "nested/path")), project);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("scaffold previews every native variant including theme and contextual command defaults", async () => {
  const project = createProject();
  try {
    const variants = [
      ["extension", "minimal-extension", "minimal"], ["extension", "layered-extension", "layered"],
      ...extensionKinds.map((kind) => [kind, `${kind}-sample`, undefined]),
      ["skill", "simple-skill", "simple"], ["skill", "directory-skill", "directory"],
      ["prompt", "prompt-sample", undefined], ["theme", "theme-sample", undefined], ["primitive", "primitive-sample", undefined],
    ] as const;
    for (const [kind, name, variant] of variants) {
      const preview = createScaffoldPreview(kind, name, variant, "dry-run", options(project));
      assert.ok(preview.files.length > 0, `${kind} should have files`);
      assert.ok(preview.files.every((file) => file.target && !file.renderedContent.includes("{{")));
    }
    const harness = registerScaffoldCommand(project);
    await harness.command.handler("theme contextual-theme", harness.ctx);
    assert.match(harness.notifications[0]?.message ?? "", /Dry-run scaffold: theme contextual-theme/);
    assert.equal(existsSync(join(project, "themes/contextual-theme.json")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("scaffold refuses unsafe names, wrong roots, and overwrites", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gentic-not-project-"));
  const project = createProject();
  try {
    assert.throws(() => resolveScaffoldProjectRoot(outside), /Refusing scaffold outside a Pi project/);
    const harness = registerScaffoldCommand(project);
    await harness.command.handler("skill ../bad --simple", harness.ctx);
    assert.match(harness.notifications[0]?.message ?? "", /Invalid name/);
    applyScaffold("theme", "safe-theme", undefined, options(project));
    assert.throws(() => applyScaffold("theme", "safe-theme", undefined, options(project)), /Refusing to overwrite/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("layered scaffold transaction rolls back at every stage and commit step", () => {
  for (let failAtStep = 1; failAtStep <= 12; failAtStep += 1) {
    const project = createProject();
    try {
      assert.throws(
        () => applyScaffold("extension", "rollback-extension", "layered", { projectRoot: project, failAtStep }),
        /Scaffold transaction rolled back/,
      );
      assert.equal(existsSync(join(project, "extensions/rollback-extension")), false, `step ${failAtStep} left target files`);
      assert.equal(allFiles(project).some((path) => path.endsWith(".tmp")), false, `step ${failAtStep} left temp files`);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("every generated variant typechecks and native extensions smoke-load", async () => {
  const project = createProject();
  try {
    applyScaffold("extension", "minimal-extension", "minimal", options(project));
    applyScaffold("extension", "layered-extension", "layered", options(project));
    for (const kind of extensionKinds) applyScaffold(kind, `${kind}-sample`, undefined, options(project));
    applyScaffold("skill", "simple-skill", "simple", options(project));
    applyScaffold("skill", "directory-skill", "directory", options(project));
    applyScaffold("prompt", "prompt-sample", undefined, options(project));
    applyScaffold("theme", "theme-sample", undefined, options(project));

    writeFileSync(join(project, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, strict: true, skipLibCheck: true, noEmit: true },
      include: ["extensions/**/*.ts"],
    }));
    const typecheck = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc")], { cwd: project, encoding: "utf8" });
    assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);

    const registrations: string[] = [];
    const pi = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { registrations.push(String(key)); return args[1]; } });
    for (const directory of readdirSync(join(project, "extensions"))) {
      const entry = join(project, "extensions", directory, "index.ts");
      if (!existsSync(entry)) continue;
      const module = await import(`${pathToFileURL(entry).href}?smoke=${directory}`) as { default?: (api: unknown) => void };
      assert.equal(typeof module.default, "function", `${directory} should export a factory`);
      module.default?.(pi);
    }
    assert.ok(registrations.includes("registerTool"));
    assert.ok(registrations.includes("registerProvider"));

    const theme = JSON.parse(readFileSync(join(project, "themes/theme-sample.json"), "utf8"));
    assert.equal(theme.name, "theme-sample");
    assert.ok(Object.keys(theme.colors).length >= 50);
    assert.match(formatScaffoldApplyResult(applyScaffold("prompt", "second-prompt", undefined, options(project))), /Applied scaffold/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
