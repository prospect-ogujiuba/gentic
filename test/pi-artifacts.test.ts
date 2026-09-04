import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { auditArtifacts, loadMigrationConfig } from "../extensions/pi-artifacts/src/domain/inventory.ts";
import { createMigrationPlan, fingerprint } from "../extensions/pi-artifacts/src/domain/plan.ts";
import { resolveProjectPath } from "../extensions/pi-artifacts/src/domain/normalize.ts";
import type { ArtifactInventory } from "../extensions/pi-artifacts/src/domain/types.ts";
import { planMigration, renderPlanReport } from "../extensions/pi-artifacts/src/app/service.ts";
import { applyMigration, finalizeMigration, loadMigrationPlan, recoverMigration, rollbackMigration } from "../extensions/pi-artifacts/src/app/transaction.ts";
import registerPiArtifacts from "../extensions/pi-artifacts/index.ts";

const layoutV2 = JSON.parse(readFileSync(new URL("./fixtures/model-artifacts-layout-v2.json", import.meta.url), "utf8"));

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "pi-artifacts-"));
}

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function sha(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fixtureFileHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string, relative = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path.startsWith(".model-artifacts/system/logs/model-artifact-migration")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, path);
      else if (entry.isFile()) hashes[path] = sha(readFileSync(absolute));
    }
  };
  visit(root);
  return hashes;
}

function completeV1Authority(root: string, topic = "demo"): string[] {
  const spec = `.model-artifacts/specs/${topic}/2026-05-01_1200-spec.md`;
  const plan = `.model-artifacts/plans/${topic}/2026-05-01_1201-plan.md`;
  const contract = `.model-artifacts/plans/${topic}/revisions/r1/phases/01-demo/01.01-contract.md`;
  const index = `.model-artifacts/plans/${topic}/revisions/r1/contracts.json`;
  const files: Record<string, string> = {
    [spec]: "# Spec\n",
    [plan]: `# Plan\nSpec: \`${spec}\`\n`,
    [contract]: `# Contract\nSpec: \`${spec}\`\n`,
    [`.model-artifacts/todo/${topic}/2026-05-01_1202-work.md`]: "# Todo\n",
    [`.model-artifacts/findings/${topic}/2026-05-01_1203-finding.md`]: "# Finding\n",
    [`.model-artifacts/reports/${topic}/2026-05-01_1204-report.md`]: "# Report\n",
    [`.model-artifacts/logs/${topic}/2026-05-01_1205-log.md`]: "# Log\n",
  };
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  write(root, index, `${JSON.stringify({ schemaVersion: 1, contracts: [{ id: "P01-C01", path: contract, contentHash: sha(files[contract]!) }] }, null, 2)}\n`);
  const manifest = `.model-artifacts/specs/${topic}/manifest.json`;
  write(root, manifest, `${JSON.stringify({
    schemaVersion: 1,
    initiativeId: topic,
    topic,
    activeSpec: { revision: 1, path: spec, contentHash: sha(files[spec]!) },
    activePlan: { revision: 1, path: plan, contentHash: sha(files[plan]!), contractRoot: `.model-artifacts/plans/${topic}/revisions/r1` },
  }, null, 2)}\n`);
  return [...Object.keys(files), index, manifest].sort();
}

test("artifact audit is deterministic and classifies canonical, movable, ambiguous, invalid, and protected files", () => {
  const root = fixture();
  write(root, ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-good.md", "# canonical\n");
  write(root, ".model-artifacts/reports/2026-05-01_1201-report.md", "# legacy\nTopic: `demo`\n");
  write(root, ".model-artifacts/loose.md", "# unknown\n");
  write(root, ".model-artifacts/reports/demo/data.json", "{}\n");
  write(root, ".model-artifacts/specs/demo/spec.md", "# spec\n");
  write(root, ".model-artifacts/plans/demo/plan.md", "# plan\n");
  write(root, ".model-artifacts/specs/demo/manifest.json", JSON.stringify({
    schemaVersion: 1,
    initiativeId: "demo",
    topic: "demo",
    initiativeState: "approved",
    activeSpec: { revision: 1, path: ".model-artifacts/specs/demo/spec.md", contentHash: "sha256:x" },
    activePlan: { revision: 1, path: ".model-artifacts/plans/demo/plan.md", contractRoot: ".model-artifacts/plans/demo/r1", contentHash: "sha256:y" },
  }));

  const first = auditArtifacts({ cwd: root });
  const second = auditArtifacts({ cwd: root });
  assert.deepEqual(second, first);
  const classes = new Map(first.entries.map((entry) => [entry.source, entry.classification]));
  assert.equal(classes.get(".model-artifacts/initiatives/demo/reports/2026-05-01_1200-good.md"), "canonical-valid");
  assert.equal(classes.get(".model-artifacts/reports/2026-05-01_1201-report.md"), "legacy-movable");
  assert.equal(classes.get(".model-artifacts/loose.md"), "ambiguous");
  assert.equal(classes.get(".model-artifacts/reports/demo/data.json"), "invalid");
  assert.equal(classes.get(".model-artifacts/specs/demo/manifest.json"), "protected");
  assert.equal(classes.get(".model-artifacts/specs/demo/spec.md"), "protected");
  assert.equal(classes.get(".model-artifacts/plans/demo/plan.md"), "protected");
  const movable = first.entries.find((entry) => entry.classification === "legacy-movable");
  assert.deepEqual(movable?.destination, ".model-artifacts/initiatives/demo/reports/2026-05-01_1201-report.md");
});

test("artifact audit recognizes layout-v2 initiative/system namespaces and relocates legacy system records", () => {
  const root = fixture();
  const initiativePath = layoutV2.valid.initiative.find((path: string) => path.includes("/reports/"));
  const systemPath = layoutV2.valid.system.find((path: string) => path.includes("/reports/"));
  const legacySystemPath = ".model-artifacts/logs/model-artifact-migration/2026-05-01_1208-plan.json";
  write(root, initiativePath, "# initiative report\n");
  write(root, systemPath, "# system report\n");
  write(root, legacySystemPath, "{}\n");
  const entries = new Map(auditArtifacts({ cwd: root }).entries.map((entry) => [entry.source, entry]));
  assert.equal(entries.get(initiativePath)?.classification, "canonical-valid");
  assert.equal(entries.get(systemPath)?.classification, "canonical-valid");
  assert.equal(entries.get(legacySystemPath)?.classification, "legacy-movable");
  assert.equal(entries.get(legacySystemPath)?.destination, ".model-artifacts/system/logs/model-artifact-migration/2026-05-01_1208-plan.json");
});

test("artifact audit accepts canonical pi-swe stable filenames in layout v2", () => {
  const root = fixture();
  const paths = [
    ".model-artifacts/initiatives/demo/specs/manifest.json",
    ".model-artifacts/initiatives/demo/plans/revisions/r1/contracts.json",
    ".model-artifacts/initiatives/demo/plans/revisions/r1/phases/01-demo/00-phase-index.md",
    ".model-artifacts/initiatives/demo/plans/revisions/r1/phases/01-demo/01.01-demo.md",
  ];
  for (const path of paths) write(root, path, path.endsWith(".json") ? "{}\n" : "# Contract\n");

  const entries = new Map(auditArtifacts({ cwd: root }).entries.map((entry) => [entry.source, entry]));
  for (const path of paths) assert.notEqual(entries.get(path)?.classification, "invalid", path);
});

test("artifact audit blocks mixed layout authority for one topic", () => {
  const root = fixture();
  write(root, layoutV2.mixedAuthority.v1Manifest, "{}\n");
  write(root, layoutV2.mixedAuthority.v2Manifest, "{}\n");
  const result = auditArtifacts({ cwd: root });
  assert.ok(result.diagnostics.some((diagnostic) => /mixed.*demo|demo.*mixed/i.test(diagnostic)));
});

test("artifact audit protects contracts indexed by historical plan revisions", () => {
  const root = fixture();
  const contract = ".model-artifacts/plans/demo/revisions/r1/phases/01-legacy/01.01-contract.md";
  write(root, contract, "# Historical contract\n");
  write(root, ".model-artifacts/plans/demo/revisions/r1/contracts.json", JSON.stringify({
    schemaVersion: 1,
    contracts: [{ id: "01.01", path: contract }],
  }));

  const result = auditArtifacts({ cwd: root });
  const indexed = result.entries.find((entry) => entry.source === contract);
  assert.equal(indexed?.classification, "protected");
  assert.deepEqual(indexed?.reasons, ["canonical-authority"]);
});

test("artifact audit blocks inbound references to legacy files but preserves referenced canonical files", () => {
  const root = fixture();
  write(root, ".model-artifacts/reports/2026-05-01_1201-report.md", "# legacy\nTopic: demo\n");
  write(root, ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-canonical.md", "# canonical\n");
  write(root, "README.md", [
    "See .model-artifacts/reports/2026-05-01_1201-report.md",
    "See .model-artifacts/initiatives/demo/reports/2026-05-01_1200-canonical.md",
    "",
  ].join("\n"));
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside\n", "utf8");
  symlinkSync(outside, join(root, ".model-artifacts", "linked.md"));

  const result = auditArtifacts({ cwd: root });
  const referenced = result.entries.find((entry) => entry.source.endsWith("1201-report.md"));
  const canonical = result.entries.find((entry) => entry.source.endsWith("1200-canonical.md"));
  const linked = result.entries.find((entry) => entry.source.endsWith("linked.md"));
  assert.equal(referenced?.classification, "protected");
  assert.ok(referenced?.reasons.some((reason) => reason.startsWith("inbound-reference:")));
  assert.equal(canonical?.classification, "canonical-valid");
  assert.deepEqual(canonical?.reasons, ["canonical-path"]);
  assert.equal(linked?.classification, "invalid");
  assert.ok(linked?.reasons.includes("symlink-not-followed"));
});

test("migration config is closed and supplies exact deterministic mappings", () => {
  const root = fixture();
  write(root, ".model-artifacts/misc/note.md", "# note\n");
  write(root, ".pi/model-artifacts-migration.json", JSON.stringify({
    schemaVersion: 1,
    mappings: {
      ".model-artifacts/misc/note.md": { kind: "findings", topic: "demo/topic", timestamp: "2026-05-01_1202", shortName: "Legacy Note" },
    },
  }));
  const config = loadMigrationConfig(root);
  assert.equal(config.mappings[".model-artifacts/misc/note.md"]?.shortName, "legacy-note");
  const entry = auditArtifacts({ cwd: root }).entries.find((candidate) => candidate.source.endsWith("note.md"));
  assert.equal(entry?.classification, "legacy-movable");
  assert.equal(entry?.destination, ".model-artifacts/initiatives/demo/topic/findings/2026-05-01_1202-legacy-note.md");

  write(root, ".pi/model-artifacts-migration.json", JSON.stringify({ schemaVersion: 1, mappings: {}, extra: true }));
  assert.throws(() => loadMigrationConfig(root), /unknown config key: extra/);
  write(root, ".pi/model-artifacts-migration.json", JSON.stringify({ schemaVersion: 1, mappings: { "../escape.md": { kind: "reports", topic: "demo", timestamp: "2026-05-01_1202", shortName: "x" } } }));
  assert.throws(() => loadMigrationConfig(root), /source must be a project-relative \.model-artifacts path/);
});

test("artifact audit fails closed at file and byte bounds", () => {
  const root = fixture();
  write(root, ".model-artifacts/a.md", "12345");
  write(root, ".model-artifacts/b.md", "67890");
  assert.throws(() => auditArtifacts({ cwd: root, maxFiles: 1 }), /file limit exceeded/);
  assert.throws(() => auditArtifacts({ cwd: root, maxBytes: 9 }), /byte limit exceeded/);
});

test("migration plans have stable logical fingerprints and sorted eligible moves", () => {
  const root = fixture();
  write(root, ".model-artifacts/reports/2026-05-01_1202-b.md", "# b\nTopic: demo\n");
  write(root, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const inventory = auditArtifacts({ cwd: root });
  const first = createMigrationPlan(inventory, { generatedAt: "2026-05-01T13:00:00.000Z", configFingerprint: "sha256:config" });
  const second = createMigrationPlan(inventory, { generatedAt: "2026-05-01T14:00:00.000Z", configFingerprint: "sha256:config" });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.eligible, true);
  assert.deepEqual(first.moves.map((move) => move.source), [
    ".model-artifacts/reports/2026-05-01_1201-a.md",
    ".model-artifacts/reports/2026-05-01_1202-b.md",
  ]);
  assert.equal(first.blockers.length, 0);
});

test("complete v1 topic authority plans one deterministic topic-first relocation and exact rewrites without candidate mutation", () => {
  const root = fixture();
  const sources = completeV1Authority(root);
  const referenced = ".model-artifacts/specs/demo/2026-05-01_1200-spec.md";
  write(root, "README.md", `See ${referenced}\n`);
  const before = new Map(sources.map((path) => [path, readFileSync(join(root, path), "utf8")]));

  const inventory = auditArtifacts({ cwd: root });
  assert.equal(inventory.diagnostics.length, 0);
  assert.ok(sources.every((path) => inventory.entries.find((entry) => entry.source === path)?.classification === "legacy-movable"));
  const first = createMigrationPlan(inventory, { generatedAt: "2026-05-01T13:00:00.000Z", configFingerprint: "sha256:config" });
  const second = createMigrationPlan(inventory, { generatedAt: "2026-05-01T14:00:00.000Z", configFingerprint: "sha256:config" });

  assert.equal(first.eligible, true);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.authorityUnits, ["initiative:demo"]);
  assert.ok(first.moves.every((move) => move.destination.startsWith(".model-artifacts/initiatives/demo/")));
  assert.equal(new Set(first.moves.map((move) => move.destination)).size, first.moves.length);
  assert.ok(first.rewrites.some((rewrite) => rewrite.path === "README.md" && rewrite.replacements.some((item) => item.from === referenced)));
  assert.ok(first.rewrites.some((rewrite) => rewrite.path.endsWith("manifest.json")));
  assert.ok(Object.keys(first.expectedPostTransformHashes).every((path) => path.startsWith(".model-artifacts/initiatives/demo/")));
  assert.equal(first.bounds.rollbackBytes > 0, true);
  assert.equal(first.bounds.stagingBytes > 0, true);

  const relocation = new Map(first.moves.map((move) => [move.source, move.destination]));
  const manifestSource = ".model-artifacts/specs/demo/manifest.json";
  const manifestDestination = relocation.get(manifestSource)!;
  const transformedManifest = JSON.parse(readFileSync(join(root, manifestSource), "utf8"));
  transformedManifest.schemaVersion = 2;
  transformedManifest.activeSpec.path = relocation.get(transformedManifest.activeSpec.path);
  transformedManifest.activeSpec.contentHash = first.expectedPostTransformHashes[transformedManifest.activeSpec.path];
  transformedManifest.activePlan.path = relocation.get(transformedManifest.activePlan.path);
  transformedManifest.activePlan.contractRoot = ".model-artifacts/initiatives/demo/plans/revisions/r1";
  transformedManifest.activePlan.contentHash = first.expectedPostTransformHashes[transformedManifest.activePlan.path];
  assert.equal(first.expectedPostTransformHashes[manifestDestination], sha(`${JSON.stringify(transformedManifest, null, 2)}\n`));

  const indexSource = ".model-artifacts/plans/demo/revisions/r1/contracts.json";
  const indexDestination = relocation.get(indexSource)!;
  const transformedIndex = JSON.parse(readFileSync(join(root, indexSource), "utf8"));
  transformedIndex.contracts[0].path = relocation.get(transformedIndex.contracts[0].path);
  transformedIndex.contracts[0].contentHash = first.expectedPostTransformHashes[transformedIndex.contracts[0].path];
  assert.equal(first.expectedPostTransformHashes[indexDestination], sha(`${JSON.stringify(transformedIndex, null, 2)}\n`));
  for (const [path, content] of before) assert.equal(readFileSync(join(root, path), "utf8"), content);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), `See ${referenced}\n`);
  assert.match(renderPlanReport(first, ".model-artifacts/system/logs/model-artifact-migration/plan.json"), /\/artifacts apply \.model-artifacts\/system\/logs\/model-artifact-migration\/plan\.json/);
});

test("nested-topic authority transforms its manifest to schema v2 with exact dependent hashes", () => {
  const root = fixture();
  completeV1Authority(root, "demo/topic");
  const plan = createMigrationPlan(auditArtifacts({ cwd: root }), { configFingerprint: "sha256:config" });
  assert.equal(plan.eligible, true);
  const relocation = new Map(plan.moves.map((move) => [move.source, move.destination]));
  const manifestSource = ".model-artifacts/specs/demo/topic/manifest.json";
  const manifestDestination = relocation.get(manifestSource)!;
  const manifest = JSON.parse(readFileSync(join(root, manifestSource), "utf8"));
  manifest.schemaVersion = 2;
  manifest.activeSpec.path = relocation.get(manifest.activeSpec.path);
  manifest.activeSpec.contentHash = plan.expectedPostTransformHashes[manifest.activeSpec.path];
  manifest.activePlan.path = relocation.get(manifest.activePlan.path);
  manifest.activePlan.contentHash = plan.expectedPostTransformHashes[manifest.activePlan.path];
  manifest.activePlan.contractRoot = ".model-artifacts/initiatives/demo/topic/plans/revisions/r1";
  assert.equal(plan.expectedPostTransformHashes[manifestDestination], sha(`${JSON.stringify(manifest, null, 2)}\n`));
});

test("complete authority planning blocks stale hashes, bounds, and active transaction claims", () => {
  const staleRoot = fixture();
  completeV1Authority(staleRoot);
  writeFileSync(join(staleRoot, ".model-artifacts/specs/demo/2026-05-01_1200-spec.md"), "changed\n", "utf8");
  assert.ok(auditArtifacts({ cwd: staleRoot }).diagnostics.some((item) => /stale contentHash/.test(item)));

  const boundedRoot = fixture();
  completeV1Authority(boundedRoot);
  const bounded = createMigrationPlan(auditArtifacts({ cwd: boundedRoot }), {
    configFingerprint: "sha256:config",
    maxAffectedBytes: 1,
    maxReferences: 1,
    maxRewriteRecords: 1,
    maxStagingBytes: 1,
    maxRollbackBytes: 1,
  });
  assert.equal(bounded.eligible, false);
  assert.ok(bounded.blockers.some((blocker) => blocker.code === "affected-bytes-limit"));
  assert.ok(bounded.blockers.some((blocker) => blocker.code === "reference-limit"));
  assert.ok(bounded.blockers.some((blocker) => blocker.code === "rewrite-limit"));
  assert.ok(bounded.blockers.some((blocker) => blocker.code === "staging-bytes-limit"));
  assert.ok(bounded.blockers.some((blocker) => blocker.code === "rollback-bytes-limit"));

  const claimedRoot = fixture();
  completeV1Authority(claimedRoot);
  write(claimedRoot, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json", "{}\n");
  assert.ok(auditArtifacts({ cwd: claimedRoot }).diagnostics.some((item) => /active migration claim/.test(item)));
});

test("planning revalidates audited source and reference bytes and rejects symlink swaps", () => {
  const sourceRoot = fixture();
  completeV1Authority(sourceRoot);
  const sourceInventory = auditArtifacts({ cwd: sourceRoot });
  writeFileSync(join(sourceRoot, ".model-artifacts/specs/demo/2026-05-01_1200-spec.md"), "changed after audit\n", "utf8");
  const staleSource = createMigrationPlan(sourceInventory, { configFingerprint: "sha256:config" });
  assert.ok(staleSource.blockers.some((blocker) => blocker.code === "stale-source"));

  const referenceRoot = fixture();
  completeV1Authority(referenceRoot);
  const referenced = ".model-artifacts/specs/demo/2026-05-01_1200-spec.md";
  write(referenceRoot, "README.md", `See ${referenced}\n`);
  const referenceInventory = auditArtifacts({ cwd: referenceRoot });
  writeFileSync(join(referenceRoot, "README.md"), `Changed ${referenced}\n`, "utf8");
  const staleReference = createMigrationPlan(referenceInventory, { configFingerprint: "sha256:config" });
  assert.ok(staleReference.blockers.some((blocker) => blocker.code === "stale-reference" && blocker.source === "README.md"));

  const symlinkRoot = fixture();
  const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
  write(symlinkRoot, source, "# a\nTopic: demo\n");
  const symlinkInventory = auditArtifacts({ cwd: symlinkRoot });
  const outside = join(symlinkRoot, "outside.md");
  writeFileSync(outside, "outside\n", "utf8");
  unlinkSync(join(symlinkRoot, source));
  symlinkSync(outside, join(symlinkRoot, source));
  const unsafe = createMigrationPlan(symlinkInventory, { configFingerprint: "sha256:config" });
  assert.ok(unsafe.blockers.some((blocker) => blocker.code === "unsafe-entry" && blocker.source === source));
});

test("reference planning handles overlapping source prefixes and rejects dependency cycles", () => {
  const root = fixture();
  const short = ".model-artifacts/a.md";
  const long = ".model-artifacts/a.md-more.md";
  write(root, short, "short\n");
  write(root, long, "long\n");
  write(root, "README.md", `${short} ${long}\n`);
  const entries = [short, long].map((source, index) => ({
    source,
    destination: `.model-artifacts/initiatives/demo/reports/2026-05-01_120${index}-item.md`,
    classification: "legacy-movable" as const,
    reasons: ["explicit-mapping"],
    bytes: readFileSync(join(root, source)).byteLength,
    contentHash: sha(readFileSync(join(root, source), "utf8")),
    referenceSites: ["README.md"],
    referenceSiteHashes: { "README.md": sha(`${short} ${long}\n`) },
  }));
  const inventory: ArtifactInventory = { schemaVersion: 1, projectRoot: root, configPath: null, entries, totals: { "canonical-valid": 0, "legacy-movable": 2, protected: 0, ambiguous: 0, invalid: 0 }, fileCount: 2, candidateBytes: 11, diagnostics: [] };
  const plan = createMigrationPlan(inventory, { configFingerprint: "sha256:config" });
  const rewrite = plan.rewrites.find((item) => item.path === "README.md")!;
  assert.deepEqual(rewrite.replacements.map((item) => item.from), [long, short]);
  assert.equal(plan.eligible, true);

  const cycleRoot = fixture();
  const a = ".model-artifacts/a.json";
  const b = ".model-artifacts/b.json";
  const aDestination = ".model-artifacts/initiatives/demo/plans/a.json";
  const bDestination = ".model-artifacts/initiatives/demo/plans/b.json";
  const aContent = `${JSON.stringify({ path: b, contentHash: sha("b") }, null, 2)}\n`;
  const bContent = `${JSON.stringify({ path: a, contentHash: sha("a") }, null, 2)}\n`;
  write(cycleRoot, a, aContent);
  write(cycleRoot, b, bContent);
  const cycleInventory: ArtifactInventory = {
    schemaVersion: 1, projectRoot: cycleRoot, configPath: null, fileCount: 2, candidateBytes: Buffer.byteLength(aContent) + Buffer.byteLength(bContent), diagnostics: [],
    totals: { "canonical-valid": 0, "legacy-movable": 2, protected: 0, ambiguous: 0, invalid: 0 },
    entries: [
      { source: a, destination: aDestination, classification: "legacy-movable", reasons: ["complete-topic-authority"], bytes: Buffer.byteLength(aContent), contentHash: sha(aContent), authorityUnit: "initiative", topic: "demo" },
      { source: b, destination: bDestination, classification: "legacy-movable", reasons: ["complete-topic-authority"], bytes: Buffer.byteLength(bContent), contentHash: sha(bContent), authorityUnit: "initiative", topic: "demo" },
    ],
  };
  const cycle = createMigrationPlan(cycleInventory, { configFingerprint: "sha256:config" });
  assert.ok(cycle.blockers.some((blocker) => blocker.code === "reference-cycle"));
});

test("layout-v2 invalid normalization fixtures fail closed", () => {
  const root = fixture();
  for (const fixtureEntry of layoutV2.invalid as Array<{ path: string; reason: string }>) {
    if (["traversal", "absolute", "backslash"].includes(fixtureEntry.reason)) {
      assert.throws(() => resolveProjectPath(root, fixtureEntry.path), /project-relative \.model-artifacts path/);
      continue;
    }
    write(root, fixtureEntry.path, "invalid\n");
  }
  const invalidPaths = new Set(auditArtifacts({ cwd: root }).entries.filter((entry) => entry.classification === "invalid").map((entry) => entry.source));
  for (const fixtureEntry of layoutV2.invalid as Array<{ path: string; reason: string }>) {
    if (!["traversal", "absolute", "backslash"].includes(fixtureEntry.reason)) assert.ok(invalidPaths.has(fixtureEntry.path), fixtureEntry.reason);
  }
});

test("migration planning persists exclusive versioned JSON and a concise report", () => {
  const root = fixture();
  write(root, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const result = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  assert.equal(result.plan.eligible, true);
  assert.ok(result.planPath.startsWith(".model-artifacts/system/logs/model-artifact-migration/2026-05-01_1300-"));
  assert.ok(existsSync(join(root, result.planPath)));
  assert.ok(existsSync(join(root, result.reportPath)));
  const stored = JSON.parse(readFileSync(join(root, result.planPath), "utf8"));
  assert.equal(stored.fingerprint, result.plan.fingerprint);
  assert.match(readFileSync(join(root, result.reportPath), "utf8"), /eligible moves: 1/);
  assert.match(readFileSync(join(root, result.reportPath), "utf8"), /staging bytes: \d+/);
  assert.throws(() => planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
});

test("saved plan loader rejects unknown versions and stale fingerprints", () => {
  const root = fixture();
  write(root, ".model-artifacts/system/logs/model-artifact-migration/future-plan.json", JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => loadMigrationPlan(root, ".model-artifacts/system/logs/model-artifact-migration/future-plan.json"), /unsupported migration plan schemaVersion/);
  write(root, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const stored = JSON.parse(readFileSync(join(root, planned.planPath), "utf8"));
  stored.fingerprint = `sha256:${"0".repeat(64)}`;
  writeFileSync(join(root, planned.planPath), JSON.stringify(stored), "utf8");
  assert.throws(() => loadMigrationPlan(root, planned.planPath), /fingerprint mismatch/);
});

test("saved plan loader closed-schema validates every nested plan record", () => {
  const root = fixture();
  write(root, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const base = JSON.parse(readFileSync(join(root, planned.planPath), "utf8"));
  const malformed = [
    { label: "rewrite", mutate(value: any) { value.rewrites = [{ path: "README.md", sourceHash: sha("a"), expectedHash: sha("b"), replacements: [], extra: true }]; } },
    { label: "expected hash", mutate(value: any) { value.expectedPostTransformHashes[value.moves[0].destination] = "bad"; } },
    { label: "authority unit", mutate(value: any) { value.authorityUnits = ["initiative:Demo"]; } },
    { label: "bounds", mutate(value: any) { value.bounds.extra = 1; } },
    { label: "expected hash keys", mutate(value: any) { delete value.expectedPostTransformHashes[value.moves[0].destination]; } },
    { label: "move ordering", mutate(value: any) { value.moves.push(structuredClone(value.moves[0])); } },
    { label: "case-fold collision", mutate(value: any) {
      const second = structuredClone(value.moves[0]);
      second.source = second.source.replace("1201-a.md", "1202-b.md");
      second.destination = second.destination.replace("-a.md", "-A.md");
      value.moves.push(second);
      value.expectedPostTransformHashes[second.destination] = second.sourceHash;
      value.bounds.affectedBytes += second.bytes;
      value.bounds.stagingBytes += second.bytes;
      value.bounds.rollbackBytes += second.bytes;
    } },
    { label: "authority unit ordering", mutate(value: any) { value.authorityUnits.push(value.authorityUnits[0]); } },
    { label: "bounds counts", mutate(value: any) { value.bounds.references += 1; } },
    { label: "rewrite relationship", mutate(value: any) { value.rewrites = [{ path: "README.md", sourceHash: sha("a"), expectedHash: sha("b"), sourceBytes: 1, expectedBytes: 1, replacements: [{ from: ".model-artifacts/x.md", to: ".model-artifacts/y.md" }] }]; value.bounds.rewriteRecords = 1; value.bounds.references = 1; value.bounds.affectedBytes += 1; value.bounds.rollbackBytes += 1; value.bounds.stagingBytes += 1; } },
  ];
  for (const item of malformed) {
    const value = structuredClone(base);
    item.mutate(value);
    value.fingerprint = fingerprint({ schemaVersion: 1, projectRoot: value.projectRoot, configPath: value.configPath, configFingerprint: value.configFingerprint, moves: value.moves, rewrites: value.rewrites, expectedPostTransformHashes: value.expectedPostTransformHashes, authorityUnits: value.authorityUnits, bounds: value.bounds, blockers: value.blockers });
    writeFileSync(join(root, planned.planPath), JSON.stringify(value), "utf8");
    assert.throws(() => loadMigrationPlan(root, planned.planPath), new RegExp(item.label));
  }
});

test("migration apply is hash-gated, exclusive, byte-preserving, and idempotent", () => {
  const root = fixture();
  const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
  const bytes = "# a\nTopic: demo\n";
  write(root, source, bytes);
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const applied = applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" });
  assert.equal(applied.status, "applied");
  assert.equal(existsSync(join(root, source)), false);
  const destination = planned.plan.moves[0]!.destination;
  assert.equal(readFileSync(join(root, destination), "utf8"), bytes);
  assert.ok(existsSync(join(root, applied.ledgerPath)));
  assert.equal(applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" }).status, "already-applied");
});

test("migration apply refuses stale sources, occupied destinations, and concurrent claims", () => {
  for (const mode of ["stale", "destination", "claim"] as const) {
    const root = fixture();
    const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
    write(root, source, "# a\nTopic: demo\n");
    const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
    if (mode === "stale") writeFileSync(join(root, source), "changed\n", "utf8");
    if (mode === "destination") write(root, planned.plan.moves[0]!.destination, "occupied\n");
    if (mode === "claim") write(root, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json", "{}\n");
    assert.throws(() => applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" }), new RegExp(mode === "stale" ? "source hash mismatch" : mode === "destination" ? "destination already exists" : "claim already exists"));
    assert.equal(readFileSync(join(root, source), "utf8").startsWith("# a") || mode === "stale", true);
    if (mode === "stale") assert.equal(existsSync(dirname(join(root, planned.plan.moves[0]!.destination))), false);
  }
});

test("migration apply detects claim-token replacement before moving bytes", () => {
  const root = fixture();
  const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
  write(root, source, "# a\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  assert.throws(() => applyMigration({
    cwd: root,
    planPath: planned.planPath,
    ownerToken: "owner-a",
    fault(stage) {
      if (stage === "journal-prepared") writeFileSync(join(root, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json"), JSON.stringify({ schemaVersion: 1, ownerToken: "owner-b", operation: "apply", identity: planned.plan.fingerprint }), "utf8");
    },
  }), /migration interrupted.*migration claim ownership mismatch/);
  assert.ok(existsSync(join(root, source)));
  assert.equal(existsSync(join(root, planned.plan.moves[0]!.destination)), false);
});

test("migration apply interruptions retain evidence and recover preimages idempotently", () => {
  const stages = ["preflight-complete", "claim-acquired", "staging-complete", "journal-prepared", "before-destination", "destination-written", "source-removed", "ledger-written"] as const;
  for (const targetStage of stages) {
    const root = fixture();
    const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
    const bytes = "# a\nTopic: demo\n";
    write(root, source, bytes);
    const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
    const before = fixtureFileHashes(root);
    const journalPath = planned.planPath.replace(/-plan\.json$/, "-apply-journal.json");
    const bundlePath = planned.planPath.replace(/-plan\.json$/, "-transaction");
    const claimPath = ".model-artifacts/system/logs/model-artifact-migration/active.claim.json";
    const invoke = () => applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a", fault(stage) { if (stage === targetStage) throw new Error(`injected:${stage}`); } });
    if (targetStage === "ledger-written") {
      const result = invoke();
      assert.equal(result.status, "applied");
      assert.equal(existsSync(join(root, source)), false);
      assert.equal(readFileSync(join(root, planned.plan.moves[0]!.destination), "utf8"), bytes);
    } else if (targetStage === "preflight-complete" || targetStage === "claim-acquired" || targetStage === "staging-complete") {
      assert.throws(invoke, new RegExp(`injected:${targetStage}`));
      assert.deepEqual(fixtureFileHashes(root), before);
      assert.equal(existsSync(join(root, claimPath)), false);
      assert.equal(existsSync(join(root, journalPath)), false);
      assert.equal(existsSync(join(root, bundlePath)), false);
    } else {
      assert.throws(invoke, new RegExp(`interrupted.*${targetStage}`));
      assert.ok(existsSync(join(root, journalPath)));
      assert.ok(existsSync(join(root, claimPath)));
      const recovered = recoverMigration({ cwd: root, journalPath });
      assert.equal(recovered.status, "recovered");
      assert.deepEqual(fixtureFileHashes(root), before);
      assert.equal(recoverMigration({ cwd: root, journalPath }).status, "already-recovered");
      assert.equal(existsSync(join(root, claimPath)), false);
      assert.equal(existsSync(join(root, journalPath)), false);
    }
  }
});

test("interrupted apply recovery resumes record-by-record and restores the full fixture", () => {
  const root = fixture();
  completeV1Authority(root);
  write(root, "README.md", "See .model-artifacts/specs/demo/2026-05-01_1200-spec.md\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const before = fixtureFileHashes(root);
  const journalPath = planned.planPath.replace(/-plan\.json$/, "-apply-journal.json");
  assert.throws(() => applyMigration({
    cwd: root,
    planPath: planned.planPath,
    fault(stage) { if (stage === "source-removed") throw new Error("publish-interrupted"); },
  }), /publish-interrupted/);
  let injected = false;
  assert.throws(() => recoverMigration({
    cwd: root,
    journalPath,
    fault(stage) { if (stage === "recovery-record-restored" && !injected) { injected = true; throw new Error("recovery-interrupted"); } },
  }), /recovery-interrupted/);
  assert.ok(existsSync(join(root, journalPath)));
  assert.ok(existsSync(join(root, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json")));
  assert.ok(existsSync(join(root, planned.planPath.replace(/-plan\.json$/, "-transaction"))));
  assert.equal(recoverMigration({ cwd: root, journalPath }).status, "recovered");
  assert.deepEqual(fixtureFileHashes(root), before);
  assert.equal(recoverMigration({ cwd: root, journalPath }).status, "already-recovered");
});

test("complete authority apply publishes the validated transformed graph and rollback restores exact v1 bytes", () => {
  const root = fixture();
  const sources = completeV1Authority(root);
  const referenced = ".model-artifacts/specs/demo/2026-05-01_1200-spec.md";
  write(root, "README.md", `See ${referenced}\n`);
  const originals = new Map([...sources, "README.md"].map((path) => [path, readFileSync(join(root, path))]));
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const treeBefore = fixtureFileHashes(root);

  const applied = applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" });
  assert.equal(applied.status, "applied");
  for (const move of planned.plan.moves) {
    assert.equal(existsSync(join(root, move.source)), false);
    assert.equal(sha(readFileSync(join(root, move.destination), "utf8")), planned.plan.expectedPostTransformHashes[move.destination]);
  }
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), `See .model-artifacts/initiatives/demo/specs/2026-05-01_1200-spec.md\n`);

  const ledger = JSON.parse(readFileSync(join(root, applied.ledgerPath), "utf8"));
  assert.equal(ledger.state, "applied");
  assert.ok(existsSync(join(root, ledger.bundlePath)));
  const rolled = rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath, ownerToken: "owner-b" });
  assert.equal(rolled.status, "rolled-back");
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(root, path)), bytes);
  for (const move of planned.plan.moves) assert.equal(existsSync(join(root, move.destination)), false);
  assert.deepEqual(fixtureFileHashes(root), treeBefore);
});

test("complete authority rollback refuses modified v2 bytes and finalize irreversibly removes payloads", () => {
  const modifiedRoot = fixture();
  completeV1Authority(modifiedRoot);
  const modifiedPlan = planMigration({ cwd: modifiedRoot, generatedAt: "2026-05-01T13:00:00.000Z" });
  const modifiedApply = applyMigration({ cwd: modifiedRoot, planPath: modifiedPlan.planPath });
  writeFileSync(join(modifiedRoot, modifiedPlan.plan.moves[0]!.destination), "changed\n", "utf8");
  assert.throws(() => rollbackMigration({ cwd: modifiedRoot, ledgerPath: modifiedApply.ledgerPath }), /destination hash mismatch/);

  const root = fixture();
  completeV1Authority(root);
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const applied = applyMigration({ cwd: root, planPath: planned.planPath });
  const before = JSON.parse(readFileSync(join(root, applied.ledgerPath), "utf8"));
  assert.ok(existsSync(join(root, before.bundlePath)));
  assert.throws(() => finalizeMigration({
    cwd: root,
    ledgerPath: applied.ledgerPath,
    fault(stage) { if (stage === "finalize-marked") throw new Error("finalize-interrupted"); },
  }), /finalize-interrupted/);
  assert.ok(existsSync(join(root, before.bundlePath)));
  const finalized = finalizeMigration({ cwd: root, ledgerPath: applied.ledgerPath });
  assert.equal(finalized.status, "finalized");
  assert.equal(existsSync(join(root, before.bundlePath)), false);
  assert.ok(existsSync(join(root, finalized.reportPath)));
  assert.equal(finalizeMigration({ cwd: root, ledgerPath: applied.ledgerPath }).status, "already-finalized");
  assert.throws(() => rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath }), /finalized/);

  const removedRoot = fixture();
  completeV1Authority(removedRoot);
  const removedPlan = planMigration({ cwd: removedRoot, generatedAt: "2026-05-01T13:01:00.000Z" });
  const removedApply = applyMigration({ cwd: removedRoot, planPath: removedPlan.planPath });
  const removedLedgerAbsolute = join(removedRoot, removedApply.ledgerPath);
  const removedLedger = JSON.parse(readFileSync(removedLedgerAbsolute, "utf8"));
  assert.throws(() => finalizeMigration({
    cwd: removedRoot,
    ledgerPath: removedApply.ledgerPath,
    fault(stage) { if (stage === "finalize-payloads-removed") throw new Error("finalize-remove-interrupted"); },
  }), /finalize-remove-interrupted/);
  assert.equal(JSON.parse(readFileSync(removedLedgerAbsolute, "utf8")).state, "finalizing");
  assert.equal(existsSync(join(removedRoot, removedLedger.bundlePath)), false);
  assert.equal(existsSync(join(removedRoot, removedApply.ledgerPath.replace(/-ledger\.json$/, "-finalize-report.md"))), false);
  const resumed = finalizeMigration({ cwd: removedRoot, ledgerPath: removedApply.ledgerPath });
  assert.equal(resumed.status, "finalized");
  assert.equal(JSON.parse(readFileSync(removedLedgerAbsolute, "utf8")).state, "finalized");
  assert.ok(existsSync(join(removedRoot, resumed.reportPath)));
  assert.equal(finalizeMigration({ cwd: removedRoot, ledgerPath: removedApply.ledgerPath }).status, "already-finalized");
  assert.throws(() => rollbackMigration({ cwd: removedRoot, ledgerPath: removedApply.ledgerPath }), /finalized/);
});

test("migration rollback is reverse, hash-gated, conflict-safe, and idempotent", () => {
  const root = fixture();
  const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
  write(root, source, "# a\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const applied = applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" });
  const rolled = rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath, ownerToken: "owner-b" });
  assert.equal(rolled.status, "rolled-back");
  assert.ok(existsSync(join(root, source)));
  assert.equal(existsSync(join(root, planned.plan.moves[0]!.destination)), false);
  assert.equal(rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath, ownerToken: "owner-b" }).status, "already-rolled-back");

  const other = fixture();
  write(other, source, "# a\nTopic: demo\n");
  const otherPlan = planMigration({ cwd: other, generatedAt: "2026-05-01T13:00:00.000Z" });
  const otherApplied = applyMigration({ cwd: other, planPath: otherPlan.planPath, ownerToken: "owner-a" });
  writeFileSync(join(other, otherPlan.plan.moves[0]!.destination), "changed\n", "utf8");
  assert.throws(() => rollbackMigration({ cwd: other, ledgerPath: otherApplied.ledgerPath, ownerToken: "owner-b" }), /destination hash mismatch/);
});

test("rollback rejects a ledger whose moves drift from the saved plan", () => {
  const root = fixture();
  const source = ".model-artifacts/reports/2026-05-01_1201-a.md";
  write(root, source, "# a\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const applied = applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" });
  const ledgerAbsolute = join(root, applied.ledgerPath);
  const ledger = JSON.parse(readFileSync(ledgerAbsolute, "utf8"));
  ledger.moves[0].destination = ".model-artifacts/reports/demo/2026-05-01_1201-other.md";
  writeFileSync(ledgerAbsolute, JSON.stringify(ledger), "utf8");
  assert.throws(() => rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath, ownerToken: "owner-b" }), /ledger moves do not match/);
  assert.equal(existsSync(join(root, source)), false);
  assert.ok(existsSync(join(root, planned.plan.moves[0]!.destination)));
});

test("partial rollback is reverse-ordered and retains exact blocked-recovery evidence", () => {
  const root = fixture();
  const sourceA = ".model-artifacts/reports/2026-05-01_1201-a.md";
  const sourceB = ".model-artifacts/reports/2026-05-01_1202-b.md";
  write(root, sourceA, "# a\nTopic: demo\n");
  write(root, sourceB, "# b\nTopic: demo\n");
  const planned = planMigration({ cwd: root, generatedAt: "2026-05-01T13:00:00.000Z" });
  const applied = applyMigration({ cwd: root, planPath: planned.planPath, ownerToken: "owner-a" });
  assert.throws(() => rollbackMigration({ cwd: root, ledgerPath: applied.ledgerPath, ownerToken: "owner-b", fault(stage) { if (stage === "rollback-source-restored") throw new Error("rollback-injected"); } }), /blocked rollback recovery.*rollback-injected/);
  assert.equal(existsSync(join(root, sourceA)), false);
  assert.equal(existsSync(join(root, planned.plan.moves.find((move) => move.source === sourceA)!.destination)), true);
  assert.equal(existsSync(join(root, sourceB)), true);
  assert.equal(existsSync(join(root, planned.plan.moves.find((move) => move.source === sourceB)!.destination)), false);
  assert.ok(existsSync(join(root, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json")));
  const journalPath = applied.ledgerPath.replace(/-ledger\.json$/, "-rollback-journal.json");
  assert.ok(existsSync(join(root, journalPath)));
  let recoveryInjected = false;
  assert.throws(() => recoverMigration({
    cwd: root,
    journalPath,
    fault(stage) { if (stage === "recovery-record-restored" && !recoveryInjected) { recoveryInjected = true; throw new Error("rollback-recovery-injected"); } },
  }), /rollback-recovery-injected/);
  assert.ok(existsSync(join(root, journalPath)));
  assert.ok(existsSync(join(root, ".model-artifacts/system/logs/model-artifact-migration/active.claim.json")));
  assert.equal(recoverMigration({ cwd: root, journalPath }).status, "recovered");
  assert.equal(recoverMigration({ cwd: root, journalPath }).status, "already-recovered");
  assert.ok(existsSync(join(root, sourceA)));
  assert.ok(existsSync(join(root, sourceB)));
  assert.equal(existsSync(join(root, planned.plan.moves[0]!.destination)), false);
  assert.equal(existsSync(join(root, planned.plan.moves[1]!.destination)), false);
});

test("/artifacts command audits, plans, applies, rolls back, recovers, and finalizes without an LLM", async () => {
  const root = fixture();
  write(root, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null }>();
  registerPiArtifacts({ registerCommand(name: string, command: never) { commands.set(name, command); } } as never);
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = { cwd: root, ui: { notify(message: string, type: string) { notifications.push({ message, type }); } } };
  const command = commands.get("artifacts")!;
  assert.deepEqual(command.getArgumentCompletions?.("a")?.map((item) => item.value), ["apply", "audit"]);
  await command.handler("audit", ctx);
  assert.match(notifications.at(-1)!.message, /legacy-movable: 1/);
  await command.handler("plan", ctx);
  const planPath = notifications.at(-1)!.message.match(/plan: (\.model-artifacts\/\S+-plan\.json)/)![1]!;
  await command.handler(`apply ${planPath}`, ctx);
  const ledgerPath = notifications.at(-1)!.message.match(/ledger: (\.model-artifacts\/\S+-ledger\.json)/)![1]!;
  assert.match(notifications.at(-1)!.message, /status: applied/);
  await command.handler(`rollback ${ledgerPath}`, ctx);
  assert.match(notifications.at(-1)!.message, /status: rolled-back/);
  await command.handler(`apply ${planPath}`, ctx);
  assert.match(notifications.at(-1)!.message, /status: conflict/);

  const finalizeRoot = fixture();
  write(finalizeRoot, ".model-artifacts/reports/2026-05-01_1201-a.md", "# a\nTopic: demo\n");
  const finalizeCtx = { ...ctx, cwd: finalizeRoot };
  await command.handler("plan", finalizeCtx);
  const finalizePlanPath = notifications.at(-1)!.message.match(/plan: (\.model-artifacts\/\S+-plan\.json)/)![1]!;
  await command.handler(`apply ${finalizePlanPath}`, finalizeCtx);
  const finalizeLedgerPath = notifications.at(-1)!.message.match(/ledger: (\.model-artifacts\/\S+-ledger\.json)/)![1]!;
  await command.handler(`finalize ${finalizeLedgerPath}`, finalizeCtx);
  assert.match(notifications.at(-1)!.message, /status: finalized/);
  await command.handler("apply", ctx);
  assert.equal(notifications.at(-1)!.type, "warning");
  assert.match(notifications.at(-1)!.message, /Usage: \/artifacts/);
});

test("/artifacts plan reports a clean zero-move inventory as up-to-date", async () => {
  const root = fixture();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  registerPiArtifacts({ registerCommand(name: string, command: never) { commands.set(name, command); } } as never);
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = { cwd: root, ui: { notify(message: string, type: string) { notifications.push({ message, type }); } } };

  await commands.get("artifacts")!.handler("plan", ctx);

  assert.equal(notifications.at(-1)!.type, "info");
  assert.match(notifications.at(-1)!.message, /status: up-to-date/);
  assert.match(notifications.at(-1)!.message, /eligible: not-applicable/);
  assert.match(notifications.at(-1)!.message, /blockers: 0/);
  assert.match(notifications.at(-1)!.message, /next: no migration needed/);
  const reportPath = notifications.at(-1)!.message.match(/report: (\.model-artifacts\/\S+-plan-report\.md)/)![1]!;
  assert.match(readFileSync(join(root, reportPath), "utf8"), /No migration is needed/);
});

test("pi-artifacts README documents dry-run adoption, protected authority, and recovery", () => {
  const readme = readFileSync(join(process.cwd(), "extensions/pi-artifacts/README.md"), "utf8");
  for (const required of ["/artifacts audit", "/artifacts plan", "/artifacts apply", "/artifacts recover", "/artifacts rollback", "/artifacts finalize", "Protected authority", "Claims are never auto-reaped", ".pi/model-artifacts-migration.json"]) assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const guide = readFileSync(join(process.cwd(), "docs/model-artifacts.md"), "utf8");
  for (const required of ["docs/plans/", "Compatibility window", "exact saved plan fingerprint", "Rollback retention and rehearsal", "check:model-artifacts"]) assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/pi-update.yml"), "utf8");
  assert.doesNotMatch(workflow, /\.model-artifacts\/reports\/pi-update/);
  assert.match(workflow, /\.model-artifacts\/system\/reports\/pi-update/);
  assert.match(readFileSync(join(process.cwd(), "catalog/gentic-inventory.json"), "utf8"), /"pi-artifacts"/);
});

test("migration plans block duplicate destinations and unsafe legacy entries", () => {
  const root = fixture();
  const inventory: ArtifactInventory = {
    schemaVersion: 1,
    projectRoot: root,
    configPath: null,
    fileCount: 3,
    candidateBytes: 3,
    diagnostics: [],
    totals: { "canonical-valid": 0, "legacy-movable": 2, protected: 1, ambiguous: 0, invalid: 0 },
    entries: [
      { source: ".model-artifacts/a.md", destination: ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-x.md", classification: "legacy-movable", reasons: ["explicit-mapping"], bytes: 1, contentHash: "sha256:a" },
      { source: ".model-artifacts/b.md", destination: ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-x.md", classification: "legacy-movable", reasons: ["explicit-mapping"], bytes: 1, contentHash: "sha256:b" },
      { source: ".model-artifacts/c.md", classification: "protected", reasons: ["inbound-reference:README.md"], bytes: 1, contentHash: "sha256:c" },
    ],
  };
  const plan = createMigrationPlan(inventory, { generatedAt: "2026-05-01T13:00:00.000Z", configFingerprint: "sha256:config" });
  assert.equal(plan.eligible, false);
  assert.ok(plan.blockers.some((blocker) => blocker.code === "duplicate-destination"));
  assert.ok(plan.blockers.some((blocker) => blocker.code === "unsafe-entry" && blocker.source.endsWith("c.md")));

  const caseInventory: ArtifactInventory = {
    ...inventory,
    fileCount: 2,
    candidateBytes: 2,
    totals: { "canonical-valid": 0, "legacy-movable": 2, protected: 0, ambiguous: 0, invalid: 0 },
    entries: [
      { source: ".model-artifacts/a.md", destination: ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-X.md", classification: "legacy-movable", reasons: ["explicit-mapping"], bytes: 1, contentHash: "sha256:a" },
      { source: ".model-artifacts/b.md", destination: ".model-artifacts/initiatives/demo/reports/2026-05-01_1200-x.md", classification: "legacy-movable", reasons: ["explicit-mapping"], bytes: 1, contentHash: "sha256:b" },
    ],
  };
  assert.ok(createMigrationPlan(caseInventory, { configFingerprint: "sha256:config" }).blockers.some((blocker) => blocker.code === "destination-case-collision"));
});
