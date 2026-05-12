import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createScaffoldPreview, formatScaffoldPreview, scaffoldCommand } from "../extensions/pi-commands/commands/scaffold.ts";

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

test("/scaffold command rejects unsafe names and missing dry-run clearly", async () => {
  const command = registerScaffoldCommand();

  const invalid = createNotifyContext();
  await command.handler("skill ../bad --simple --dry-run", invalid.ctx);
  assert.equal(invalid.notifications[0]?.type, "warning");
  assert.match(invalid.notifications[0]?.message ?? "", /Invalid name/);

  const missingDryRun = createNotifyContext();
  await command.handler("prompt demo-prompt", missingDryRun.ctx);
  assert.equal(missingDryRun.notifications[0]?.type, "warning");
  assert.match(missingDryRun.notifications[0]?.message ?? "", /Only dry-run scaffolds are supported/);
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
