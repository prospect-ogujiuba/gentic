import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyScaffold,
  completeScaffoldArgument,
  createScaffoldPreview,
  formatScaffoldApplyResult,
  formatScaffoldPreview,
  resolveScaffoldProjectRoot,
  scaffoldCommand,
} from "../extensions/pi-commands/commands/scaffold.ts";

import { createScaffoldPlan, parseScaffoldArgs } from "../extensions/pi-commands/scaffold/planning.ts";
import { renderScaffoldPlan } from "../extensions/pi-commands/scaffold/rendering.ts";
import { applyScaffoldPreview } from "../extensions/pi-commands/scaffold/application.ts";

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

const goldenVariants = [
  ["extension", "minimal"], ["extension", "layered"],
  ...extensionKinds.map((kind) => [kind, undefined] as const),
  ["skill", "simple"], ["skill", "directory"],
  ["prompt", undefined], ["theme", undefined], ["primitive", undefined],
] as const;

test("all scaffold variants preserve golden previews and applied bytes", () => {
  const golden = JSON.parse(readFileSync(new URL("fixtures/scaffold-golden.json", import.meta.url), "utf8"));
  for (const [kind, variant] of goldenVariants) {
    const project = createProject();
    try {
      const preview = createScaffoldPreview(kind, "sample-2-name", variant, "dry-run", options(project));
      const key = `${kind}/${variant ?? "default"}`;
      assert.deepEqual({ ...preview, projectRoot: "<project>" }, { ...golden[key].preview, variant }, key);
      assert.equal(formatScaffoldPreview(preview).replace(project, "<project>"), golden[key].text, key);
      const result = applyScaffold(kind, "sample-2-name", variant, options(project));
      assert.deepEqual(result.createdPaths, preview.files.map((file) => file.target));
      assert.deepEqual(result.updatedPaths, []);
      for (const file of preview.files) assert.equal(readFileSync(join(project, file.target), "utf8"), file.renderedContent);
      assert.throws(() => applyScaffold(kind, "sample-2-name", variant, options(project)), /Refusing to overwrite/);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("all variants roll back every staging and commit checkpoint", () => {
  for (const [kind, variant] of goldenVariants) {
    const project = createProject();
    try {
      const count = createScaffoldPreview(kind, "rollback-2-name", variant, "dry-run", options(project)).files.length;
      for (let failAtStep = 1; failAtStep <= count * 2; failAtStep++) {
        assert.throws(() => applyScaffold(kind, "rollback-2-name", variant, { projectRoot: project, failAtStep }), /Scaffold transaction rolled back/);
        assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package.json"], `${kind} step ${failAtStep}`);
      }
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("scaffold parsing and completion compatibility", async () => {
  const project = createProject();
  try {
    for (const [args, message] of [
      ["", /Usage:/], ["unknown name", /Unknown scaffold kind/], ["theme", /Missing scaffold name/],
      ["theme a --wat", /Unknown scaffold flag/], ["theme a --apply --dry-run", /Choose one scaffold mode/],
      ["extension a --minimal --layered", /Choose one scaffold variant/],
      ["extension a --directory", /Extension scaffolds support/], ["skill a --minimal", /Skill scaffolds support/],
      ["theme a --simple", /do not support/],
      ...["../bad", "a--b", "A", "a-", "2a", "a/b", "a_b"].map((name) => [`theme ${name}`, /Invalid name/] as const),
    ] as const) {
      const harness = registerScaffoldCommand(project);
      await harness.command.handler(args, harness.ctx);
      assert.match(harness.notifications[0].message, message);
      assert.equal(harness.notifications[0].type, "warning");
    }
    const harness = registerScaffoldCommand(project);
    await harness.command.handler("extension a --simple", harness.ctx);
    assert.match(harness.notifications[0].message, /extension a minimal/);
    assert.deepEqual(completeScaffoldArgument("").map((item) => item.label), ["extension", ...extensionKinds, "skill", "prompt", "theme", "primitive"]);
    assert.deepEqual(completeScaffoldArgument("theme a"), []);
    assert.deepEqual(completeScaffoldArgument("extension a --minimal ").map((item) => item.label), ["--dry-run", "--apply"]);
    assert.deepEqual(completeScaffoldArgument("skill a --directory --apply "), []);
    assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package.json"]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("planning, rendering, and application compose without early writes", () => {
  const project = createProject();
  try {
    assert.deepEqual(parseScaffoldArgs("extension sample --simple"), { ok: true, kind: "extension", name: "sample", variant: "minimal", mode: "dry-run" });
    for (const [kind, variant] of goldenVariants) {
      const plan = createScaffoldPlan(kind, "composed-name", variant, "apply", options(project));
      assert.ok(plan.files.every((file) => !("renderedContent" in file)));
      const preview = renderScaffoldPlan(plan);
      assert.deepEqual(preview, createScaffoldPreview(kind, "composed-name", variant, "apply", options(project)));
      assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package.json"]);
      const result = applyScaffoldPreview(preview);
      for (const file of preview.files) assert.equal(readFileSync(join(project, file.target), "utf8"), file.renderedContent);
      assert.deepEqual(result.createdPaths, preview.files.map((file) => file.target));
      for (const directory of ["extensions", "skills", "themes", "prompts"]) rmSync(join(project, directory), { recursive: true, force: true });
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("rendering rejects escaping template plans and unresolved placeholders", () => {
  const plan = createScaffoldPlan("theme", "safe-name");
  for (const template of ["../../package.json", join(root, "package.json")]) {
    assert.throws(() => renderScaffoldPlan({ ...plan, files: [{ ...plan.files[0], template }] }), /escapes template root/);
  }
  assert.throws(() => renderScaffoldPlan({ ...plan, name: "{{unresolved}}" }), /Unresolved placeholder/);
});

test("transaction module rejects duplicate and normalized-alias targets before staging", () => {
  const project = createProject();
  try {
    const preview = createScaffoldPreview("theme", "safe-name", undefined, "apply", options(project));
    for (const target of ["themes/safe-name.json", "themes/./safe-name.json", "themes//safe-name.json"]) {
      const duplicate = { ...preview, files: [...preview.files, { ...preview.files[0], target }] };
      assert.throws(() => applyScaffoldPreview(duplicate), /Duplicate scaffold target/);
      assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package.json"]);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("transaction module rejects escaping targets without writes", () => {
  const project = createProject();
  try {
    const preview = createScaffoldPreview("theme", "safe-name", undefined, "apply", options(project));
    for (const target of ["../escape.json", "/tmp/escape.json"]) {
      assert.throws(() => applyScaffoldPreview({ ...preview, files: [{ ...preview.files[0], target }] }), /Unsafe scaffold target/);
    }
    writeFileSync(join(project, "themes"), "existing non-directory");
    assert.throws(() => applyScaffoldPreview(preview), /non-directory ancestor/);
    assert.equal(readFileSync(join(project, "themes"), "utf8"), "existing non-directory");
    assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package.json", "themes"]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

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

test("primitive scaffold keeps its paths and bounded helpers with a native entrypoint", async () => {
  const project = createProject();
  try {
    const preview = createScaffoldPreview("primitive", "review-helper", undefined, "dry-run", options(project));
    assert.deepEqual(preview.files.map((file) => file.target), [
      "extensions/pi-primitives/primitives/review-helper/index.ts",
      "extensions/pi-primitives/primitives/review-helper/injection.md",
      "extensions/pi-primitives/primitives/review-helper/triggers.json",
    ]);
    const entry = preview.files.find((file) => file.target.endsWith("index.ts"))!.renderedContent;
    assert.match(entry, /parsePrimitiveTriggers/);
    assert.match(entry, /matchesPrimitivePrompt/);
    assert.match(entry, /promptPolicy/);
    assert.doesNotMatch(entry, /PrimitiveContext|EXPLICIT_PRIMITIVES/);
    assert.match(entry, /Primitive\(pi: ExtensionAPI\)/);
    const triggers = JSON.parse(preview.files.find((file) => file.target.endsWith("triggers.json"))!.renderedContent);
    assert.doesNotThrow(() => triggers.pathPatterns.forEach((pattern: string) => new RegExp(pattern, "i")));

    const result = applyScaffold("primitive", "review-helper", undefined, options(project));
    assert.match(formatScaffoldApplyResult(result), /native Pi extension settings or --extension/);
    for (const helper of ["prompt-policy.ts", "prompt-input.ts", "triggers.ts"]) {
      writeFileSync(join(project, "extensions/pi-primitives", helper), readFileSync(join(root, "extensions/pi-primitives", helper)));
    }
    const native = await import(pathToFileURL(join(project, result.createdPaths[0]!)).href);
    const handlers: Array<(event: { prompt: string; systemPrompt: string }) => { systemPrompt: string } | undefined> = [];
    native.default({ on(name: string, handler: typeof handlers[number]) {
      assert.equal(name, "before_agent_start"); handlers.push(handler);
    } });
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0]!({ prompt: "unrelated", systemPrompt: "BASE" }), undefined);
    const applied = handlers[0]!({ prompt: "review-helper", systemPrompt: "BASE" })!;
    assert.match(applied.systemPrompt, /# review-helper/);
    assert.equal(handlers[0]!({ prompt: "review-helper", systemPrompt: applied.systemPrompt }), undefined);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("scaffold refuses unsafe names, wrong roots, and overwrites", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gentic-not-project-"));
  const project = createProject();
  try {
    assert.throws(() => resolveScaffoldProjectRoot(outside), /Refusing scaffold outside a Pi project/);
    assert.throws(() => createScaffoldPreview("primitive", "123", undefined, "dry-run", options(project)), /starting with a letter/);
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

test("scaffold apply rejects symlinked target ancestors without external writes", () => {
  const project = createProject();
  const outside = mkdtempSync(join(tmpdir(), "gentic-scaffold-outside-"));
  try {
    symlinkSync(outside, join(project, "extensions"), "dir");
    assert.throws(
      () => applyScaffold("extension", "escaped-extension", "minimal", options(project)),
      /symlink|escapes project root/i,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
