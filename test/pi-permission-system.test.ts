import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const extensionPath = "./node_modules/@gotgenes/pi-permission-system/src/index.ts";

function json(path: string): any {
  return JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
}

test("Gentic leaves pi-permission-system to a separate npm Pi package", () => {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  assert.equal(pkg.dependencies["@gotgenes/pi-permission-system"], undefined);
  assert.equal(pkg.bundledDependencies, undefined);
  assert.equal(pkg.bundleDependencies, undefined);
  assert.equal(lock.packages[""].dependencies["@gotgenes/pi-permission-system"], undefined);
  assert.equal(lock.packages["node_modules/@gotgenes/pi-permission-system"], undefined);
  assert.equal(pkg.pi.extensions.includes(extensionPath), false);
  assert.equal(pkg.pi.extensions.includes("./extensions/pi-gate/index.ts"), false);

  for (const profileName of ["core", "full"]) {
    const profile = json(`profiles/${profileName}.json`);
    assert.equal(profile.package.extensions.includes(`+${extensionPath.slice(2)}`), false);
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
