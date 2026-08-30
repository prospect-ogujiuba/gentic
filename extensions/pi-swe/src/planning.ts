import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeContractGraph, CONTRACT_STATUSES, type ContractNode, type ContractStatus } from "./domain/contract-graph.ts";
import type { SweCanonicalInitiativeLink } from "./domain/capabilities.ts";
import { LegacyPlanInspector, type LegacyPlanInspectionResult } from "./orchestrate.ts";
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
const CONTRACT_INDEX_SCHEMA_VERSION = 1 as const;

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
  | "stale_link";

export type CanonicalInspectionDiagnostic = {
  readonly code: CanonicalInspectionDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly field?: string;
};

export type CanonicalContractIndex = {
  readonly schemaVersion: typeof CONTRACT_INDEX_SCHEMA_VERSION;
  readonly contracts: readonly ContractNode[];
  readonly contractFacts: Readonly<Record<string, ContractReadinessFacts | undefined>>;
  readonly consequentialSpecialists: readonly string[];
};

export type CanonicalInspectorResult = {
  readonly sourceMode: "canonical";
  readonly topic: string;
  readonly manifestPath: string;
  readonly manifest?: InitiativeManifest;
  readonly contracts: readonly ContractNode[];
  readonly gateEvaluation?: ReduceReadinessResult;
  readonly gates: readonly ReadinessGateResult[];
  readonly readyIds: readonly string[];
  readonly blockers: readonly ReadinessBlockingReason[];
  readonly diagnostics: readonly CanonicalInspectionDiagnostic[];
};

export type InspectCanonicalInitiativeRequest = {
  readonly cwd: string;
  readonly topic: string;
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
type IndexedContract = ContractNode & { readonly contentHash?: string };

export function inspectCanonicalInitiative(request: InspectCanonicalInitiativeRequest): CanonicalInspectorResult {
  const topic = normalizeTopic(request.topic);
  const manifestPath = topic ? `.model-artifacts/specs/${topic}/manifest.json` : ".model-artifacts/specs/<invalid-topic>/manifest.json";
  const diagnostics: MutableInspection = [];
  if (!topic) {
    addDiagnostic(diagnostics, "invalid_topic", manifestPath, `invalid canonical topic: ${request.topic}`);
    return emptyResult(request.topic.trim(), manifestPath, diagnostics);
  }

  const repositoryRoot = resolveRepositoryRoot(request.cwd, diagnostics);
  if (!repositoryRoot) return emptyResult(topic, manifestPath, diagnostics);
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
  if ("activeContract" in manifest && manifest.activeContract) {
    verifyLinkedArtifact(repositoryRoot, manifest.activeContract.path, undefined, diagnostics, artifacts);
    if (!contracts.some((contract) => contract.id === manifest.activeContract?.id && contract.path === manifest.activeContract.path)) {
      addDiagnostic(diagnostics, "stale_link", manifest.activeContract.path, `active contract ${manifest.activeContract.id} is not present in the active contract index`, "activeContract");
    }
  }

  const graph = analyzeContractGraph(contracts);
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
  const activeCanonicalTopics = canonicalDiscovery.topics;
  const candidateTopics = sortedUnique([explicitTopic, persistedTopic, todoLink?.topic, ...activeCanonicalTopics]);

  const selectorTopics = sortedUnique([explicitTopic, persistedTopic, todoLink?.topic]);
  if (selectorTopics.length > 1) {
    return resolutionFailure("ambiguous", candidateTopics, "select one topic explicitly and repair conflicting persisted or todo links", warnings);
  }

  const selectedTopic = explicitTopic ?? persistedTopic;
  if (selectedTopic) {
    const manifestPath = `.model-artifacts/specs/${selectedTopic}/manifest.json`;
    if (persistedTopic || existsSync(resolve(request.cwd, manifestPath))) {
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
    const manifestPath = `.model-artifacts/specs/${todoLink.topic}/manifest.json`;
    if (existsSync(resolve(request.cwd, manifestPath))) {
      return canonicalResolution(request.cwd, todoLink.topic, "todo", candidateTopics, todoLink, warnings);
    }
    warnings.push(`todo canonical initiative link points to missing manifest ${manifestPath}`);
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
  if (value.contractPath !== undefined && (typeof value.contractPath !== "string" || !value.contractPath.startsWith(`.model-artifacts/plans/${value.topic}/`))) return malformedTodoLink(warnings);
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
  const specsRoot = resolve(cwd, ".model-artifacts/specs");
  if (!existsSync(specsRoot)) return { topics: [], incomplete: false };
  const manifests: string[] = [];
  const scan = { incomplete: false };
  collectCanonicalManifests(specsRoot, "", manifests, scan);
  if (scan.incomplete) warnings.push(`canonical manifest scan was incomplete after ${MAX_CANONICAL_MANIFESTS} candidates or a filesystem read error`);
  const topics: string[] = [];
  for (const relativeManifest of manifests.slice(0, MAX_CANONICAL_MANIFESTS)) {
    const topic = relativeManifest.slice(0, -"/manifest.json".length);
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

function sortedUnique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function parseContractIndex(
  repositoryRoot: string,
  indexPath: string,
  topic: string,
  manifest: InitiativeManifest,
  diagnostics: MutableInspection,
): { contracts: readonly IndexedContract[]; contractFacts: Readonly<Record<string, ContractReadinessFacts | undefined>>; consequentialSpecialists: readonly string[] } {
  const diagnosticCount = diagnostics.length;
  const value = readJson(repositoryRoot, indexPath, diagnostics, "artifact_missing");
  if (!isRecord(value)) {
    if (value !== undefined) addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contract index must be an object");
    return emptyContractIndex();
  }
  if (value.schemaVersion !== CONTRACT_INDEX_SCHEMA_VERSION) {
    addDiagnostic(diagnostics, "unsupported_version", indexPath, `supported contract index schema version is ${CONTRACT_INDEX_SCHEMA_VERSION}`, "schemaVersion");
    return emptyContractIndex();
  }
  if (!Array.isArray(value.contracts) || value.contracts.length > 500) {
    addDiagnostic(diagnostics, "contract_index_invalid", indexPath, "contracts must be a bounded array", "contracts");
    return emptyContractIndex();
  }

  const contracts: IndexedContract[] = [];
  for (let index = 0; index < value.contracts.length; index += 1) {
    const parsed = parseIndexedContract(value.contracts[index], indexPath, `contracts[${index}]`, topic, manifest, diagnostics);
    if (parsed) contracts.push(parsed);
  }
  const contractFacts = parseContractFacts(value.contractFacts, indexPath, topic, diagnostics);
  const consequentialSpecialists = parseStringArray(value.consequentialSpecialists, indexPath, "consequentialSpecialists", diagnostics);
  return diagnostics.length === diagnosticCount ? { contracts, contractFacts, consequentialSpecialists } : emptyContractIndex();
}

function parseIndexedContract(
  value: unknown,
  indexPath: string,
  field: string,
  topic: string,
  manifest: InitiativeManifest,
  diagnostics: MutableInspection,
): IndexedContract | undefined {
  if (!isRecord(value)) return invalidIndex(diagnostics, indexPath, field, "contract must be an object");
  const kind = value.kind;
  const id = value.id;
  const parentId = value.parentId;
  const dependsOn = value.dependsOn;
  const planRevision = value.planRevision;
  const path = value.path;
  const status = value.status;
  const contentHash = value.contentHash;
  if (kind !== "phase" && kind !== "subphase") return invalidIndex(diagnostics, indexPath, `${field}.kind`, "contract kind must be phase or subphase");
  if (typeof id !== "string" || id.length > 32) return invalidIndex(diagnostics, indexPath, `${field}.id`, "contract id must be a bounded string");
  if (!Array.isArray(dependsOn) || dependsOn.some((entry) => typeof entry !== "string") || dependsOn.length > 500) {
    return invalidIndex(diagnostics, indexPath, `${field}.dependsOn`, "contract dependencies must be a bounded string array");
  }
  if (!Number.isSafeInteger(planRevision) || (planRevision as number) <= 0) return invalidIndex(diagnostics, indexPath, `${field}.planRevision`, "plan revision must be a positive integer");
  if (typeof path !== "string" || !isTopicArtifactPath(path, "plans", topic) || !manifest.activePlan || !path.startsWith(`${manifest.activePlan.contractRoot}/`)) {
    return invalidIndex(diagnostics, indexPath, `${field}.path`, `contract path must remain under the active plan contract root for ${topic}`);
  }
  if (!(CONTRACT_STATUSES as readonly unknown[]).includes(status)) return invalidIndex(diagnostics, indexPath, `${field}.status`, "contract status is unsupported");
  if (contentHash !== undefined && !isSha256(contentHash)) return invalidIndex(diagnostics, indexPath, `${field}.contentHash`, "content hash must use sha256:<hex>");
  if (kind === "subphase" && typeof parentId !== "string") return invalidIndex(diagnostics, indexPath, `${field}.parentId`, "subphase parentId is required");
  if (kind === "phase" && parentId !== undefined) return invalidIndex(diagnostics, indexPath, `${field}.parentId`, "phase cannot declare parentId");

  const base = { id, dependsOn: dependsOn as string[], planRevision: planRevision as number, path, status: status as ContractStatus, ...(contentHash ? { contentHash } : {}) };
  return kind === "phase" ? { kind, ...base } : { kind, parentId: parentId as string, ...base };
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
  return path.startsWith(`.model-artifacts/${kind}/${topic}/`) && !path.includes("\\") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function emptyContractIndex(): { contracts: readonly IndexedContract[]; contractFacts: Readonly<Record<string, ContractReadinessFacts | undefined>>; consequentialSpecialists: readonly string[] } {
  return { contracts: [], contractFacts: {}, consequentialSpecialists: [] };
}

function emptyResult(
  topic: string,
  manifestPath: string,
  diagnostics: readonly CanonicalInspectionDiagnostic[],
  manifest?: InitiativeManifest,
): CanonicalInspectorResult {
  return { sourceMode: "canonical", topic, manifestPath, ...(manifest ? { manifest } : {}), contracts: [], gates: [], readyIds: [], blockers: [], diagnostics };
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
