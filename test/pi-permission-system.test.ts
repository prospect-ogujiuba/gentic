import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const extensionPath = "./node_modules/@gotgenes/pi-permission-system/src/index.ts";

function json(path: string): any {
  return JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
}

test("Gentic bundles pi-permission-system as its permission extension", () => {
  const pkg = json("package.json");
  assert.equal(typeof pkg.dependencies["@gotgenes/pi-permission-system"], "string");
  assert.ok(pkg.bundledDependencies.includes("@gotgenes/pi-permission-system"));
  assert.ok(pkg.pi.extensions.includes(extensionPath));
  assert.equal(pkg.pi.extensions.includes("./extensions/pi-gate/index.ts"), false);

  for (const profileName of ["core", "full"]) {
    const profile = json(`profiles/${profileName}.json`);
    assert.ok(profile.package.extensions.includes(`+${extensionPath.slice(2)}`));
    assert.ok(profile.package.extensions.includes("+extensions/pi-permission-bridge/index.ts"));
    assert.equal(profile.package.extensions.includes("+extensions/pi-gate/index.ts"), false);
  }
});

test("replacement policy preserves Gentic's critical path and shell safeguards", () => {
  const config = json("config/pi-permission-system.json");
  assert.equal(config.permissionReviewLog, true);
  assert.equal(config.yoloMode, false);
  assert.equal(config.permission.external_directory, "allow");
  assert.equal(config.permission.path_read, "allow");
  assert.equal(config.permission.path_write["*"], "allow");
  assert.equal(config.permission.path_write["*/.env"], "deny");
  assert.equal(config.permission.path_write["*/.git/*"], "deny");
  assert.equal(config.permission.bash["*"], "ask");
  assert.equal(config.permission.bash["rm -rf /"], "deny");
  assert.equal(config.permission.bash["rm --force --recursive /"], "deny");
});
