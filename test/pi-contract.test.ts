import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PI_CONTRACT_SCHEMA_VERSION,
  PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY,
  PI_EXTENSION_EVENT_GROUPS,
  PI_EXTENSION_EVENTS,
  PI_EXTENSION_RESOURCE_DISCOVERY_EVENT,
  PI_PACKAGE_MANIFEST_KEY,
  PI_PACKAGE_RESOURCE_KEYS,
  PI_PACKAGE_RESOURCE_VOCABULARY,
  PI_PACKAGE_SURFACE_IDS,
  PI_PACKAGE_SURFACES,
  SCHEMA_VERSION,
} from "../src/pi-contract.ts";

const root = new URL("..", import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));

test("pi contract names the package surface and resource vocabulary", () => {
  assert.equal(SCHEMA_VERSION, PI_CONTRACT_SCHEMA_VERSION);
  assert.equal(PI_CONTRACT_SCHEMA_VERSION_DETAIL_KEY, "schemaVersion");
  assert.equal(PI_PACKAGE_MANIFEST_KEY, "pi");

  assert.deepEqual(PI_PACKAGE_SURFACES.map((surface) => surface.id), [...PI_PACKAGE_SURFACE_IDS]);
  assert.equal(new Set(PI_PACKAGE_SURFACES.map((surface) => surface.id)).size, PI_PACKAGE_SURFACES.length);

  for (const key of PI_PACKAGE_RESOURCE_KEYS) {
    assert.ok(Array.isArray(packageJson.pi?.[key]), `package.json#pi.${key} must be discoverable`);
  }

  for (const resource of Object.values(PI_PACKAGE_RESOURCE_VOCABULARY)) {
    const surface = PI_PACKAGE_SURFACES.find((candidate) => candidate.id === resource.surfaceId);
    assert.ok(surface, `missing surface ${resource.surfaceId}`);
    assert.equal(surface.manifestKey, resource.manifestKey);
    assert.equal(surface.directory, resource.directory);
    assert.equal(packageJson.pi?.[resource.manifestKey]?.some((pattern: string) => pattern.includes(resource.directory)), true);
  }
});

test("pi contract names extension events by lifecycle group", () => {
  assert.equal(PI_EXTENSION_RESOURCE_DISCOVERY_EVENT, "resources_discover");
  assert.deepEqual(PI_EXTENSION_EVENT_GROUPS.resource, [PI_EXTENSION_RESOURCE_DISCOVERY_EVENT]);
  assert.equal(PI_EXTENSION_EVENTS.includes("tool_call"), true);
  assert.equal(PI_EXTENSION_EVENTS.includes("tool_result"), true);
  assert.equal(PI_EXTENSION_EVENTS.includes(PI_EXTENSION_RESOURCE_DISCOVERY_EVENT), true);
});
