import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeContractGraph, compareContractIds, CONTRACT_STATUSES, type ContractNode, type ContractStatus } from "./domain/contract-graph.ts";
import type { SweCanonicalInitiativeLink } from "./domain/capabilities.ts";
import { LEGACY_ADOPTION_REQUIREMENTS, LegacyPlanInspector, type LegacyPlanInspectionResult } from "./orchestrate.ts";
import {
  isValidTopic,
  parseInitiativeManifest,
  type InitiativeManifest,
  type InitiativeManifestDiagnostic,
} from "./domain/initiative.ts";
import {
  reduceReadiness,
  type ContractReadinessFacts,
  type ReadinessBlockingReason,
  type ReadinessGateResult,
  type ReduceReadinessResult,
} from "./domain/readiness.ts";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_LINKED_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 50;
const MAX_CANONICAL_MANIFESTS = 100;
export const CONTRACT_INDEX_SCHEMA_VERSION = 2 as const;
const LEGACY_CONTRACT_INDEX_SCHEMA_VERSION = 1 as const;

export type CanonicalInspectionDiagnosticCode =
  | "invalid_topic"
  | "manifest_missing"
  | "artifact_missing"
  | "artifact_outside_repository"
  | "artifact_too_large"
  | "read_error"
  | "json_parse_error"
  | "manifest_invalid"
  | "unsupported_version"
  | "contract_index_invalid"
  | "completion_transaction_pending"
  | "stale_link"
  | "migration_required"
  | "mixed_authority";

export type CanonicalInspectionDiagnostic = {
  readonly code: CanonicalInspectionDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly field?: string;
};

export type CanonicalCompletionRecord = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly planRevision: number;
  readonly contractPath: string;
  readonly preCompletionContentHash: string;
  readonly verification: { readonly path: string; readonly contentHash: string };
  readonly review: { readonly path: string; readonly contentHash: string; readonly decision: "approve" };
  readonly completedAt: string;
  readonly nextState: {
    readonly initiativeState: "executing" | "finalizing";
    readonly activeContractId: string | null;
    readonly readyContractIds: readonly string[];
  };
};

export type CanonicalCompletionIdentity = Pick<CanonicalCompletionRecord,
  "planRevision" | "contractPath" | "preCompletionContentHash" | "verification" | "review"> & {
  readonly topic: string;
  readonly contractId: string;
};

export function deriveCanonicalCompletionRequestId(identity: CanonicalCompletionIdentity): string {
  const canonical = {
    topic: identity.topic,
    contractId: identity.contractId,
    planRevision: identity.planRevision,
    contractPath: identity.contractPath,
    preCompletionContentHash: identity.preCompletionContentHash,
    verification: identity.verification,
    review: identity.review,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

export type CanonicalIndexedContract = ContractNode & { readonly contentHash?: string };
export type CanonicalMetadataMigration = {
  readonly fromSchemaVersion: 1;
  readonly toSchemaVersion: typeof CONTRACT_INDEX_SCHEMA_VERSION;
  readonly operation: "normalize-complete-advance";
  readonly requestId: string;
  readonly migratedAt: string;
};
export type CanonicalContractIndex = {
  readonly schemaVersion: typeof CONTRACT_INDEX_SCHEMA_VERSION;
  readonly contracts: readonly CanonicalIndexedContract[];
  readonly contractFacts: Readonly<Record<string, ContractReadinessFacts | undefined>>;
  readonly consequentialSpecialists: readonly string[];
  readonly completionRecords: Readonly<Record<string, CanonicalCompletionRecord | undefined>>;
  readonly migration?: CanonicalMetadataMigration;
};

export type CanonicalInspectorResult = {
  readonly sourceMode: "canonical" | "legacy";
  readonly topic: string;
  readonly manifestPath: string;
  readonly manifest?: InitiativeManifest;
  readonly contracts: readonly ContractNode[];
  readonly contractIndex?: CanonicalContractIndex;
  readonly contractIndexPath?: string;
  readonly migrationRequired: boolean;
  readonly contractIndexMigrationRequired: boolean;
  readonly manifestMigrationRequired: boolean;
  readonly completionRecords: Readonly<Record<string, CanonicalCompletionRecord | undefined>>;
  readonly gateEvaluation?: ReduceReadinessResult;
  readonly gates: readonly ReadinessGateResult[];
  readonly readyIds: readonly string[];
  readonly blockers: readonly ReadinessBlockingReason[];
  readonly diagnostics: readonly CanonicalInspectionDiagnostic[];
};

export type InspectCanonicalInitiativeRequest = {
  readonly cwd: string;
  readonly topic: string;
  /** Reserved for the completion recovery service while a durable journal blocks ordinary readers. */
  readonly recoveryMode?: boolean;
};

export type ResolveInitiativeRequest = {
  readonly cwd: string;
  readonly explicitTopic?: string;
  readonly persistedTopic?: string;
  readonly activeTodo?: unknown;
  readonly legacyInspector?: LegacyPlanInspector;
};

export type CanonicalInitiativeResolution = {
  readonly sourceMode: "canonical";
  readonly status: "canonical";
  readonly selectionSource: "explicit" | "persisted" | "manifest" | "todo";
  readonly topic: string;
  readonly candidateTopics: readonly string[];
  readonly inspection: CanonicalInspectorResult;
  readonly todoLink?: SweCanonicalInitiativeLink;
  readonly warnings: readonly string[];
};

export type InitiativeResolutionFailure = {
  readonly sourceMode: "resolution";
  readonly status: "ambiguous" | "not-found";
  readonly candidateTopics: readonly string[];
  readonly remediation: string;
  readonly warnings: readonly string[];
};

export type InitiativeResolution = CanonicalInitiativeResolution | LegacyPlanInspectionResult | InitiativeResolutionFailure;

type MutableInspection = CanonicalInspectionDiagnostic[];
type UnknownRecord = Record<string, unknown>;
type IndexedContract = CanonicalIndexedContract;
type ParsedContractIndex = {
  readonly contracts: readonly IndexedContract[];
  readonly contractFacts: Readonly<Record<string, ContractReadinessFacts | undefined>>;
  readonly consequentialSpecialists: readonly string[];
  readonly completionRecords: Readonly<Record<string, CanonicalCompletionRecord | undefined>>;
  readonly canonicalIndex?: CanonicalContractIndex;
  readonly migrationRequired: boolean;
};

export function inspectCanonicalInitiative(request: InspectCanonicalInitiativeRequest): CanonicalInspectorResult {
  const topic = normalizeTopic(request.topic);
  const manifestPath = topic ? `.model-artifacts/initiatives/${topic}/specs/manifest.json` : ".model-artifacts/initiatives/<invalid-topic>/specs/manifest.json";
  const legacyManifestPath = topic ? `.model-artifacts/specs/${topic}/manifest.json` : ".model-artifacts/specs/<invalid-topic>/manifest.json";
  const diagnostics: MutableInspection = [];
  if (!topic) {
    addDiagnostic(diagnostics, "invalid_topic", manifestPath, `invalid canonical topic: ${request.topic}`);
    return emptyResult(request.topic.trim(), manifestPath, diagnostics);
  }

  const repositoryRoot = resolveRepositoryRoot(request.cwd, diagnostics);
  if (!repositoryRoot) return emptyResult(topic, manifestPath, diagnostics);
  const canonicalExists = existsSync(resolve(repositoryRoot, manifestPath));
  const legacyExists = existsSync(resolve(repositoryRoot, legacyManifestPath));
  if (canonicalExists && legacyExists) {
    addDiagnostic(diagnostics, "mixed_authority", manifestPath, `layout-v1 and layout-v2 manifests both exist for ${topic}; migrate or remove legacy authority before execution`);
    return emptyResult(topic, manifestPath, diagnostics);
  }
  if (!canonicalExists && legacyExists) {
    addDiagnostic(diagnostics, "migration_required", legacyManifestPath, `layout-v1 manifest is inspection-only; migrate ${topic} to layout v2 before execution or writes`);
    return { ...emptyResult(topic, legacyManifestPath, diagnostics), sourceMode: "legacy", migrationRequired: true, manifestMigrationRequired: true };
  }
  const transactionPath = `.model-artifacts/system/logs/pi-swe/${topic}/completion-transaction.json`;
  if (!request.recoveryMode && existsSync(resolve(repositoryRoot, transactionPath))) {
    addDiagnostic(diagnostics, "completion_transaction_pending", transactionPath, `unfinished completion transaction blocks canonical inspection for ${topic}`);
    return emptyResult(topic, manifestPath, diagnostics);
  }
  const manifestValue = readJson(repositoryRoot, manifestPath, diagnostics, "manifest_missing");
  if (manifestValue === undefined) return emptyResult(topic, manifestPath, diagnostics);

  const parsedManifest = parseInitiativeManifest(manifestValue);
  if (!parsedManifest.ok) {
    for (const diagnostic of parsedManifest.diagnostics) addManifestDiagnostic(diagnostics, manifestPath, diagnostic);
    return emptyResult(topic, manifestPath, diagnostics);
  }
  const manifest = parsedManifest.manifest;
  if (manifest.topic !== topic) {
    addDiagnostic(diagnostics, "manifest_invalid", manifestPath, `manifest topic ${manifest.topic} does not match requested topic ${topic}`, "topic");
    return emptyResult(topic, manifestPath, diagnostics, manifest);
  }

  const indexPath = manifest.activePlan ? `${manifest.activePlan.contractRoot}/contracts.json` : undefined;
  const diagnosticsBeforeIndex = diagnostics.length;
  const parsedIndex = indexPath ? parseContractIndex(repositoryRoot, indexPath, topic, manifest, diagnostics) : emptyContractIndex();
  if (diagnostics.length > diagnosticsBeforeIndex) return emptyResult(topic, manifestPath, diagnostics, manifest);
  const contracts = parsedIndex.contracts.map(({ contentHash: _contentHash, ...contract }) => contract);
  const artifacts: Record<string, boolean> = {};

  verifyLinkedArtifact(repositoryRoot, manifest.activeSpec.path, manifest.activeSpec.contentHash, diagnostics, artifacts);
  if (manifest.activePlan) {
    verifyLinkedArtifact(repositoryRoot, manifest.activePlan.path, manifest.activePlan.contentHash, diagnostics, artifacts);
  }
  if ("approval" in manifest && manifest.approval) verifyLinkedArtifact(repositoryRoot, manifest.approval.reviewPath, undefined, diagnostics, artifacts);
  for (const specialist of Object.values(manifest.specialists)) {
    if (specialist.findingPath) verifyLinkedArtifact(repositoryRoot, specialist.findingPath, undefined, diagnostics, artifacts);
  }
  for (const contract of parsedIndex.contracts) {
    verifyLinkedArtifact(repositoryRoot, contract.path, contract.contentHash, diagnostics, artifacts);
  }
  for (const facts of Object.values(parsedIndex.contractFacts)) {
    if (facts?.deferral?.evidencePath) verifyLinkedArtifact(repositoryRoot, facts.deferral.evidencePath, undefined, diagnostics, artifacts);
  }
  for (const record of Object.values(parsedIndex.completionRecords)) {
    if (!record) continue;
    verifyLinkedArtifact(repositoryRoot, record.verification.path, record.verification.contentHash, diagnostics, artifacts);
    verifyLinkedArtifact(repositoryRoot, record.review.path, record.review.contentHash, diagnostics, artifacts);
  }
  if ("activeContract" in manifest && manifest.activeContract) {
    verifyLinkedArtifact(repositoryRoot, manifest.activeContract.path, undefined, diagnostics, artifacts);
    if (!contracts.some((contract) => contract.id === manifest.activeContract?.id && contract.path === manifest.activeContract.path)) {
      addDiagnostic(diagnostics, "stale_link", manifest.activeContract.path, `active contract ${manifest.activeContract.id} is not present in the active contract index`, "activeContract");
    }
  }

  const evidencedDeferrals = new Set(Object.entries(parsedIndex.contractFacts)
    .filter(([, facts]) => Boolean(facts?.deferral?.approved && facts.deferral.evidencePath && artifacts[facts.deferral.evidencePath]))
    .map(([id]) => id));
  const graph = analyzeContractGraph(contracts, undefined, evidencedDeferrals);
  const gateEvaluation = reduceReadiness({
    manifest,
    contracts,
    graph,
    artifacts,
    contractFacts: parsedIndex.contractFacts,
    consequentialSpecialists: parsedIndex.consequentialSpecialists,
  });

  return {
    sourceMode: "canonical",
    topic,
    manifestPath,
    manifest,
    contracts,
    ...(parsedIndex.canonicalIndex ? { contractIndex: parsedIndex.canonicalIndex, contractIndexPath: indexPath } : {}),
    migrationRequired: parsedIndex.migrationRequired || manifestValueRequiresMigration(manifestValue),
    contractIndexMigrationRequired: parsedIndex.migrationRequired,
    manifestMigrationRequired: manifestValueRequiresMigration(manifestValue),
    completionRecords: parsedIndex.completionRecords,
    gateEvaluation,
    gates: gateEvaluation.gates,
    readyIds: gateEvaluation.readyContracts,
    blockers: gateEvaluation.blockingReasons,
    diagnostics,
  };
}

export function resolveInitiative(request: ResolveInitiativeRequest): InitiativeResolution {
  const warnings: string[] = [];
  const explicitTopic = normalizeResolutionTopic(request.explicitTopic, "explicit topic", warnings);
  if (request.explicitTopic !== undefined && !explicitTopic) {
    return resolutionFailure("not-found", [], "provide one valid canonical or legacy topic", warnings);
  }
  const persistedTopic = normalizeResolutionTopic(request.persistedTopic, "persisted topic", warnings);
  const todoLink = readTodoCanonicalLink(request.activeTodo, warnings);
  const canonicalDiscovery = discoverActiveCanonicalTopics(request.cwd, warnings);
  const legacyManifestDiscovery = discoverLegacyManifestTopics(request.cwd, warnings);
  const activeCanonicalTopics = canonicalDiscovery.topics;
  const candidateTopics = sortedUnique([explicitTopic, persistedTopic, todoLink?.topic, ...activeCanonicalTopics, ...legacyManifestDiscovery.topics]);

  const selectorTopics = sortedUnique([explicitTopic, persistedTopic, todoLink?.topic]);
  if (selectorTopics.length > 1) {
    return resolutionFailure("ambiguous", candidateTopics, "select one topic explicitly and repair conflicting persisted or todo links", warnings);
  }

  const selectedTopic = explicitTopic ?? persistedTopic;
  if (selectedTopic) {
    const manifestPath = `.model-artifacts/initiatives/${selectedTopic}/specs/manifest.json`;
    const legacyManifestPath = `.model-artifacts/specs/${selectedTopic}/manifest.json`;
    if (persistedTopic || existsSync(resolve(request.cwd, manifestPath)) || existsSync(resolve(request.cwd, legacyManifestPath))) {
      return canonicalResolution(request.cwd, selectedTopic, explicitTopic ? "explicit" : "persisted", candidateTopics, todoLink, warnings);
    }
    if (activeCanonicalTopics.length || canonicalDiscovery.incomplete) {
      return resolutionFailure("ambiguous", candidateTopics, "create or select the requested canonical manifest, or repair the incomplete canonical initiative scan", warnings);
    }
    const legacy = (request.legacyInspector ?? new LegacyPlanInspector()).inspect({ cwd: request.cwd, topic: selectedTopic });
    return legacy.status === "legacy-unverified"
      ? { ...legacy, candidateTopics, warnings }
      : resolutionFailure("not-found", candidateTopics, "create a canonical manifest or provide a legacy todo-phase plan", warnings);
  }

  if (canonicalDiscovery.incomplete) {
    return resolutionFailure("ambiguous", candidateTopics, "select one topic explicitly after repairing or narrowing the canonical initiative scan", warnings);
  }
  if (activeCanonicalTopics.length > 1) {
    return resolutionFailure("ambiguous", candidateTopics, "select one candidate topic explicitly or persist one active initiative marker", warnings);
  }
  if (activeCanonicalTopics.length === 1) {
    if (todoLink && todoLink.topic !== activeCanonicalTopics[0]) {
      return resolutionFailure("ambiguous", candidateTopics, "select one topic explicitly or repair the conflicting todo canonical initiative link", warnings);
    }
    return canonicalResolution(request.cwd, activeCanonicalTopics[0], "manifest", candidateTopics, todoLink, warnings);
  }

  if (todoLink) {
    const manifestPath = `.model-artifacts/initiatives/${todoLink.topic}/specs/manifest.json`;
    if (existsSync(resolve(request.cwd, manifestPath))) {
      return canonicalResolution(request.cwd, todoLink.topic, "todo", candidateTopics, todoLink, warnings);
    }
    warnings.push(`todo canonical initiative link points to missing manifest ${manifestPath}`);
  }

  if (legacyManifestDiscovery.incomplete) {
    return resolutionFailure("ambiguous", candidateTopics, "repair or narrow the layout-v1 manifest scan before migration", warnings);
  }
  if (legacyManifestDiscovery.topics.length > 1) {
    return resolutionFailure("ambiguous", candidateTopics, "select one layout-v1 topic explicitly for inspection and migration guidance", warnings);
  }
  if (legacyManifestDiscovery.topics.length === 1) {
    const topic = legacyManifestDiscovery.topics[0]!;
    const manifestPath = `.model-artifacts/specs/${topic}/manifest.json`;
    return {
      sourceMode: "legacy",
      status: "migration-required",
      topic,
      manifestPath,
      candidatePaths: [manifestPath],
      candidateTopics,
      adoptionRequirements: LEGACY_ADOPTION_REQUIREMENTS,
      nextAction: "migrate-legacy-plan",
      warnings,
    };
  }

  const legacyInspector = request.legacyInspector ?? new LegacyPlanInspector();
  const legacyTopics = legacyInspector.listCandidateTopics(request.cwd);
  const allCandidates = sortedUnique([...candidateTopics, ...legacyTopics]);
  if (legacyTopics.length > 1) {
    return resolutionFailure("ambiguous", allCandidates, "select one legacy topic explicitly, then adopt it into canonical plan r1", warnings);
  }
  if (legacyTopics.length === 1) {
    const legacy = legacyInspector.inspect({ cwd: request.cwd, topic: legacyTopics[0] });
    return { ...legacy, candidateTopics: allCandidates, warnings };
  }
  return resolutionFailure("not-found", allCandidates, "create a canonical manifest or provide a legacy todo-phase plan", warnings);
}

function canonicalResolution(
  cwd: string,
  topic: string,
  selectionSource: CanonicalInitiativeResolution["selectionSource"],
  candidateTopics: readonly string[],
  todoLink: SweCanonicalInitiativeLink | undefined,
  warnings: readonly string[],
): CanonicalInitiativeResolution {
  return {
    sourceMode: "canonical",
    status: "canonical",
    selectionSource,
    topic,
    candidateTopics,
    inspection: inspectCanonicalInitiative({ cwd, topic }),
    ...(todoLink?.topic === topic ? { todoLink } : {}),
    warnings,
  };
}

function resolutionFailure(
  status: InitiativeResolutionFailure["status"],
  candidateTopics: readonly string[],
  remediation: string,
  warnings: readonly string[],
): InitiativeResolutionFailure {
  return { sourceMode: "resolution", status, candidateTopics, remediation, warnings };
}

function normalizeResolutionTopic(value: string | undefined, source: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (isValidTopic(normalized)) return normalized;
  warnings.push(`${source} is malformed`);
  return undefined;
}

function readTodoCanonicalLink(activeTodo: unknown, warnings: string[]): SweCanonicalInitiativeLink | undefined {
  if (activeTodo === undefined || activeTodo === null) return undefined;
  if (!isRecord(activeTodo)) {
    warnings.push("active todo peer data is malformed and was ignored");
    return undefined;
  }
  const value = activeTodo.canonicalInitiative;
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.topic !== "string" || !isValidTopic(value.topic)) {
    warnings.push("active todo canonical initiative link is malformed and was ignored");
    return undefined;
  }
  if (value.contractId !== undefined && (typeof value.contractId !== "string" || !value.contractId.trim())) return malformedTodoLink(warnings);
  if (value.contractPath !== undefined && (typeof value.contractPath !== "string" || !value.contractPath.startsWith(`.model-artifacts/initiatives/${value.topic}/plans/`))) return malformedTodoLink(warnings);
  if (value.planRevision !== undefined && (!Number.isInteger(value.planRevision) || (value.planRevision as number) < 1)) return malformedTodoLink(warnings);
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.some((dependency) => typeof dependency !== "string" || !dependency))) return malformedTodoLink(warnings);
  return {
    topic: value.topic,
    ...(typeof value.contractId === "string" ? { contractId: value.contractId } : {}),
    ...(typeof value.contractPath === "string" ? { contractPath: value.contractPath } : {}),
    ...(typeof value.planRevision === "number" ? { planRevision: value.planRevision } : {}),
    ...(Array.isArray(value.dependencies) ? { dependencies: [...value.dependencies] as string[] } : {}),
  };
}

function malformedTodoLink(warnings: string[]): undefined {
  warnings.push("active todo canonical initiative link is malformed and was ignored");
  return undefined;
}

function discoverActiveCanonicalTopics(cwd: string, warnings: string[]): { topics: string[]; incomplete: boolean } {
  const specsRoot = resolve(cwd, ".model-artifacts/initiatives");
  if (!existsSync(specsRoot)) return { topics: [], incomplete: false };
  const manifests: string[] = [];
  const scan = { incomplete: false };
  collectCanonicalManifests(specsRoot, "", manifests, scan);
  if (scan.incomplete) warnings.push(`canonical manifest scan was incomplete after ${MAX_CANONICAL_MANIFESTS} candidates or a filesystem read error`);
  const topics: string[] = [];
  for (const relativeManifest of manifests.slice(0, MAX_CANONICAL_MANIFESTS)) {
    if (!relativeManifest.endsWith("/specs/manifest.json")) continue;
    const topic = relativeManifest.slice(0, -"/specs/manifest.json".length);
    try {
      const content = readFileSync(resolve(specsRoot, relativeManifest), "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES) {
        topics.push(topic);
        continue;
      }
      const parsed = parseInitiativeManifest(JSON.parse(content));
      if (!parsed.ok || parsed.manifest.topic !== topic || parsed.manifest.initiativeState !== "complete") topics.push(topic);
    } catch {
      topics.push(topic);
    }
  }
  return { topics: sortedUnique(topics), incomplete: scan.incomplete };
}

function discoverLegacyManifestTopics(cwd: string, warnings: string[]): { topics: string[]; incomplete: boolean } {
  const specsRoot = resolve(cwd, ".model-artifacts/specs");
  if (!existsSync(specsRoot)) return { topics: [], incomplete: false };
  const manifests: string[] = [];
  const scan = { incomplete: false };
  collectLegacyManifests(specsRoot, "", manifests, scan);
  if (scan.incomplete) warnings.push(`layout-v1 manifest scan was incomplete after ${MAX_CANONICAL_MANIFESTS} candidates or a filesystem read error`);
  return {
    topics: sortedUnique(manifests.map((path) => path.slice(0, -"/manifest.json".length))),
    incomplete: scan.incomplete,
  };
}

function collectLegacyManifests(absoluteDir: string, relativeDir: string, manifests: string[], scan: { incomplete: boolean }): void {
  if (manifests.length > MAX_CANONICAL_MANIFESTS) {
    scan.incomplete = true;
    return;
  }
  try {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collectLegacyManifests(resolve(absoluteDir, entry.name), relativePath, manifests, scan);
      else if (entry.isFile() && entry.name === "manifest.json" && relativeDir) manifests.push(relativePath);
      if (manifests.length > MAX_CANONICAL_MANIFESTS) {
        scan.incomplete = true;
        return;
      }
    }
  } catch {
    scan.incomplete = true;
  }
}

function collectCanonicalManifests(absoluteDir: string, relativeDir: string, manifests: string[], scan: { incomplete: boolean }): void {
  if (manifests.length > MAX_CANONICAL_MANIFESTS) {
    scan.incomplete = true;
    return;
  }
  try {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collectCanonicalManifests(resolve(absoluteDir, entry.name), relativePath, manifests, scan);
      else if (entry.isFile() && entry.name === "manifest.json" && relativeDir.endsWith("/specs")) manifests.push(relativePath);
      if (manifests.length > MAX_CANONICAL_MANIFESTS) {
        scan.incomplete = true;
        return;
      }
    }
  } catch {
    scan.incomplete = true;
  }
}

function sortedUnique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function parseContractIndex(
  repositoryRoot: string,
  indexPath: string,
  topic: string,
  manifest: InitiativeManifest,
  diagnostics: MutableInspection,
): ParsedContractIndex {
  const diagnosticCount = diagnostics.length;
  const value = readJson(repositoryRoot, indexPath, diagnostics, "artifact_missing");
  if (!isRecord(value)) {
    if (value !== undefined) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contract index must be an object");
    return emptyContractIndex();
  }
  const legacy = value.schemaVersion === LEGACY_CONTRACT_INDEX_SCHEMA_VERSION;
  if (!legacy && value.schemaVersion !== CONTRACT_INDEX_SCHEMA_VERSION) {
    addDiagnostic(diagnostics, "unsupported_version", indexPath, `supported contract index schema versions are ${LEGACY_CONTRACT_INDEX_SCHEMA_VERSION} and ${CONTRACT_INDEX_SCHEMA_VERSION}`, "schemaVersion");
    return emptyContractIndex();
  }
  if (!Array.isArray(value.contracts) || value.contracts.length > 500) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contracts must be a bounded array", "contracts");
    return emptyContractIndex();
  }

  const contracts: IndexedContract[] = [];
  const legacyFacts: Record<string, ContractReadinessFacts> = {};
  const legacySpecialists: string[] = [];
  for (let index = 0; index < value.contracts.length; index += 1) {
    const candidate = value.contracts[index];
    const parsed = parseIndexedContract(candidate, indexPath, `contracts[${index}]`, topic, manifest, diagnostics, legacy);
    if (!parsed) continue;
    contracts.push(parsed);
    if (legacy && isRecord(candidate)) {
      const facts = parseLegacyReadiness(candidate.readiness, parsed, indexPath, `contracts[${index}].readiness`, topic, diagnostics);
      if (facts) legacyFacts[parsed.id] = facts;
      legacySpecialists.push(...parseStringArray(candidate.consequentialSpecialistIds, indexPath, `contracts[${index}].consequentialSpecialistIds`, diagnostics));
    }
  }
  const currentFacts = parseContractFacts(value.contractFacts, indexPath, topic, diagnostics);
  for (const [id, facts] of Object.entries(legacyFacts)) {
    if (currentFacts[id] !== undefined && JSON.stringify(currentFacts[id]) !== JSON.stringify(facts)) {
      addDiagnostic(diagnostics, "contract_index_invalid", indexPath, `legacy and canonical readiness facts conflict for contract ${id}`, `contractFacts.${id}`);
    }
  }
  const contractFacts = { ...legacyFacts, ...currentFacts };
  const consequentialSpecialists = [...new Set([
    ...parseStringArray(value.consequentialSpecialists, indexPath, "consequentialSpecialists", diagnostics),
    ...legacySpecialists,
  ].map(normalizeSpecialistId))].sort();
  const completionRecords = parseCompletionRecords(value.completionRecords, contracts, indexPath, topic, manifest, diagnostics);
  const migration = legacy ? undefined : parseMetadataMigration(value.migration, indexPath, diagnostics);
  if (diagnostics.length !== diagnosticCount) return emptyContractIndex();
  const canonicalIndex: CanonicalContractIndex = {
    schemaVersion: CONTRACT_INDEX_SCHEMA_VERSION,
    contracts,
    contractFacts,
    consequentialSpecialists,
    completionRecords,
    ...(migration ? { migration } : {}),
  };
  return { contracts, contractFacts, consequentialSpecialists, completionRecords, canonicalIndex, migrationRequired: legacy };
}

function parseIndexedContract(
  value: unknown,
  indexPath: string,
  field: string,
  topic: string,
  manifest: InitiativeManifest,
  diagnostics: MutableInspection,
  legacy: boolean,
): IndexedContract | undefined {
  if (!isRecord(value)) return invalidIndex(diagnostics, indexPath, field, "contract must be an object");
  const before = diagnostics.length;
  const kind = value.kind;
  const id = value.id;
  const canonicalDependencies = value.dependsOn;
  const legacyDependencies = value.dependencies;
  if (canonicalDependencies !== undefined && legacyDependencies !== undefined && JSON.stringify(canonicalDependencies) !== JSON.stringify(legacyDependencies)) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "dependsOn conflicts with legacy dependencies", `${field}.dependsOn`);
  }
  const dependsOn = canonicalDependencies ?? (legacy ? legacyDependencies : undefined);
  const canonicalPath = value.path;
  const legacyPath = value.canonicalPath;
  if (canonicalPath !== undefined && legacyPath !== undefined && canonicalPath !== legacyPath) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "path conflicts with legacy canonicalPath", `${field}.path`);
  }
  const path = canonicalPath ?? (legacy ? legacyPath : undefined);
  const planRevision = value.planRevision;
  const status = normalizeContractStatus(value.status, legacy);
  const contentHash = value.contentHash;
  const derivedParent = typeof id === "string" && id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : undefined;
  const parentId = value.parentId ?? (legacy && kind === "subphase" ? derivedParent : undefined);

  if (kind !== "phase" && kind !== "subphase") addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contract kind must be phase or subphase", `${field}.kind`);
  if (typeof id !== "string" || !id || id.length > 32) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contract id must be a bounded string", `${field}.id`);
  if (!Array.isArray(dependsOn) || dependsOn.some((entry) => typeof entry !== "string" || !entry) || dependsOn.length > 500) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contract dependencies must be a bounded string array", `${field}.dependsOn`);
  }
  if (!Number.isSafeInteger(planRevision) || (planRevision as number) <= 0) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "plan revision must be a positive integer", `${field}.planRevision`);
  if (typeof path !== "string" || !isTopicArtifactPath(path, "plans", topic) || !manifest.activePlan || !path.startsWith(`${manifest.activePlan.contractRoot}/`)) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, `contract path must remain under the active plan contract root for ${topic}`, `${field}.path`);
  }
  if (!status) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, `contract status is unsupported: ${String(value.status)}`, `${field}.status`);
  if (contentHash !== undefined && !isSha256(contentHash)) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "content hash must use sha256:<hex>", `${field}.contentHash`);
  if (kind === "subphase" && (typeof parentId !== "string" || !parentId)) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "subphase parentId is required and could not be derived", `${field}.parentId`);
  if (kind === "phase" && value.parentId !== undefined) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "phase cannot declare parentId", `${field}.parentId`);
  if (diagnostics.length !== before) return undefined;

  const base = { id: id as string, dependsOn: dependsOn as string[], planRevision: planRevision as number, path: path as string, status: status!, ...(contentHash ? { contentHash: contentHash as string } : {}) };
  return kind === "phase" ? { kind, ...base } : { kind: "subphase", parentId: parentId as string, ...base };
}

function normalizeContractStatus(value: unknown, legacy: boolean): ContractStatus | undefined {
  if ((CONTRACT_STATUSES as readonly unknown[]).includes(value)) return value as ContractStatus;
  if (!legacy) return undefined;
  if (value === "proposed" || value === "approved_not_started" || value === "awaiting_dependency") return "pending";
  if (value === "started" || value === "active" || value === "implementing") return "in_progress";
  if (value === "completed") return "complete";
  return undefined;
}

function parseLegacyReadiness(
  value: unknown,
  contract: IndexedContract,
  path: string,
  field: string,
  topic: string,
  diagnostics: MutableInspection,
): ContractReadinessFacts | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return invalidIndex(diagnostics, path, field, "legacy readiness must be an object");
  const before = diagnostics.length;
  for (const key of ["entryInputs", "capabilities", "acceptance", "verification"] as const) {
    if (typeof value[key] !== "boolean") addDiagnostic(diagnostics, "contract_index_invalid", path, `${field}.${key} must be boolean`, `${field}.${key}`);
  }
  const applicability = typeof value.applicability === "boolean"
    ? "applicable"
    : (["applicable", "not-applicable", "unresolved"] as const).includes(value.applicability as any)
      ? value.applicability as ContractReadinessFacts["applicability"]
      : undefined;
  if (!applicability) addDiagnostic(diagnostics, "contract_index_invalid", path, `${field}.applicability is unsupported`, `${field}.applicability`);
  let deferral: ContractReadinessFacts["deferral"];
  if (value.approvedDeferrals !== undefined) {
    if (!Array.isArray(value.approvedDeferrals) || value.approvedDeferrals.length > 1 || value.approvedDeferrals.some((entry) => typeof entry !== "string" || (!isTopicArtifactPath(entry, "findings", topic) && !isTopicArtifactPath(entry, "reports", topic)))) {
      addDiagnostic(diagnostics, "contract_index_invalid", path, `${field}.approvedDeferrals must be empty or contain one topic-confined evidence path`, `${field}.approvedDeferrals`);
    } else if (value.approvedDeferrals.length === 1) {
      deferral = { approved: true, evidencePath: value.approvedDeferrals[0] as string };
    }
  }
  if (diagnostics.length !== before) return undefined;
  const entryInputs = value.entryInputs as boolean;
  return {
    // Legacy writers used this bit for dependency state. Dependency satisfaction is now graph-derived.
    entryInputsAvailable: contract.dependsOn.length > 0 && !entryInputs ? true : entryInputs,
    capabilitiesAvailable: value.capabilities as boolean,
    applicability: applicability!,
    acceptanceDefined: value.acceptance as boolean,
    verificationDefined: value.verification as boolean,
    ...(deferral ? { deferral } : {}),
  };
}

function normalizeSpecialistId(value: string): string {
  const normalized = value === "accessibilityUx" ? "accessibility-ux" : value.toLowerCase().replaceAll("_", "-");
  return normalized === "accessibility-ux" ? normalized : normalized;
}

function parseMetadataMigration(value: unknown, path: string, diagnostics: MutableInspection): CanonicalMetadataMigration | undefined {
  if (value === undefined) return undefined;
  const keys = new Set(["fromSchemaVersion", "toSchemaVersion", "operation", "requestId", "migratedAt"]);
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || value.fromSchemaVersion !== 1
    || value.toSchemaVersion !== CONTRACT_INDEX_SCHEMA_VERSION
    || value.operation !== "normalize-complete-advance"
    || !isSha256(value.requestId)
    || typeof value.migratedAt !== "string"
    || Number.isNaN(Date.parse(value.migratedAt))) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, "migration must be a closed canonical metadata migration record", "migration");
    return undefined;
  }
  return value as CanonicalMetadataMigration;
}

function manifestValueRequiresMigration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const approval = isRecord(value.approval) ? value.approval : undefined;
  const specialists = isRecord(value.specialists) ? value.specialists : undefined;
  return approval?.decision === "approve" || specialists?.accessibilityUx !== undefined || specialists?.ACCESSIBILITY_UX !== undefined;
}

function parseCompletionRecords(
  value: unknown,
  contracts: readonly IndexedContract[],
  path: string,
  topic: string,
  manifest: InitiativeManifest,
  diagnostics: MutableInspection,
): Readonly<Record<string, CanonicalCompletionRecord | undefined>> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 500) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, "completionRecords must be a bounded object", "completionRecords");
    return {};
  }
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const records: Record<string, CanonicalCompletionRecord> = {};
  const recordKeys = new Set(["schemaVersion", "requestId", "planRevision", "contractPath", "preCompletionContentHash", "verification", "review", "completedAt", "nextState"]);
  for (const [id, candidate] of Object.entries(value)) {
    const field = `completionRecords.${id}`;
    const contract = byId.get(id);
    if (!contract || contract.status !== "complete") {
      addDiagnostic(diagnostics, "contract_index_invalid", path, `completion record ${id} requires an indexed complete contract`, field);
      continue;
    }
    if (!isRecord(candidate) || !hasExactKeys(candidate, recordKeys)) {
      addDiagnostic(diagnostics, "contract_index_invalid", path, `completion record ${id} has unknown or missing fields`, field);
      continue;
    }
    const verification = readCompletionEvidence(candidate.verification, path, topic, `${field}.verification`, diagnostics, false);
    const review = readCompletionEvidence(candidate.review, path, topic, `${field}.review`, diagnostics, true);
    const nextState = readCompletionNextState(candidate.nextState, path, `${field}.nextState`, byId, diagnostics);
    const valid = candidate.schemaVersion === 1
      && isSha256(candidate.requestId)
      && candidate.requestId === deriveCanonicalCompletionRequestId({
        topic,
        contractId: id,
        planRevision: candidate.planRevision as number,
        contractPath: candidate.contractPath as string,
        preCompletionContentHash: candidate.preCompletionContentHash as string,
        verification: verification ?? { path: "", contentHash: "" },
        review: review ? { ...review, decision: "approve" } : { path: "", contentHash: "", decision: "approve" },
      })
      && Number.isSafeInteger(candidate.planRevision)
      && (candidate.planRevision as number) > 0
      && candidate.planRevision === manifest.activePlan?.revision
      && candidate.planRevision === contract.planRevision
      && candidate.contractPath === contract.path
      && isSha256(candidate.preCompletionContentHash)
      && candidate.preCompletionContentHash === contract.contentHash
      && typeof candidate.completedAt === "string"
      && !Number.isNaN(Date.parse(candidate.completedAt));
    if (!valid || !verification || !review || !nextState) {
      addDiagnostic(diagnostics, "contract_index_invalid", path, `completion record ${id} does not match its contract, plan, or evidence schema`, field);
      continue;
    }
    records[id] = {
      schemaVersion: 1,
      requestId: candidate.requestId as string,
      planRevision: candidate.planRevision as number,
      contractPath: candidate.contractPath as string,
      preCompletionContentHash: candidate.preCompletionContentHash as string,
      verification,
      review: { ...review, decision: "approve" },
      completedAt: candidate.completedAt as string,
      nextState,
    };
  }
  return records;
}

function readCompletionEvidence(
  value: unknown,
  path: string,
  topic: string,
  field: string,
  diagnostics: MutableInspection,
  review: boolean,
): { path: string; contentHash: string; decision?: "approve" } | undefined {
  const expected = new Set(review ? ["path", "contentHash", "decision"] : ["path", "contentHash"]);
  if (!isRecord(value) || !hasExactKeys(value, expected)
    || typeof value.path !== "string"
    || !isTopicArtifactPath(value.path, "reports", topic)
    || !isSha256(value.contentHash)
    || (review && value.decision !== "approve")) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, `${field} must be closed, path-confined, and hash-addressed`, field);
    return undefined;
  }
  return { path: value.path, contentHash: value.contentHash, ...(review ? { decision: "approve" as const } : {}) };
}

function readCompletionNextState(
  value: unknown,
  path: string,
  field: string,
  contracts: ReadonlyMap<string, IndexedContract>,
  diagnostics: MutableInspection,
): CanonicalCompletionRecord["nextState"] | undefined {
  const expected = new Set(["initiativeState", "activeContractId", "readyContractIds"]);
  if (!isRecord(value) || !hasExactKeys(value, expected)
    || (value.initiativeState !== "executing" && value.initiativeState !== "finalizing")
    || (value.activeContractId !== null && (typeof value.activeContractId !== "string" || !contracts.has(value.activeContractId)))
    || !Array.isArray(value.readyContractIds)) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, `${field} must be a bounded historical snapshot of indexed IDs`, field);
    return undefined;
  }
  const readyContractIds = value.readyContractIds;
  if (readyContractIds.length > 500
    || readyContractIds.some((id) => typeof id !== "string" || !contracts.has(id))
    || new Set(readyContractIds).size !== readyContractIds.length
    || [...readyContractIds].sort(compareContractIds).some((id, index) => id !== readyContractIds[index])) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, `${field} must be a bounded historical snapshot of indexed IDs`, field);
    return undefined;
  }
  return {
    initiativeState: value.initiativeState,
    activeContractId: value.activeContractId as string | null,
    readyContractIds: [...readyContractIds] as string[],
  };
}

function hasExactKeys(value: UnknownRecord, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function parseContractFacts(value: unknown, path: string, topic: string, diagnostics: MutableInspection): Readonly<Record<string, ContractReadinessFacts | undefined>> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 500) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, "contractFacts must be a bounded object", "contractFacts");
    return {};
  }
  const facts: Record<string, ContractReadinessFacts> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)
      || typeof candidate.entryInputsAvailable !== "boolean"
      || typeof candidate.capabilitiesAvailable !== "boolean"
      || !["applicable", "not-applicable", "unresolved"].includes(candidate.applicability as string)
      || typeof candidate.acceptanceDefined !== "boolean"
      || typeof candidate.verificationDefined !== "boolean") {
      addDiagnostic(diagnostics, "contract_index_invalid", path, `invalid readiness facts for contract ${id}`, `contractFacts.${id}`);
      continue;
    }
    let deferral: ContractReadinessFacts["deferral"];
    if (candidate.deferral !== undefined) {
      if (!isRecord(candidate.deferral)) {
        addDiagnostic(diagnostics, "contract_index_invalid", path, `deferral for contract ${id} must be an object with boolean approved`, `contractFacts.${id}.deferral`);
        continue;
      }
      let valid = true;
      if (typeof candidate.deferral.approved !== "boolean") {
        addDiagnostic(diagnostics, "contract_index_invalid", path, `deferral for contract ${id} must declare boolean approved`, `contractFacts.${id}.deferral`);
        valid = false;
      }
      const evidencePath = candidate.deferral.evidencePath;
      if (evidencePath !== undefined
        && (typeof evidencePath !== "string"
          || (!isTopicArtifactPath(evidencePath, "findings", topic) && !isTopicArtifactPath(evidencePath, "reports", topic)))) {
        addDiagnostic(diagnostics, "contract_index_invalid", path, `deferral evidence for contract ${id} must remain under findings or reports for ${topic}`, `contractFacts.${id}.deferral.evidencePath`);
        valid = false;
      }
      if (!valid) continue;
      deferral = {
        approved: candidate.deferral.approved as boolean,
        ...(typeof evidencePath === "string" ? { evidencePath } : {}),
      };
    }
    facts[id] = {
      entryInputsAvailable: candidate.entryInputsAvailable,
      capabilitiesAvailable: candidate.capabilitiesAvailable,
      applicability: candidate.applicability as ContractReadinessFacts["applicability"],
      acceptanceDefined: candidate.acceptanceDefined,
      verificationDefined: candidate.verificationDefined,
      ...(deferral ? { deferral } : {}),
    };
  }
  return facts;
}

function parseStringArray(value: unknown, path: string, field: string, diagnostics: MutableInspection): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || entry.length > 128)) {
    addDiagnostic(diagnostics, "contract_index_invalid", path, `${field} must be a bounded string array`, field);
    return [];
  }
  return [...value].sort();
}

function verifyLinkedArtifact(
  repositoryRoot: string,
  artifactPath: string,
  expectedHash: string | undefined,
  diagnostics: MutableInspection,
  artifacts: Record<string, boolean>,
): void {
  const absolutePath = safeAbsolutePath(repositoryRoot, artifactPath, diagnostics);
  if (!absolutePath || !existsSync(absolutePath)) {
    if (absolutePath) addDiagnostic(diagnostics, "artifact_missing", artifactPath, `linked artifact does not exist: ${artifactPath}`);
    artifacts[artifactPath] = false;
    return;
  }
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      addDiagnostic(diagnostics, "artifact_missing", artifactPath, `linked artifact is not a file: ${artifactPath}`);
      artifacts[artifactPath] = false;
      return;
    }
    if (stat.size > MAX_LINKED_ARTIFACT_BYTES) {
      addDiagnostic(diagnostics, "artifact_too_large", artifactPath, `linked artifact exceeds ${MAX_LINKED_ARTIFACT_BYTES} bytes`);
      artifacts[artifactPath] = false;
      return;
    }
    const realPath = realpathSync(absolutePath);
    if (!isWithin(repositoryRoot, realPath)) {
      addDiagnostic(diagnostics, "artifact_outside_repository", artifactPath, `linked artifact resolves outside repository: ${artifactPath}`);
      artifacts[artifactPath] = false;
      return;
    }
    const content = readFileSync(realPath, "utf8");
    if (expectedHash) {
      const actualHash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      if (!isSha256(expectedHash) || actualHash !== expectedHash) {
        addDiagnostic(diagnostics, "stale_link", artifactPath, `content hash does not match linked artifact: ${artifactPath}`);
        artifacts[artifactPath] = false;
        return;
      }
    }
    artifacts[artifactPath] = true;
  } catch (error) {
    addDiagnostic(diagnostics, "read_error", artifactPath, `cannot read linked artifact ${artifactPath}: ${errorMessage(error)}`);
    artifacts[artifactPath] = false;
  }
}

function readJson(
  repositoryRoot: string,
  path: string,
  diagnostics: MutableInspection,
  missingCode: Extract<CanonicalInspectionDiagnosticCode, "manifest_missing" | "artifact_missing">,
): unknown | undefined {
  const absolutePath = safeAbsolutePath(repositoryRoot, path, diagnostics);
  if (!absolutePath || !existsSync(absolutePath)) {
    if (absolutePath) addDiagnostic(diagnostics, missingCode, path, `required JSON file does not exist: ${path}`);
    return undefined;
  }
  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) {
      addDiagnostic(diagnostics, stat.size > MAX_JSON_BYTES ? "artifact_too_large" : "read_error", path, `JSON file must be a regular file no larger than ${MAX_JSON_BYTES} bytes`);
      return undefined;
    }
    const realPath = realpathSync(absolutePath);
    if (!isWithin(repositoryRoot, realPath)) {
      addDiagnostic(diagnostics, "artifact_outside_repository", path, `JSON file resolves outside repository: ${path}`);
      return undefined;
    }
    return JSON.parse(readFileSync(realPath, "utf8"));
  } catch (error) {
    const code = error instanceof SyntaxError ? "json_parse_error" : "read_error";
    addDiagnostic(diagnostics, code, path, `cannot read JSON file ${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

function resolveRepositoryRoot(cwd: string, diagnostics: MutableInspection): string | undefined {
  try {
    const repositoryRoot = realpathSync(resolve(cwd));
    if (!statSync(repositoryRoot).isDirectory()) {
      addDiagnostic(diagnostics, "read_error", cwd, `repository cwd is not a directory: ${cwd}`);
      return undefined;
    }
    return repositoryRoot;
  } catch (error) {
    addDiagnostic(diagnostics, "read_error", cwd, `cannot resolve repository cwd ${cwd}: ${errorMessage(error)}`);
    return undefined;
  }
}

function safeAbsolutePath(repositoryRoot: string, path: string, diagnostics: MutableInspection): string | undefined {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    addDiagnostic(diagnostics, "artifact_outside_repository", path, `artifact path is not a safe repository-relative path: ${path}`);
    return undefined;
  }
  const absolutePath = resolve(repositoryRoot, path);
  if (!isWithin(repositoryRoot, absolutePath)) {
    addDiagnostic(diagnostics, "artifact_outside_repository", path, `artifact path leaves repository: ${path}`);
    return undefined;
  }
  return absolutePath;
}

function normalizeTopic(topic: string): string | undefined {
  const normalized = topic.trim().replace(/^\/+|\/+$/g, "");
  return isValidTopic(normalized) ? normalized : undefined;
}

function isTopicArtifactPath(path: string, kind: string, topic: string): boolean {
  return path.startsWith(`.model-artifacts/initiatives/${topic}/${kind}/`) && !path.includes("\\") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function emptyContractIndex(): ParsedContractIndex {
  return { contracts: [], contractFacts: {}, consequentialSpecialists: [], completionRecords: {}, migrationRequired: false };
}

function emptyResult(
  topic: string,
  manifestPath: string,
  diagnostics: readonly CanonicalInspectionDiagnostic[],
  manifest?: InitiativeManifest,
): CanonicalInspectorResult {
  return { sourceMode: "canonical", topic, manifestPath, ...(manifest ? { manifest } : {}), contracts: [], migrationRequired: false, contractIndexMigrationRequired: false, manifestMigrationRequired: false, completionRecords: {}, gates: [], readyIds: [], blockers: [], diagnostics };
}

function invalidIndex(diagnostics: MutableInspection, path: string, field: string, message: string): undefined {
  addDiagnostic(diagnostics, "contract_index_invalid", path, message, field);
  return undefined;
}

function addManifestDiagnostic(diagnostics: MutableInspection, path: string, diagnostic: InitiativeManifestDiagnostic): void {
  addDiagnostic(
    diagnostics,
    diagnostic.code === "unsupported_schema_version" ? "unsupported_version" : "manifest_invalid",
    path,
    diagnostic.message,
    diagnostic.field,
  );
}

function addDiagnostic(diagnostics: MutableInspection, code: CanonicalInspectionDiagnosticCode, path: string, message: string, field?: string): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ code, path, message, ...(field ? { field } : {}) });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
