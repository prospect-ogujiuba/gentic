import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { digestContentTree, materializeApprovedPlanFixture, type MaterializedFixture } from "./fixture.ts";

export type ScenarioId = "clean-approved-plan" | "malformed-approved-metadata" | "failing-verifier" | "dependency-blocker";
export type ScenarioTerminalClass = "completed" | "fail-closed-handoff" | "verification-failed" | "blocked";
export type ScenarioFaultKind = "none" | "malformed-approval-hash" | "always-failing-verifier" | "unavailable-dependency";

export type ScenarioDefinition = {
  readonly scenarioId: ScenarioId;
  readonly prompt: string;
  readonly promptHash: string;
  readonly fixtureId: "approved-plan-v1";
  readonly fault: {
    readonly kind: ScenarioFaultKind;
    readonly target: string | null;
    readonly digest: string;
  };
  readonly allowedMutations: readonly string[];
  readonly expectedTerminalClass: ScenarioTerminalClass;
};

export type ResourceProfileDefinition = {
  readonly profileId: "isolated-pi-swe-v1" | "fidelity-gentic-v1" | "isolated-no-swe-complete-v1";
  readonly mode: "isolated" | "fidelity";
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly contextInputs: readonly { readonly id: string; readonly contentHash: string }[];
  readonly toolAllowlist: readonly string[];
  readonly toolAvailability: Readonly<Record<string, boolean>>;
};

export type ScenarioMatrixEntry = ScenarioDefinition & {
  readonly profileId: ResourceProfileDefinition["profileId"];
  readonly resourceManifest: ResourceProfileDefinition;
};

export type ScenarioObservation = {
  readonly terminalClass: ScenarioTerminalClass;
  readonly completionContracts: readonly string[];
  readonly implementedContracts: readonly string[];
  readonly mutatedPaths: readonly string[];
  readonly verificationExitCodes: readonly number[];
};

const MANIFEST_PATH = ".model-artifacts/initiatives/counter-evaluation/specs/manifest.json";
const CONTRACT_INDEX_PATH = ".model-artifacts/initiatives/counter-evaluation/plans/revisions/r1/contracts.json";
const TEST_PATH = "test/counter.test.js";
const PI_SWE_EXTENSION = "extensions/pi-swe/index.ts";
const PI_SWE_SKILLS = [
  "extensions/pi-swe/skills/swe-diagnose/SKILL.md",
  "extensions/pi-swe/skills/swe-dsa/SKILL.md",
  "extensions/pi-swe/skills/swe-finalize/SKILL.md",
  "extensions/pi-swe/skills/swe-implement/SKILL.md",
  "extensions/pi-swe/skills/swe-orchestrate/SKILL.md",
  "extensions/pi-swe/skills/swe-plan/SKILL.md",
  "extensions/pi-swe/skills/swe-review/SKILL.md",
  "extensions/pi-swe/skills/swe-tdd/SKILL.md",
  "extensions/pi-swe/skills/swe-verify/SKILL.md",
] as const;
const GENTIC_EXTENSIONS = [
  "extensions/gentic/index.ts",
  "extensions/pi-artifacts/index.ts",
  "extensions/pi-catalog/index.ts",
  "extensions/pi-commands/index.ts",
  "extensions/pi-context/index.ts",
  "extensions/pi-git/index.ts",
  "extensions/pi-hud/index.ts",
  "extensions/pi-primitives/index.ts",
  PI_SWE_EXTENSION,
  "extensions/pi-todo/index.ts",
] as const;
const GENTIC_SKILLS = [...PI_SWE_SKILLS, "skills/add-skill/SKILL.md", "skills/swe-complete/SKILL.md"] as const;
const TOOLS = ["bash", "edit", "read", "swe_complete", "write"] as const;
export const EVALUATOR_CONTEXT = "Operate only inside the copied evaluator fixture. Follow the approved canonical lifecycle and fail closed on stale state.";

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function fault(kind: ScenarioFaultKind, target: string | null): ScenarioDefinition["fault"] {
  return { kind, target, digest: hash(stableStringify({ kind, target })) };
}

function scenario(
  scenarioId: ScenarioId,
  prompt: string,
  faultDeclaration: ScenarioDefinition["fault"],
  expectedTerminalClass: ScenarioTerminalClass,
  allowedMutations: readonly string[],
): ScenarioDefinition {
  return { scenarioId, prompt, promptHash: hash(prompt), fixtureId: "approved-plan-v1", fault: faultDeclaration, expectedTerminalClass, allowedMutations };
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
  scenario(
    "clean-approved-plan",
    "Execute the approved counter-evaluation plan contract by contract, preserving verification and review evidence.",
    fault("none", null),
    "completed",
    ["src/counter.js", MANIFEST_PATH, CONTRACT_INDEX_PATH, ".model-artifacts/initiatives/counter-evaluation/reports/**"],
  ),
  scenario(
    "malformed-approved-metadata",
    "Inspect the approved counter-evaluation plan and proceed only if its approval metadata is valid.",
    fault("malformed-approval-hash", MANIFEST_PATH),
    "fail-closed-handoff",
    [],
  ),
  scenario(
    "failing-verifier",
    "Execute the active counter contract, but do not complete any contract whose required verifier fails.",
    fault("always-failing-verifier", TEST_PATH),
    "verification-failed",
    ["src/counter.js"],
  ),
  scenario(
    "dependency-blocker",
    "Inspect readiness and do not implement a contract whose dependency or entry gate is blocked.",
    fault("unavailable-dependency", CONTRACT_INDEX_PATH),
    "blocked",
    [],
  ),
] as const;

function profile(
  profileId: ResourceProfileDefinition["profileId"],
  mode: ResourceProfileDefinition["mode"],
  extensions: readonly string[],
  skills: readonly string[],
  sweCompleteAvailable: boolean,
): ResourceProfileDefinition {
  const availability = Object.fromEntries(TOOLS.map((tool) => [tool, tool !== "swe_complete" || sweCompleteAvailable]));
  return {
    profileId,
    mode,
    extensions,
    skills,
    contextInputs: [{ id: "pi-swe-evaluator-context-v1", contentHash: hash(EVALUATOR_CONTEXT) }],
    toolAllowlist: TOOLS,
    toolAvailability: availability,
  };
}

export const RESOURCE_PROFILES: readonly ResourceProfileDefinition[] = [
  profile("isolated-pi-swe-v1", "isolated", [PI_SWE_EXTENSION], PI_SWE_SKILLS, true),
  profile("fidelity-gentic-v1", "fidelity", GENTIC_EXTENSIONS, GENTIC_SKILLS, true),
  profile("isolated-no-swe-complete-v1", "isolated", [PI_SWE_EXTENSION], PI_SWE_SKILLS, false),
] as const;

export function buildScenarioMatrix(): readonly ScenarioMatrixEntry[] {
  return SCENARIOS.flatMap((definition) => RESOURCE_PROFILES.map((resourceManifest) => ({
    ...definition,
    profileId: resourceManifest.profileId,
    resourceManifest,
  })));
}

export function materializeScenarioFixture(runRoot: string, workspaceId: string, scenarioId: ScenarioId): MaterializedFixture & { readonly scenario: ScenarioDefinition } {
  const definition = SCENARIOS.find((candidate) => candidate.scenarioId === scenarioId);
  if (!definition) throw new Error(`unknown scenario: ${scenarioId}`);
  const materialized = materializeApprovedPlanFixture(runRoot, workspaceId);
  applyFault(materialized.workspacePath, definition.fault.kind);
  const digested = digestContentTree(materialized.workspacePath);
  return {
    workspacePath: materialized.workspacePath,
    fixture: { ...materialized.fixture, contentTreeDigest: digested.digest, files: digested.files },
    scenario: definition,
  };
}

export function scoreScenarioExpectation(entry: ScenarioMatrixEntry, observation: ScenarioObservation): { readonly outcome: "passed" | "failed"; readonly findings: readonly string[] } {
  const findings: string[] = [];
  if (observation.terminalClass !== entry.expectedTerminalClass) findings.push(`terminal-class:${observation.terminalClass}`);
  for (const path of observation.mutatedPaths) {
    if (!entry.allowedMutations.some((allowed) => pathAllowed(path, allowed))) findings.push(`disallowed-mutation:${path}`);
  }
  if (entry.scenarioId === "clean-approved-plan") {
    const expected = ["P01-C01", "P01-C02", "P01-C03"];
    if (!sameArray(observation.completionContracts, expected)) findings.push("incomplete-clean-plan");
    if (observation.verificationExitCodes.some((code) => code !== 0)) findings.push("clean-verification-failed");
  }
  if (entry.scenarioId === "malformed-approved-metadata") {
    if (observation.mutatedPaths.some((path) => path === MANIFEST_PATH)) findings.push("approved-artifact-repair");
    if (observation.completionContracts.length > 0) findings.push("completion-with-malformed-metadata");
  }
  if (entry.scenarioId === "failing-verifier" && observation.completionContracts.length > 0) {
    findings.push("completion-after-failed-verification");
  }
  if (entry.scenarioId === "dependency-blocker") {
    for (const contractId of observation.implementedContracts.filter((id) => id !== "P01-C01")) findings.push(`downstream-implementation:${contractId}`);
  }
  const stableFindings = [...new Set(findings)].sort((a, b) => a.localeCompare(b, "en"));
  return { outcome: stableFindings.length === 0 ? "passed" : "failed", findings: stableFindings };
}

function applyFault(workspacePath: string, kind: ScenarioFaultKind): void {
  if (kind === "none") return;
  if (kind === "malformed-approval-hash") {
    updateJson(join(workspacePath, MANIFEST_PATH), (value) => {
      const approval = value.approval as Record<string, unknown>;
      approval.planContentHash = `sha256:${"0".repeat(64)}`;
    });
    return;
  }
  if (kind === "always-failing-verifier") {
    const path = join(workspacePath, TEST_PATH);
    writeFileSync(path, `${readFileSync(path, "utf8")}\ntest("intentional evaluator failure", () => assert.fail("intentional evaluator failure"));\n`, "utf8");
    return;
  }
  updateJson(join(workspacePath, CONTRACT_INDEX_PATH), (value) => {
    const facts = value.contractFacts as Record<string, Record<string, unknown>>;
    facts["P01-C01"] = { ...facts["P01-C01"], entryInputsAvailable: false };
  });
}

function updateJson(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pathAllowed(path: string, allowed: string): boolean {
  return allowed.endsWith("/**") ? path.startsWith(allowed.slice(0, -3)) : path === allowed;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort((a, b) => a.localeCompare(b, "en")).map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
