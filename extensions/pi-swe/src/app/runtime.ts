import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSweExternalCapabilities } from "../capabilities.ts";
import type { SweCapabilityAdapter, SweCapabilityWarning, SweExternalTodo, SweTodoEvidence, SweTodoScope } from "../domain/capabilities.ts";
import type { PiSweFact } from "../domain/classify.ts";
import { loadEffectiveSweConfig, type EffectivePiSweConfig, type PiSweConfigDiagnostic } from "../config/index.ts";
import { evaluateSwePolicy, type SwePolicyResult } from "../domain/policy.ts";
import { isValidTopic, PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION, PI_SWE_INITIATIVE_STATES } from "../domain/initiative.ts";
import { CONTRACT_STATUSES } from "../domain/contract-graph.ts";
import { normalizeSwePath, type ActiveInitiative, type ActivePlan } from "../domain/state.ts";
import { inspectCanonicalInitiative, type CanonicalInspectionDiagnosticCode, type CanonicalInspectorResult } from "../planning.ts";
import { createSweEvidenceService } from "./evidence.ts";
import { createSweStateService, type PiSweState } from "./state.ts";

export type PiSweRuntime = {
  capabilityWarnings: SweCapabilityWarning[];
  config: EffectivePiSweConfig;
  configDiagnostics: PiSweConfigDiagnostic[];
  configSource: string;
  cwd?: string;
  detectedPeers: string[];
  externalCapabilities: SweCapabilityAdapter;
  state: PiSweState;
  stateDiagnostics: PiSweStateDiagnostic[];
  todoEvidence: SweTodoEvidence[];
  todoScope?: SweTodoScope;
  warnings: SwePolicyResult[];
};

export const SWE_ADVISORY_WIDGET_KEY = "pi-swe-advisories";
export const PI_SWE_STATE_CUSTOM_TYPE = "gentic.swe.state";
export const PI_SWE_STATE_VERSION = 2 as const;
export const PI_SWE_REPOSITORY_STATE_MAX_BYTES = 64 * 1024;
export const PI_SWE_SESSION_STATE_MAX_BYTES = 64 * 1024;
const LEGACY_PI_SWE_STATE_VERSION = 1 as const;
const MAX_STATE_DIAGNOSTICS = 20;
const MAX_STATE_SUMMARY_ITEMS = 25;
const MAX_REPOSITORY_STATE_CANDIDATES = 100;
export const PI_SWE_STATE_TOPIC_MAX_LENGTH = 256;
export const PI_SWE_STATE_TOPIC_MAX_SEGMENTS = 16;
export const PI_SWE_STATE_TOPIC_SEGMENT_MAX_LENGTH = 64;
export const PI_SWE_STATE_DIAGNOSTIC_PATH_MAX_LENGTH = 2048;

type PersistedSweState = Pick<PiSweState, "activePlan" | "activeInitiative" | "activeStage">;
export type PiSweStateEnvelope = { version: typeof PI_SWE_STATE_VERSION; state: PersistedSweState };
export type PiSweStateDiagnosticCode =
  | "future_version"
  | "invalid_state"
  | "state_too_large"
  | "state_read_error"
  | "state_write_error"
  | "state_scan_limit"
  | "ambiguous_repository_state"
  | "missing_manifest"
  | "stale_plan_revision"
  | "missing_plan"
  | "mismatched_plan_path"
  | "missing_contract"
  | "mismatched_contract_path";
export type PiSweStateDiagnostic = { code: PiSweStateDiagnosticCode; message: string; path?: string };
export type ReconstructedSweState = { state: PersistedSweState; diagnostics: PiSweStateDiagnostic[] };

const stateService = createSweStateService();
const evidenceService = createSweEvidenceService();

export function createRuntime(ctx?: ExtensionContext): PiSweRuntime {
  const loaded = loadEffectiveSweConfig({ cwd: ctx?.cwd });
  return {
    capabilityWarnings: [],
    config: loaded.config,
    configDiagnostics: loaded.diagnostics,
    configSource: describeConfigSource(loaded.paths),
    cwd: ctx?.cwd,
    detectedPeers: [],
    externalCapabilities: createSweExternalCapabilities({ getCommands: () => [] } as unknown as ExtensionAPI),
    state: { ...stateService.createState() },
    stateDiagnostics: [],
    todoEvidence: [],
    warnings: [],
  };
}

export function loadSessionRuntime(runtime: PiSweRuntime, pi: ExtensionAPI, ctx: ExtensionContext): void {
  const loaded = loadEffectiveSweConfig({ cwd: ctx.cwd });
  runtime.config = loaded.config;
  runtime.configDiagnostics = loaded.diagnostics;
  runtime.configSource = describeConfigSource(loaded.paths);
  runtime.cwd = ctx.cwd;
  runtime.externalCapabilities = createSweExternalCapabilities(pi);
  restoreRuntimeState(runtime, ctx);
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function reloadBranchRuntime(runtime: PiSweRuntime, ctx: ExtensionContext): void {
  runtime.cwd = ctx.cwd;
  restoreRuntimeState(runtime, ctx);
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function persistSessionRuntime(runtime: PiSweRuntime, pi: ExtensionAPI): void {
  const prepared = preparePersistedState(runtime.state, PI_SWE_SESSION_STATE_MAX_BYTES, "session");
  if (!prepared.envelope) {
    if (prepared.diagnostic) runtime.stateDiagnostics = boundedDiagnostics([...runtime.stateDiagnostics, prepared.diagnostic]);
    return;
  }
  pi.appendEntry(PI_SWE_STATE_CUSTOM_TYPE, prepared.envelope);
  const activeInitiative = prepared.envelope.state.activeInitiative;
  if (runtime.cwd && activeInitiative) {
    runtime.stateDiagnostics = boundedDiagnostics([...runtime.stateDiagnostics, ...persistRepositoryRuntime(runtime.cwd, activeInitiative)]);
  }
}

export function persistRepositoryRuntime(cwd: string, activeInitiative: ActiveInitiative): PiSweStateDiagnostic[] {
  if (!isBoundedStateTopic(activeInitiative.topic)) {
    return [{ code: "invalid_state", path: ".model-artifacts/logs/<invalid-topic>/state.json", message: `repository state topic is invalid or exceeds bounds` }];
  }
  const statePath = repositoryStatePath(activeInitiative.topic);
  const repositoryRoot = resolve(cwd);
  const logsRoot = resolve(repositoryRoot, ".model-artifacts/logs");
  const absolutePath = resolve(logsRoot, activeInitiative.topic, "state.json");
  if (!isWithinPath(logsRoot, absolutePath) || hasSymlinkedPathSegment(repositoryRoot, dirname(absolutePath))) {
    return [{ code: "invalid_state", path: statePath, message: `repository state path escapes the repository or traverses a symlink` }];
  }
  const prepared = preparePersistedState({ activeInitiative }, PI_SWE_REPOSITORY_STATE_MAX_BYTES, "repository");
  if (!prepared.envelope || !prepared.serialized) {
    const diagnostic = prepared.diagnostic ?? { code: "invalid_state" as const, message: `repository state is empty` };
    return [{ ...diagnostic, path: statePath }];
  }

  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(absolutePath), { recursive: true });
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, prepared.serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, absolutePath);
    fsyncDirectory(dirname(absolutePath));
    return [];
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed or unsupported */ }
    }
    try { rmSync(temporaryPath, { force: true }); } catch { /* best-effort temporary-file cleanup */ }
    return [{ code: "state_write_error", path: statePath, message: `could not atomically persist repository state: ${errorMessage(error)}` }];
  }
}

export function resetSessionRuntime(runtime: PiSweRuntime, ctx?: ExtensionContext): void {
  runtime.state = { ...stateService.createState() };
  runtime.stateDiagnostics = [];
  runtime.todoEvidence = [];
  runtime.todoScope = undefined;
  runtime.warnings = [];
  runtime.capabilityWarnings = [];
  runtime.detectedPeers = [];
  renderAdvisoryWidget(ctx, []);
}

export function reconstructPersistedSweState(entries: readonly unknown[]): PersistedSweState {
  return reconstructPersistedSweStateWithDiagnostics(entries).state;
}

export function reconstructPersistedSweStateWithDiagnostics(entries: readonly unknown[], cwd?: string): ReconstructedSweState {
  let reconstructed: PersistedSweState = {};
  const diagnostics: PiSweStateDiagnostic[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PI_SWE_STATE_CUSTOM_TYPE) continue;
    if (isRecord(entry.data) && typeof entry.data.version === "number" && entry.data.version > PI_SWE_STATE_VERSION) {
      addStateDiagnostic(diagnostics, "future_version", `ignored future pi-swe state version ${entry.data.version}`);
      continue;
    }
    const decoded = decodeSweStateEnvelope(entry.data);
    if (decoded) reconstructed = decoded;
    else addStateDiagnostic(diagnostics, "invalid_state", "ignored malformed pi-swe state entry");
  }
  if (!cwd || !reconstructed.activeInitiative) return { state: reconstructed, diagnostics };
  const validated = validateActiveInitiative(cwd, reconstructed.activeInitiative);
  return {
    state: validated.activeInitiative
      ? { ...reconstructed, activeInitiative: validated.activeInitiative }
      : { ...reconstructed, activeInitiative: undefined, activeStage: undefined },
    diagnostics: boundedDiagnostics([...diagnostics, ...validated.diagnostics]),
  };
}

export function decodeSweStateEnvelope(data: unknown): PersistedSweState | undefined {
  if (!isRecord(data) || !isRecord(data.state)) return undefined;
  if (data.version === LEGACY_PI_SWE_STATE_VERSION) return decodeLegacySweState(data.state);
  if (data.version !== PI_SWE_STATE_VERSION) return undefined;
  const state: PersistedSweState = {};
  if (data.state.activePlan !== undefined) {
    const activePlan = decodeActivePlan(data.state.activePlan);
    if (!activePlan) return undefined;
    state.activePlan = activePlan;
  }
  if (data.state.activeInitiative !== undefined) {
    const activeInitiative = decodeActiveInitiative(data.state.activeInitiative);
    if (!activeInitiative) return undefined;
    state.activeInitiative = activeInitiative;
  }
  const stage = decodeStage(data.state.activeStage);
  if (data.state.activeStage !== undefined && !stage) return undefined;
  if (stage) state.activeStage = stage;
  return state.activePlan || state.activeInitiative || state.activeStage ? state : undefined;
}

export function resetTurnRuntime(runtime: PiSweRuntime, ctx?: ExtensionContext): void {
  runtime.state = { ...stateService.resetTurn(runtime.state, new Date().toISOString()) };
  refreshPeerContext(runtime);
  runtime.warnings = [];
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function applyFacts(runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  for (const fact of facts) {
    if (fact.kind === "inspection") runtime.state = { ...stateService.recordInspectedPath(runtime.state, fact.path) };
    else if (fact.kind === "code_change" && fact.path) runtime.state = { ...stateService.recordChangedPath(runtime.state, fact.path) };
    else if (fact.kind === "verification" && fact.exitCode !== undefined) runtime.state = { ...stateService.recordVerification(runtime.state, evidenceService.createCommandEvidence({ command: fact.command, exitCode: fact.exitCode, scope: fact.scope, timestamp: new Date().toISOString() })) };
  }
}

export function emitWarnings(ctx: ExtensionContext, runtime: PiSweRuntime, facts: readonly PiSweFact[]): void {
  const result = evaluateSwePolicy({ config: runtime.config, state: policyState(runtime), facts });
  runtime.warnings = dedupeWarnings([...runtime.warnings, ...result.warnings]);
  renderAdvisoryWidget(ctx, runtime.warnings);
}

export function refreshPeerContext(runtime: PiSweRuntime): void {
  runtime.detectedPeers = runtime.externalCapabilities.listDetectedExtensions?.() ?? [];
  runtime.todoScope = runtime.externalCapabilities.getTodoScope?.();
  runtime.todoEvidence = runtime.externalCapabilities.getTodoEvidence?.() ?? [];

  const activeTodo = runtime.externalCapabilities.getActiveTodo?.();
  if (activeTodo && !runtime.state.activeInitiative && !runtime.state.activePlan) {
    runtime.state = { ...stateService.setActivePlan(runtime.state, { source: "todo", marker: todoPlanMarker(activeTodo) }) };
  }

  runtime.capabilityWarnings = runtime.externalCapabilities.getWarnings();
}

function policyState(runtime: PiSweRuntime): PiSweState {
  // Todo evidence remains visible evidence, but only a successful focused/broad
  // verification command can satisfy the verification policy.
  return runtime.state;
}

function todoPlanMarker(todo: SweExternalTodo): string {
  const label = [todo.id, todo.title].filter(Boolean).join(" ") || "active todo";
  const markers = [
    todo.acceptanceCriteria?.length ? `AC:${todo.acceptanceCriteria.length}` : undefined,
    todo.definitionOfDone?.length ? `DoD:${todo.definitionOfDone.length}` : undefined,
  ].filter(Boolean);
  return markers.length ? `${label} (${markers.join(", ")})` : label;
}

function restoreRuntimeState(runtime: PiSweRuntime, ctx: ExtensionContext): void {
  const session = reconstructPersistedSweStateWithDiagnostics(readActiveBranch(ctx), ctx.cwd);
  let state = session.state;
  let diagnostics = [...session.diagnostics];
  if (!state.activeInitiative) {
    const repository = readRepositoryRuntime(ctx.cwd);
    diagnostics = [...diagnostics, ...repository.diagnostics];
    if (repository.state.activeInitiative) state = { ...state, activeInitiative: repository.state.activeInitiative };
  }
  runtime.state = {
    ...stateService.createState({ turnStartedAt: new Date().toISOString() }),
    ...state,
  };
  runtime.stateDiagnostics = boundedDiagnostics(diagnostics);
}

export function repositoryStatePath(topic: string): string {
  return `.model-artifacts/logs/${topic}/state.json`;
}

export function readRepositoryRuntime(cwd: string): ReconstructedSweState {
  const discovery = findRepositoryStatePaths(cwd);
  const paths = discovery.paths;
  const diagnostics: PiSweStateDiagnostic[] = [...discovery.diagnostics];
  const valid: ActiveInitiative[] = [];
  for (const statePath of paths) {
    const decoded = readRepositoryStateFile(cwd, statePath, diagnostics);
    if (!decoded?.activeInitiative) {
      if (decoded) addStateDiagnostic(diagnostics, "invalid_state", `repository state does not contain a canonical active initiative cursor`, statePath);
      continue;
    }
    if (repositoryStatePath(decoded.activeInitiative.topic) !== statePath) {
      addStateDiagnostic(diagnostics, "invalid_state", `repository state topic does not match its path`, statePath);
      continue;
    }
    const validated = validateActiveInitiative(cwd, decoded.activeInitiative);
    diagnostics.push(...validated.diagnostics);
    if (validated.activeInitiative) valid.push(validated.activeInitiative);
  }
  if (valid.length > 1) {
    addStateDiagnostic(diagnostics, "ambiguous_repository_state", `multiple valid repository state cursors exist: ${valid.map((item) => item.topic).sort().join(", ")}`);
    return { state: {}, diagnostics: boundedDiagnostics(diagnostics) };
  }
  return { state: valid[0] ? { activeInitiative: valid[0] } : {}, diagnostics: boundedDiagnostics(diagnostics) };
}

export function validateActiveInitiative(cwd: string, active: ActiveInitiative): { activeInitiative?: ActiveInitiative; diagnostics: PiSweStateDiagnostic[] } {
  const diagnostics: PiSweStateDiagnostic[] = [];
  const inspection = inspectCanonicalInitiative({ cwd, topic: active.topic });
  const manifest = inspection.manifest;
  if (!manifest) {
    addStateDiagnostic(diagnostics, "missing_manifest", inspection.diagnostics[0]?.message ?? `canonical manifest is unavailable`, active.manifestPath);
    return { diagnostics };
  }
  if (inspection.manifestPath !== active.manifestPath || manifest.schemaVersion !== active.manifestSchemaVersion) {
    addStateDiagnostic(diagnostics, "missing_manifest", `persisted manifest identity does not match canonical inspection`, active.manifestPath);
    return { diagnostics };
  }
  if (!manifest.activePlan || manifest.activePlan.revision !== active.planRevision) {
    addStateDiagnostic(diagnostics, "stale_plan_revision", `persisted plan revision ${active.planRevision} is not the active canonical revision`, active.planPath);
    return { diagnostics };
  }
  if (manifest.activePlan.path !== active.planPath) {
    addStateDiagnostic(diagnostics, "mismatched_plan_path", `persisted plan path does not match active canonical plan`, active.planPath);
    return { diagnostics };
  }
  const unusablePlan = inspection.diagnostics.find((diagnostic) => diagnostic.path === active.planPath && isUnusableArtifactDiagnostic(diagnostic.code));
  if (unusablePlan) {
    addStateDiagnostic(diagnostics, "missing_plan", `active canonical plan is unusable: ${unusablePlan.code}`, active.planPath);
    return { diagnostics };
  }

  let contractId = active.contractId;
  let contractPath = active.contractPath;
  if (manifest.activeContract && !contractId && !contractPath) {
    addStateDiagnostic(diagnostics, "missing_contract", `persisted cursor omits canonical active contract ${manifest.activeContract.id}`, manifest.activeContract.path);
  } else if (contractId || contractPath) {
    const contract = inspection.contracts.find((candidate) => candidate.id === contractId);
    const unusableContract = inspection.diagnostics.find((diagnostic) => diagnostic.path === contractPath && isUnusableArtifactDiagnostic(diagnostic.code));
    const staleContractRevision = inspection.blockers.some((blocker) => blocker.code === "contract-revision-stale" && blocker.contractId === contractId);
    if (!contract || !contractId || unusableContract || staleContractRevision) {
      const reason = unusableContract?.code ?? (staleContractRevision ? "contract-revision-stale" : "missing from active plan");
      addStateDiagnostic(diagnostics, "missing_contract", `persisted active contract is unusable: ${reason}`, contractPath);
      contractId = undefined;
      contractPath = undefined;
    } else if (!contractPath || contract.path !== contractPath || manifest.activeContract?.id !== contractId || manifest.activeContract.path !== contractPath) {
      addStateDiagnostic(diagnostics, "mismatched_contract_path", `persisted active contract path does not match the canonical manifest and contract index`, contractPath);
      contractId = undefined;
      contractPath = undefined;
    }
  }

  return {
    activeInitiative: activeInitiativeFromInspection(inspection, contractId, contractPath),
    diagnostics: boundedDiagnostics(diagnostics),
  };
}

function activeInitiativeFromInspection(inspection: CanonicalInspectorResult, contractId?: string, contractPath?: string): ActiveInitiative {
  const manifest = inspection.manifest!;
  const activePlan = manifest.activePlan!;
  const contract = contractId ? inspection.contracts.find((candidate) => candidate.id === contractId) : undefined;
  return {
    topic: inspection.topic,
    manifestPath: inspection.manifestPath,
    manifestSchemaVersion: manifest.schemaVersion,
    planRevision: activePlan.revision,
    planPath: activePlan.path,
    ...(contractId && contractPath ? { contractId, contractPath } : {}),
    lifecycle: {
      initiativeState: manifest.initiativeState,
      ...(contract ? { contractStatus: contract.status } : {}),
    },
    gates: {
      readyIds: inspection.readyIds.slice(0, MAX_STATE_SUMMARY_ITEMS),
      blockerCodes: [...new Set(inspection.blockers.map((blocker) => blocker.code))].slice(0, MAX_STATE_SUMMARY_ITEMS),
    },
  };
}

function decodeLegacySweState(value: Record<string, unknown>): PersistedSweState | undefined {
  const state: PersistedSweState = {};
  const activePlan = decodeActivePlan(value.activePlan);
  if (activePlan) state.activePlan = activePlan;
  const stage = decodeStage(value.activeStage);
  if (stage) state.activeStage = stage;
  return state.activePlan || state.activeStage ? state : undefined;
}

function decodeActivePlan(value: unknown): ActivePlan | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source;
  const marker = value.marker;
  if ((source !== "todo" && source !== "artifact" && source !== "prompt") || typeof marker !== "string" || !marker.trim()) return undefined;
  return { source, marker: marker.trim().slice(0, 1024) };
}

function decodeActiveInitiative(value: unknown): ActiveInitiative | undefined {
  if (!isRecord(value) || typeof value.topic !== "string" || !isBoundedStateTopic(value.topic)) return undefined;
  if (typeof value.manifestPath !== "string" || !isSafeStatePath(value.manifestPath)) return undefined;
  if (value.manifestSchemaVersion !== PI_SWE_INITIATIVE_MANIFEST_SCHEMA_VERSION) return undefined;
  if (!Number.isSafeInteger(value.planRevision) || (value.planRevision as number) < 1) return undefined;
  if (typeof value.planPath !== "string" || !isSafeStatePath(value.planPath)) return undefined;
  if ((value.contractId === undefined) !== (value.contractPath === undefined)) return undefined;
  if (value.contractId !== undefined && (typeof value.contractId !== "string" || !value.contractId.trim())) return undefined;
  if (value.contractPath !== undefined && (typeof value.contractPath !== "string" || !isSafeStatePath(value.contractPath))) return undefined;
  if (!isRecord(value.lifecycle) || !PI_SWE_INITIATIVE_STATES.includes(value.lifecycle.initiativeState as never)) return undefined;
  if (value.lifecycle.contractStatus !== undefined && !CONTRACT_STATUSES.includes(value.lifecycle.contractStatus as never)) return undefined;
  if (!isRecord(value.gates) || !isBoundedStringArray(value.gates.readyIds) || !isBoundedStringArray(value.gates.blockerCodes)) return undefined;
  return {
    topic: value.topic,
    manifestPath: normalizeSwePath(value.manifestPath),
    manifestSchemaVersion: value.manifestSchemaVersion,
    planRevision: value.planRevision as number,
    planPath: normalizeSwePath(value.planPath),
    ...(typeof value.contractId === "string" && typeof value.contractPath === "string"
      ? { contractId: value.contractId.trim(), contractPath: normalizeSwePath(value.contractPath) }
      : {}),
    lifecycle: {
      initiativeState: value.lifecycle.initiativeState as ActiveInitiative["lifecycle"]["initiativeState"],
      ...(value.lifecycle.contractStatus ? { contractStatus: value.lifecycle.contractStatus as ActiveInitiative["lifecycle"]["contractStatus"] } : {}),
    },
    gates: { readyIds: [...value.gates.readyIds], blockerCodes: [...value.gates.blockerCodes] },
  };
}

function decodeStage(value: unknown): PiSweState["activeStage"] {
  return value === "plan" || value === "diagnose" || value === "implement" || value === "verify" || value === "review" || value === "finalize" || value === "tdd" || value === "dsa" ? value : undefined;
}

function isBoundedStateTopic(value: string): boolean {
  if (!isValidTopic(value) || value.length > PI_SWE_STATE_TOPIC_MAX_LENGTH) return false;
  const segments = value.split("/");
  return segments.length <= PI_SWE_STATE_TOPIC_MAX_SEGMENTS
    && segments.every((segment) => segment.length <= PI_SWE_STATE_TOPIC_SEGMENT_MAX_LENGTH);
}

function isSafeStatePath(value: string): boolean {
  if (value.length > 2048) return false;
  const normalized = normalizeSwePath(value);
  return normalized !== "." && !normalized.startsWith("../") && !normalized.startsWith("/") && !value.includes("\\") && normalized === value.trim();
}

function isBoundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_STATE_SUMMARY_ITEMS && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128);
}

type PreparedPersistedState = { envelope?: PiSweStateEnvelope; serialized?: string; diagnostic?: PiSweStateDiagnostic };

function preparePersistedState(source: Partial<PersistedSweState>, maxBytes: number, label: "session" | "repository"): PreparedPersistedState {
  const state: PersistedSweState = {};
  if (source.activePlan !== undefined) {
    const activePlan = decodeActivePlan(source.activePlan);
    if (!activePlan) return { diagnostic: { code: "invalid_state", message: `${label} active plan marker is invalid` } };
    state.activePlan = activePlan;
  }
  if (source.activeInitiative !== undefined) {
    const activeInitiative = decodeActiveInitiative(normalizeActiveInitiativeForWrite(source.activeInitiative));
    if (!activeInitiative) return { diagnostic: { code: "invalid_state", message: `${label} active initiative cursor is invalid or exceeds field bounds` } };
    state.activeInitiative = activeInitiative;
  }
  if (source.activeStage !== undefined) {
    const activeStage = decodeStage(source.activeStage);
    if (!activeStage) return { diagnostic: { code: "invalid_state", message: `${label} active stage is invalid` } };
    state.activeStage = activeStage;
  }
  if (!state.activePlan && !state.activeInitiative && !state.activeStage) return {};
  const envelope: PiSweStateEnvelope = { version: PI_SWE_STATE_VERSION, state };
  try {
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) {
      return { diagnostic: { code: "state_too_large", message: `${label} state exceeds ${maxBytes} bytes` } };
    }
    return { envelope, serialized };
  } catch (error) {
    return { diagnostic: { code: "invalid_state", message: `${label} state could not be serialized: ${errorMessage(error)}` } };
  }
}

function normalizeActiveInitiativeForWrite(active: ActiveInitiative): unknown {
  const value = active as unknown;
  if (!isRecord(value)) return value;
  const gates = isRecord(value.gates) ? value.gates : undefined;
  return {
    ...value,
    ...(isRecord(value.lifecycle) ? { lifecycle: { ...value.lifecycle } } : {}),
    ...(gates ? {
      gates: {
        readyIds: Array.isArray(gates.readyIds) ? gates.readyIds.slice(0, MAX_STATE_SUMMARY_ITEMS) : gates.readyIds,
        blockerCodes: Array.isArray(gates.blockerCodes) ? gates.blockerCodes.slice(0, MAX_STATE_SUMMARY_ITEMS) : gates.blockerCodes,
      },
    } : {}),
  };
}

function isUnusableArtifactDiagnostic(code: CanonicalInspectionDiagnosticCode): boolean {
  return code === "artifact_missing"
    || code === "artifact_too_large"
    || code === "artifact_outside_repository"
    || code === "read_error"
    || code === "stale_link";
}

function isWithinPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function hasSymlinkedPathSegment(root: string, candidateDirectory: string): boolean {
  const relativePath = relative(root, candidateDirectory);
  if (!isWithinPath(root, candidateDirectory)) return true;
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function readRepositoryStateFile(cwd: string, statePath: string, diagnostics: PiSweStateDiagnostic[]): PersistedSweState | undefined {
  const absolutePath = resolve(cwd, statePath);
  try {
    if (statSync(absolutePath).size > PI_SWE_REPOSITORY_STATE_MAX_BYTES) {
      addStateDiagnostic(diagnostics, "state_too_large", `repository state exceeds ${PI_SWE_REPOSITORY_STATE_MAX_BYTES} bytes`, statePath);
      return undefined;
    }
    const parsed: unknown = JSON.parse(readFileSync(absolutePath, "utf8"));
    if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version > PI_SWE_STATE_VERSION) {
      addStateDiagnostic(diagnostics, "future_version", `ignored future repository state version ${parsed.version}`, statePath);
      return undefined;
    }
    const decoded = decodeSweStateEnvelope(parsed);
    if (!decoded) addStateDiagnostic(diagnostics, "invalid_state", `repository state has an unsupported or malformed envelope`, statePath);
    return decoded;
  } catch (error) {
    addStateDiagnostic(diagnostics, "state_read_error", `could not read repository state: ${errorMessage(error)}`, statePath);
    return undefined;
  }
}

function findRepositoryStatePaths(cwd: string): { paths: string[]; diagnostics: PiSweStateDiagnostic[] } {
  const repositoryRoot = resolve(cwd);
  const root = resolve(repositoryRoot, ".model-artifacts/logs");
  if (!existsSync(root)) return { paths: [], diagnostics: [] };
  const found: string[] = [];
  const diagnostics: PiSweStateDiagnostic[] = [];
  if (hasSymlinkedPathSegment(repositoryRoot, root)) {
    addStateDiagnostic(diagnostics, "state_read_error", `repository state discovery root traverses a symlink`, ".model-artifacts/logs");
    return { paths: [], diagnostics };
  }
  let limitReported = false;
  const visit = (directory: string): void => {
    if (found.length >= MAX_REPOSITORY_STATE_CANDIDATES) {
      if (!limitReported) {
        addStateDiagnostic(diagnostics, "state_scan_limit", `repository state discovery reached ${MAX_REPOSITORY_STATE_CANDIDATES} candidates`, normalizeSwePath(relative(repositoryRoot, directory)));
        limitReported = true;
      }
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      addStateDiagnostic(diagnostics, "state_read_error", `could not inspect repository state directory: ${errorMessage(error)}`, normalizeSwePath(relative(repositoryRoot, directory)));
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "state.json") found.push(normalizeSwePath(relative(repositoryRoot, absolute)));
      if (found.length >= MAX_REPOSITORY_STATE_CANDIDATES) {
        if (!limitReported) {
          addStateDiagnostic(diagnostics, "state_scan_limit", `repository state discovery reached ${MAX_REPOSITORY_STATE_CANDIDATES} candidates`, ".model-artifacts/logs");
          limitReported = true;
        }
        return;
      }
    }
  };
  visit(root);
  return { paths: found.sort(), diagnostics: boundedDiagnostics(diagnostics) };
}

function addStateDiagnostic(diagnostics: PiSweStateDiagnostic[], code: PiSweStateDiagnosticCode, message: string, path?: string): void {
  if (diagnostics.length >= MAX_STATE_DIAGNOSTICS) return;
  diagnostics.push({
    code,
    message: message.slice(0, 512),
    ...(path ? { path: path.slice(0, PI_SWE_STATE_DIAGNOSTIC_PATH_MAX_LENGTH) } : {}),
  });
}

function boundedDiagnostics(diagnostics: readonly PiSweStateDiagnostic[]): PiSweStateDiagnostic[] {
  return diagnostics.slice(0, MAX_STATE_DIAGNOSTICS).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message.slice(0, 512),
    ...(diagnostic.path ? { path: diagnostic.path.slice(0, PI_SWE_STATE_DIAGNOSTIC_PATH_MAX_LENGTH) } : {}),
  }));
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort directory descriptor cleanup */ }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeConfigSource(paths: { global: string; project: string }): string {
  return `${paths.project} (project), ${paths.global} (global), defaults`;
}

export function formatAdvisoryChips(ctx: ExtensionContext, warnings: readonly SwePolicyResult[]): string[] | undefined {
  if (warnings.length === 0) return undefined;

  const label = chip(ctx, ctx.ui.theme.fg("muted", "pi-swe"));
  const chips = warnings.map((warning) => chip(ctx, ctx.ui.theme.fg("warning", warning.code)));
  const hint = ctx.ui.theme.fg("dim", warnings.length === 1 ? warnings[0].nextAction : `${warnings.length} advisories`);
  return [[label, ...chips, hint].join(" ")];
}

function renderAdvisoryWidget(ctx: ExtensionContext | undefined, warnings: readonly SwePolicyResult[]): void {
  if (!ctx || typeof ctx.ui.setWidget !== "function") return;
  ctx.ui.setWidget(SWE_ADVISORY_WIDGET_KEY, formatAdvisoryChips(ctx, warnings), { placement: "belowEditor" });
}

function chip(ctx: ExtensionContext, text: string): string {
  return ctx.ui.theme.bg("customMessageBg", ` ${text} `);
}

function readActiveBranch(ctx: ExtensionContext): readonly unknown[] {
  const manager = ctx.sessionManager as unknown as { getBranch?: () => readonly unknown[] } | undefined;
  return manager?.getBranch?.() ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dedupeWarnings(warnings: SwePolicyResult[]): SwePolicyResult[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
