import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DISCOVERY_COMMAND_COMPLETIONS,
  DISCOVERY_COMMAND_USAGE,
  DISCOVERY_CONTRACT,
} from "../extensions/pi-catalog/src/app/discovery-contract.ts";
import { formatPackageSummary } from "../extensions/pi-catalog/src/app/package-summary.ts";
import {
  discoveryMatchDetails,
  discoverySearchText,
  MAX_DISCOVERY_MATCHES_PER_KIND,
  searchDiscovery,
  type DiscoverySnapshot,
} from "../extensions/pi-catalog/src/app/runtime-discovery.ts";
import { PI_CONTRACT_SOURCE, PI_NATIVE_CAPABILITY_GROUPS } from "../src/pi-contract.ts";

const root = new URL("..", import.meta.url).pathname;

test("consolidated discovery contract has one direct, runtime-backed surface", () => {
  assert.equal(DISCOVERY_CONTRACT.command, "catalog");
  assert.equal(DISCOVERY_CONTRACT.tool, "gentic_catalog");
  assert.equal(DISCOVERY_CONTRACT.defaultOperation, "status");
  assert.deepEqual(DISCOVERY_CONTRACT.operations, ["status", "search"]);
  assert.deepEqual(DISCOVERY_CONTRACT.runtimeSources, ["pi.getCommands()", "pi.getAllTools()", "sourceInfo"]);
  assert.equal(DISCOVERY_CONTRACT.proxiesCommands, false);
  assert.equal(DISCOVERY_CONTRACT.readsGeneratedFixtures, false);
  assert.equal(DISCOVERY_COMMAND_USAGE, "/catalog [status|search <term>]");
  assert.deepEqual(DISCOVERY_COMMAND_COMPLETIONS.map(({ value }) => value), ["status", "search"]);
});

test("package status normalizes and bounds displayed manifest metadata", () => {
  const text = formatPackageSummary({
    name: `unsafe\nTools (999)${"x".repeat(200)}`,
    version: "1.0.0\u0000spoofed",
    pi: { extensions: ["one"], injected: Array.from({ length: 999 }) },
  });
  const [identity, resources] = text.split("\n");
  assert.ok(identity.length <= 128 * 2 + 1);
  assert.doesNotMatch(text, /\u0000|\nTools \(999\)/);
  assert.equal(resources, "extensions: 1");
  assert.doesNotMatch(text, /injected/);
});

test("runtime search bounds untrusted metadata and reports truncation", () => {
  const sourceInfo = { path: "/plugin.ts", source: "plugin", scope: "project", origin: "top-level" } as const;
  const snapshot = {
    commands: Array.from({ length: MAX_DISCOVERY_MATCHES_PER_KIND + 2 }, (_, index) => ({
      name: `match-${String(index).padStart(2, "0")}`,
      description: "x".repeat(1_000),
      source: "extension" as const,
      sourceInfo,
    })),
    tools: [],
  } satisfies DiscoverySnapshot;

  const matches = searchDiscovery(snapshot, "match");
  assert.equal(matches.commands.length, MAX_DISCOVERY_MATCHES_PER_KIND);
  assert.equal(matches.truncated.commands, true);
  assert.match(discoverySearchText(matches), /limited to 25 command matches/);

  const details = discoveryMatchDetails(matches);
  assert.ok((details.commands[0].description?.length ?? 0) <= 240);
  assert.deepEqual(Object.keys(details.commands[0]), ["name", "description", "sourceInfo"]);
});

test("generated Pi capability data remains a build-time fixture", () => {
  const fixture = JSON.parse(readFileSync(`${root}/catalog/pi-native-capabilities.json`, "utf8"));
  assert.deepEqual(fixture.source, PI_CONTRACT_SOURCE);
  assert.deepEqual(fixture.capabilityGroups, PI_NATIVE_CAPABILITY_GROUPS);
  assert.equal(fixture.source.declarations, "dist/core/extensions/types.d.ts");
});

test("build-time fixture includes every pinned native capability group", () => {
  const fixture = JSON.parse(readFileSync(`${root}/catalog/pi-native-capabilities.json`, "utf8"));
  for (const group of ["commands", "tools", "events", "shortcuts", "flags", "providers", "renderers", "markdown-transformers", "ui-surfaces"] as const) {
    assert.ok(group in fixture.capabilityGroups);
  }
});
