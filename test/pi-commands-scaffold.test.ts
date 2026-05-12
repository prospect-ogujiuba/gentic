import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  applyScaffold,
  createScaffoldPreview,
  formatScaffoldApplyResult,
  formatScaffoldPreview,
  scaffoldCommand,
} from "../extensions/pi-commands/commands/scaffold.ts";

const root = new URL("..", import.meta.url).pathname;

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: { ui: { notify: (message: string, type?: string) => void } }) => Promise<void> | void;
};

function registerScaffoldCommand() {
  const commands = new Map<string, RegisteredCommand>();
  scaffoldCommand.register({
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
  } as never);
  return commands.get("scaffold")!;
}

function createNotifyContext() {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    ctx: {
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
      },
    },
  };
}

test("scaffold preview renders extension targets without writing files", () => {
  const target = `${root}/extensions/phase-six-test-extension`;
  assert.equal(existsSync(target), false, "test fixture target should not already exist");

  const preview = createScaffoldPreview("extension", "phase-six-test-extension", "simple");
  const text = formatScaffoldPreview(preview);

  assert.equal(existsSync(target), false, "dry-run preview must not create target directory");
  assert.match(text, /Dry-run scaffold: extension phase-six-test-extension simple/);
  assert.match(text, /No files written\./);
  assert.match(text, /extensions\/phase-six-test-extension\/README\.md/);
  assert.match(text, /extensions\/phase-six-test-extension\/index\.ts/);
  assert.match(text, /extensions\/phase-six-test-extension\/extension\.anatomy\.json/);
  assert.ok(preview.files.every((file) => !file.renderedContent.includes("{{")), "placeholders should be rendered");
});

test("scaffold preview supports command skill prompt and primitive target paths", () => {
  assert.deepEqual(
    createScaffoldPreview("command", "demo-command").files.map((file) => file.target),
    ["extensions/pi-commands/commands/demo-command.ts", "extensions/pi-commands/commands/index.ts"],
  );
  assert.deepEqual(
    createScaffoldPreview("skill", "demo-skill", "directory").files.map((file) => file.target),
    ["extensions/pi-skills/skills/demo-skill/SKILL.md"],
  );
  assert.deepEqual(
    createScaffoldPreview("prompt", "demo-prompt").files.map((file) => file.target),
    ["extensions/pi-prompts/prompts/demo-prompt.md"],
  );
  assert.deepEqual(
    createScaffoldPreview("primitive", "demo-primitive").files.map((file) => file.target),
    [
      "extensions/pi-primitives/primitives/demo-primitive/index.ts",
      "extensions/pi-primitives/primitives/demo-primitive/supporting-file.md",
      "extensions/pi-primitives/primitives/demo-primitive/triggers.json",
    ],
  );
});

test("/scaffold command rejects unsafe names and defaults to safe dry-run", async () => {
  const command = registerScaffoldCommand();

  const invalid = createNotifyContext();
  await command.handler("skill ../bad --simple --dry-run", invalid.ctx);
  assert.equal(invalid.notifications[0]?.type, "warning");
  assert.match(invalid.notifications[0]?.message ?? "", /Invalid name/);

  const defaultPreview = createNotifyContext();
  await command.handler("prompt phase-eight-handler-prompt", defaultPreview.ctx);
  assert.equal(defaultPreview.notifications[0]?.type, "info");
  assert.match(defaultPreview.notifications[0]?.message ?? "", /Dry-run scaffold: prompt phase-eight-handler-prompt/);
  assert.match(defaultPreview.notifications[0]?.message ?? "", /No files written\./);
  assert.equal(existsSync(`${root}/extensions/pi-prompts/prompts/phase-eight-handler-prompt.md`), false);
});

test("/scaffold command emits concise dry-run output", async () => {
  const command = registerScaffoldCommand();
  const { ctx, notifications } = createNotifyContext();

  await command.handler("skill demo-skill --simple --dry-run", ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "info");
  assert.match(notifications[0]?.message ?? "", /Dry-run scaffold: skill demo-skill simple/);
  assert.match(notifications[0]?.message ?? "", /No files written\./);
  assert.match(notifications[0]?.message ?? "", /extensions\/pi-skills\/skills\/demo-skill\/SKILL\.md/);
});

test("scaffold apply writes extension files and refuses overwrites", () => {
  const targetDir = `${root}/extensions/phase-eight-test-extension`;
  rmSync(targetDir, { recursive: true, force: true });

  try {
    const result = applyScaffold("extension", "phase-eight-test-extension", "simple");
    const text = formatScaffoldApplyResult(result);

    assert.deepEqual(result.createdPaths, [
      "extensions/phase-eight-test-extension/README.md",
      "extensions/phase-eight-test-extension/index.ts",
      "extensions/phase-eight-test-extension/extension.anatomy.json",
    ]);
    assert.match(text, /Applied scaffold: extension phase-eight-test-extension simple/);
    assert.match(text, /- created extensions\/phase-eight-test-extension\/extension\.anatomy\.json/);
    assert.equal(existsSync(`${targetDir}/extension.anatomy.json`), true);
    assert.throws(() => applyScaffold("extension", "phase-eight-test-extension", "simple"), /Refusing to overwrite/);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("scaffold apply creates command files and updates command barrel deterministically", () => {
  const commandName = "phase-eight-test-command";
  const commandPath = `${root}/extensions/pi-commands/commands/${commandName}.ts`;
  const indexPath = `${root}/extensions/pi-commands/commands/index.ts`;
  const originalIndex = readFileSync(indexPath, "utf8");
  rmSync(commandPath, { force: true });

  try {
    const result = applyScaffold("command", commandName);
    const text = formatScaffoldApplyResult(result);
    const updatedIndex = readFileSync(indexPath, "utf8");

    assert.deepEqual(result.createdPaths, [`extensions/pi-commands/commands/${commandName}.ts`]);
    assert.deepEqual(result.updatedPaths, ["extensions/pi-commands/commands/index.ts"]);
    assert.match(text, /- created extensions\/pi-commands\/commands\/phase-eight-test-command\.ts/);
    assert.match(text, /- updated extensions\/pi-commands\/commands\/index\.ts/);
    assert.equal(existsSync(commandPath), true);
    assert.match(updatedIndex, /import \{ phaseEightTestCommandCommand \} from "\.\/phase-eight-test-command\.ts";/);
    assert.match(updatedIndex, /phaseEightTestCommandCommand/);
    assert.throws(() => applyScaffold("command", commandName), /Refusing to overwrite/);
  } finally {
    rmSync(commandPath, { force: true });
    writeFileSync(indexPath, originalIndex);
  }
});
