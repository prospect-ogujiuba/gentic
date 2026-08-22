import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { catalogText, capabilitiesText } from "../extensions/pi-catalog/src/app/catalog.ts";
import { PI_CONTRACT_SOURCE, PI_NATIVE_CAPABILITY_GROUPS } from "../src/pi-contract.ts";

const root = new URL("..", import.meta.url).pathname;

test("version-stamped catalog matches its generated pinned fixture", () => {
  const fixture = JSON.parse(readFileSync(`${root}/catalog/pi-native-capabilities.json`, "utf8"));
  assert.deepEqual(fixture.source, PI_CONTRACT_SOURCE);
  assert.deepEqual(fixture.capabilityGroups, PI_NATIVE_CAPABILITY_GROUPS);
  assert.match(catalogText(), new RegExp(PI_CONTRACT_SOURCE.version.replaceAll(".", "\\.")));
  assert.match(catalogText(), /dist\/core\/extensions\/types\.d\.ts/);
});

test("catalog includes every Phase 6 native capability group", () => {
  for (const group of ["commands", "tools", "events", "shortcuts", "flags", "providers", "renderers", "markdown-transformers", "ui-surfaces"] as const) {
    assert.ok(group in PI_NATIVE_CAPABILITY_GROUPS);
    assert.match(capabilitiesText(group), new RegExp(`^${group}:`));
  }
});
