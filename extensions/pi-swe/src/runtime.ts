import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { coordinatedActiveTodo, type LifecycleContext } from "../../../src/lifecycle-coordination.ts";

import { GitInitiativeCloseoutInspector, InitiativeCloseoutAuthority, type InitiativeCloseoutInspector } from "./closeout.ts";
import { parseGate2Decision, parseStoredGate2Decision, readRuntimeSelection, requireNoChildCheckpoint, validateGate2Evidence, writeRuntimeSelection, type Gate2Decision, type Gate2EvidencePaths, type ManagedRuntime, type RuntimeSelectionRecord, type RuntimeSelectionState } from "./cutover.ts";
import { AutonomousWorkflowDriver } from "./driver.ts";
import { GitRelevantSourceInspector, ManagedVerificationAuthority, registerParentIntegrity, type ParentExecutionIdentity, type ParentIntegrityRouter, type RelevantSourceInspector } from "./integrity.ts";
import { OrchestrationEngine, type OrchestrationRunner, type OrchestrationWorkspace } from "./orchestration.ts";
import { AgentRunner, resolvePinnedPiCli, type AgentRunRequest, type RunnerBudgets } from "./runner.ts";
import { WorkflowMutationService } from "./service.ts";
import { listWorkflowTopics, loadWorkflow } from "./store.ts";
import { sweRuntimeRegistry, SweRuntimeRegistry, type WorkflowControlIdentity } from "./ux.ts";
import { GitWorkspaceManager, type WorkspaceLimits } from "./workspace.ts";
import { reduceWorkflow } from "./workflow.ts";

const PINNED_PI_VERSION = "0.84.2";
const FIXTURE_PROVIDER = /^fixture(?:-|$)|^deterministic(?:-|$)/;
const REQUIRED_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

const DEFAULT_BUDGETS: RunnerBudgets = { timeoutMs: 15 * 60_000, maxTurns: 64, maxOutputBytes: 512 * 1024, maxRetries: 1, killGraceMs: 2_000 };
const DEFAULT_WORKSPACE: WorkspaceLimits = { maxFiles: 2_000, maxBytes: 64 * 1024 * 1024, maxPatchBytes: 16 * 1024 * 1024, maxPathBytes: 4_096 };

export type ProductionRuntimeConfig = {
  provider: string;
  model: string;
  thinking: AgentRunRequest["thinking"];
  budgets: RunnerBudgets;
  workspace: WorkspaceLimits;
  projectInstructions: string[];
  readScope: string[];
  approvedSkills: string[];
  trustedExtensions: string[];
};

export type ProductionRuntime = {
  config: ProductionRuntimeConfig;
  engine: OrchestrationEngine;
  runner: OrchestrationRunner;
  workspace: OrchestrationWorkspace;
  verificationAuthority: ManagedVerificationAuthority;
  closeoutAuthority: InitiativeCloseoutAuthority;
  mutations: WorkflowMutationService;
  registry: SweRuntimeRegistry;
  driver: AutonomousWorkflowDriver;
  shutdown(): void;
};

export type ProductionRuntimeOptions = {
  cwd: string;
  pi: ExtensionAPI;
  parent: ParentExecutionIdentity;
  provider: string;
  model: string;
  thinking?: AgentRunRequest["thinking"];
  budgets?: Partial<RunnerBudgets>;
  workspace?: Partial<WorkspaceLimits>;
  projectInstructions?: string[];
  readScope?: string[];
  approvedSkills?: string[];
  trustedExtensions?: string[];
  qualificationMode?: boolean;
  overrides?: {
    runner?: OrchestrationRunner;
    workspace?: OrchestrationWorkspace;
    sourceInspector?: RelevantSourceInspector;
    closeoutInspector?: InitiativeCloseoutInspector;
    mutations?: WorkflowMutationService;
    registry?: SweRuntimeRegistry;
  };
};

/** Constructs one authority-isolated runtime. It does not register or activate it. */
export function createProductionRuntime(options: ProductionRuntimeOptions): ProductionRuntime {
  validatePiApi(options.pi);
  const cwd = realpathSync(resolve(options.cwd));
  if (!statSync(cwd).isDirectory()) throw new Error("runtime cwd must be a repository directory");
  if (options.parent.cwd !== cwd || !options.parent.ownerId.trim() || !options.parent.sessionId.trim() || !options.parent.runtimeId.trim()) throw new Error("runtime parent identity must bind the repository, owner, session, and runtime");
  const config = validatedConfig(options);
  const workspace = options.overrides?.workspace ?? new GitWorkspaceManager(cwd, config.workspace);
  const runner = options.overrides?.runner ?? new AgentRunner();
  const mutations = options.overrides?.mutations ?? new WorkflowMutationService(cwd);
  const registry = options.overrides?.registry ?? new SweRuntimeRegistry();
  const sourceInspector = options.overrides?.sourceInspector ?? new GitRelevantSourceInspector(cwd, workspace as GitWorkspaceManager);
  const closeoutInspector = options.overrides?.closeoutInspector ?? new GitInitiativeCloseoutInspector(cwd, workspace as GitWorkspaceManager);
  const verificationAuthority = new ManagedVerificationAuthority(cwd, sourceInspector);
  const closeoutAuthority = new InitiativeCloseoutAuthority(cwd, closeoutInspector);
  const engine = new OrchestrationEngine(cwd, {
    service: mutations, runner, workspace, ownerId: options.parent.ownerId, parent: options.parent,
    verificationAuthority, closeoutInspector, closeoutAuthority,
    provider: config.provider, model: config.model, thinking: config.thinking,
    projectInstructions: config.projectInstructions, readScope: config.readScope,
    approvedSkills: config.approvedSkills, trustedExtensions: config.trustedExtensions,
    budgets: config.budgets, runtimeRegistry: registry,
  });
  const driver = new AutonomousWorkflowDriver({
    engine,
    readWorkflow: (topic) => {
      const located = loadWorkflow(cwd, topic, false);
      if (!located) throw new Error(`workflow ${topic} was not found`);
      return located.workflow;
    },
    abortActive: (topic, outcome) => registry.signal(topic, outcome === "cancelled" ? "cancelled" : "interrupted"),
  });
  return { config, engine, runner, workspace, verificationAuthority, closeoutAuthority, mutations, registry, driver, shutdown: () => { driver.shutdown(); verificationAuthority.invalidate(); closeoutAuthority.invalidate(); } };
}

export type RuntimeHandoffReceipt = {
  handoffId: string;
  decisionId: string;
  selectedRuntime: ManagedRuntime;
  selectorGeneration: number;
  preparedWorkflowRevision: number;
  reclaimedWorkflowRevision: number;
  freshParentRuntimeId: string;
  rollbackWindowEnd: string;
};

type RuntimeHandoffOptions = {
  cwd: string;
  topic?: string;
  targetRuntime: ManagedRuntime;
  decision?: Gate2Decision;
  evidence?: Gate2EvidencePaths;
  activeTodoCount: number;
  piVersion: string;
  parent: { ownerId: string; sessionId: string; runtimeId?: string; sessionFile?: string };
  now?: string;
  currentRuntime: { registry: SweRuntimeRegistry; shutdown(): void };
  freshRuntimeId?: string;
  reload: (selection: { runtime: ManagedRuntime; generation: number; runtimeId: string }) => { runtimeId: string } | Promise<{ runtimeId: string }>;
  fault?: (stage: "after-prepare" | "after-selector-persist" | "before-reclaim") => void;
};

/** Execute or idempotently resume the durable prepare/select/reload/reclaim protocol. */
async function performRuntimeHandoff(options: RuntimeHandoffOptions): Promise<RuntimeHandoffReceipt> {
  const cwd = realpathSync(resolve(options.cwd));
  const topic = options.topic ?? "swe-production-rollout";
  const now = options.now ?? new Date().toISOString();
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error("runtime handoff timestamp is invalid");
  if (!Number.isSafeInteger(options.activeTodoCount) || options.activeTodoCount !== 0) throw new Error("runtime handoff requires zero active todos");
  if (options.piVersion !== PINNED_PI_VERSION) throw new Error(`runtime handoff requires Pi ${PINNED_PI_VERSION}`);
  const initialSelection = readRuntimeSelection(cwd);
  if (initialSelection.status === "blocked") throw new Error(`runtime handoff blocked by ambiguous selector: ${initialSelection.reason}`);
  const service = new WorkflowMutationService(cwd);
  const initialWorkflow = service.read(topic, false)?.workflow;
  if (!initialWorkflow) throw new Error(`controlling workflow ${topic} was not found`);
  const pending = initialWorkflow.orchestration.runtimeHandoff?.phase === "prepared" ? initialWorkflow.orchestration.runtimeHandoff : undefined;
  const selectedRecord = initialSelection.record;
  const selectedParent = initialWorkflow.orchestration.parent;
  const selectedHandoff = initialWorkflow.orchestration.runtimeHandoff;
  if (!pending && initialSelection.runtime === options.targetRuntime && selectedRecord
    && selectedHandoff?.phase === "reclaimed" && selectedHandoff.id === selectedRecord.handoff.id
    && selectedHandoff.selectorGeneration === selectedRecord.generation && selectedHandoff.to === options.targetRuntime
    && selectedParent?.valid === true && selectedParent.ownerId === options.parent.ownerId && selectedParent.sessionId === options.parent.sessionId
    && selectedParent.runtimeId === selectedRecord.handoff.parent.runtimeId && selectedParent.cwd === cwd) {
    return receiptFromState(initialWorkflow, selectedRecord);
  }
  const selectorRecovery = !!pending && initialSelection.runtime === options.targetRuntime && selectedRecord?.handoff.id === pending.id;
  const retainedDecision = selectedRecord?.decision;
  const preparedDecision = pending?.decision ? parseStoredGate2Decision(pending.decision) : undefined;
  let decision: Gate2Decision;
  if (preparedDecision) {
    decision = preparedDecision;
  } else if (retainedDecision && (selectorRecovery || options.targetRuntime === "compatibility" || initialSelection.runtime === "compatibility" && initialSelection.record || options.targetRuntime === initialSelection.runtime && !!initialSelection.record)) {
    decision = retainedDecision;
  } else if (options.targetRuntime === "v2") {
    if (!options.evidence) throw new Error("initial v2 admission requires reviewed Gate 2 evidence paths");
    validateGate2Evidence(cwd, options.evidence);
    decision = parseGate2Decision(options.decision, pending ? new Date(pending.preparedAt) : nowDate);
  } else {
    throw new Error("compatibility rollback requires the retained selector evidence identity");
  }
  const rollbackAdmission = pending && initialSelection.runtime === options.targetRuntime && initialSelection.record ? Date.parse(initialSelection.record.handoff.selectedAt) : nowDate.getTime();
  if (options.targetRuntime === "compatibility" && rollbackAdmission > Date.parse(decision.rollbackWindowEnd)) throw new Error("compatibility rollback window has closed");
  if (listWorkflowTopics(cwd).some((workflowTopic) => options.currentRuntime.registry.list(workflowTopic).some((run) => run.outcome === "running"))) throw new Error("runtime handoff requires all process-registry children to stop");

  let preparedWorkflow = initialWorkflow;
  let selection: RuntimeSelectionState = initialSelection;
  let handoffId: string;
  let selectorGeneration: number;
  let preparedAt = now;
  if (pending) {
    if (pending.to !== options.targetRuntime || pending.decisionId !== decision.decisionId) throw new Error("prepared runtime handoff conflicts with the requested transition");
    handoffId = pending.id;
    selectorGeneration = pending.selectorGeneration;
    preparedAt = pending.preparedAt;
    const oldSelector = selection.runtime === pending.from && selection.generation === pending.selectorGeneration - 1;
    const newSelector = selection.runtime === pending.to && selection.generation === pending.selectorGeneration && selection.record?.handoff.id === pending.id;
    if (!oldSelector && !newSelector) throw new Error("prepared workflow and runtime selector are ambiguous");
  } else {
    const checkpoint = requireNoChildCheckpoint(cwd, topic, now);
    if (initialWorkflow.revision !== checkpoint.workflowRevision) throw new Error("controlling workflow changed after the no-child checkpoint");
    const currentParent = initialWorkflow.orchestration.parent;
    if (currentParent?.valid && (currentParent.ownerId !== options.parent.ownerId || currentParent.sessionId !== options.parent.sessionId || (options.parent.runtimeId && currentParent.runtimeId !== options.parent.runtimeId))) throw new Error("controlling workflow is owned by a competing parent");
    handoffId = randomUUID();
    selectorGeneration = selection.generation + 1;
    const prepared = await service.prepareRuntimeHandoff(topic, initialWorkflow.revision, { id: handoffId, decisionId: decision.decisionId, decision, from: selection.runtime, to: options.targetRuntime, selectorGeneration }, now);
    preparedWorkflow = prepared.workflow;
    options.fault?.("after-prepare");
  }

  options.currentRuntime.shutdown();
  const freshRuntimeId = selection.record?.handoff.id === handoffId ? selection.record.handoff.parent.runtimeId : options.freshRuntimeId ?? randomUUID();
  if (selection.record?.handoff.id !== handoffId) {
    const selectedAt = new Date(Math.max(Date.parse(preparedAt), Date.now())).toISOString();
    const record: RuntimeSelectionRecord = {
      schemaVersion: 1, generation: selectorGeneration, selectedRuntime: options.targetRuntime, controllingTopic: "swe-production-rollout", decision,
      handoff: { id: handoffId, from: selection.runtime, to: options.targetRuntime, preparedWorkflowRevision: preparedWorkflow.revision, preparedAt, selectedAt, parent: { ownerId: options.parent.ownerId, sessionId: options.parent.sessionId, runtimeId: freshRuntimeId } },
    };
    writeRuntimeSelection(cwd, record, selection.generation, selection.preimageHash);
    selection = readRuntimeSelection(cwd);
    if (selection.status === "blocked") throw new Error(`runtime selector failed after persistence: ${selection.reason}`);
    options.fault?.("after-selector-persist");
  }
  const loaded = await options.reload({ runtime: options.targetRuntime, generation: selectorGeneration, runtimeId: freshRuntimeId });
  if (!loaded || loaded.runtimeId !== freshRuntimeId) throw new Error("atomic runtime reload did not install the prepared fresh runtime identity");
  const current = readRuntimeSelection(cwd);
  if (current.status === "blocked" || current.runtime !== options.targetRuntime || current.generation !== selectorGeneration || current.record?.handoff.id !== handoffId || current.record.decision.decisionId !== decision.decisionId || current.record.handoff.parent.runtimeId !== freshRuntimeId) throw new Error("runtime selector changed before fresh-parent reclaim");
  const latest = service.read(topic, false)?.workflow;
  if (!latest || latest.orchestration.runtimeHandoff?.phase !== "prepared" || latest.orchestration.runtimeHandoff.id !== handoffId) throw new Error("durable handoff changed before fresh-parent reclaim");
  const reclaimedAt = new Date(Math.max(Date.parse(current.record.handoff.selectedAt), Date.now())).toISOString();
  options.fault?.("before-reclaim");
  const reclaimed = await service.reclaimRuntimeHandoff(topic, latest.revision, {
    handoffId, decisionId: decision.decisionId, selectorGeneration,
    authority: { ownerId: options.parent.ownerId, sessionId: options.parent.sessionId, runtimeId: freshRuntimeId, cwd, ...(options.parent.sessionFile ? { sessionFile: options.parent.sessionFile } : {}), claimedAt: reclaimedAt, valid: true },
  }, reclaimedAt);
  return { handoffId, decisionId: decision.decisionId, selectedRuntime: options.targetRuntime, selectorGeneration, preparedWorkflowRevision: preparedWorkflow.revision, reclaimedWorkflowRevision: reclaimed.workflow.revision, freshParentRuntimeId: freshRuntimeId, rollbackWindowEnd: decision.rollbackWindowEnd };
}

function receiptFromState(workflow: import("./workflow.ts").Workflow, record: RuntimeSelectionRecord): RuntimeHandoffReceipt {
  return { handoffId: record.handoff.id, decisionId: record.decision.decisionId, selectedRuntime: record.selectedRuntime, selectorGeneration: record.generation, preparedWorkflowRevision: record.handoff.preparedWorkflowRevision, reclaimedWorkflowRevision: workflow.revision, freshParentRuntimeId: record.handoff.parent.runtimeId, rollbackWindowEnd: record.decision.rollbackWindowEnd };
}

export type RuntimeSurfaceBinding = {
  kind: ManagedRuntime | "blocked";
  generation: number | null;
  /** Exact selector bytes and durable authority tuple used to construct this slot. */
  selectorPreimageHash?: string;
  authorityKey?: string;
  identity: WorkflowControlIdentity;
  mutations: WorkflowMutationService;
  registry: SweRuntimeRegistry;
  runtime?: ProductionRuntime;
  reason?: string;
};
export type ControllerRuntimeHandoffOptions = {
  cwd: string;
  targetRuntime: ManagedRuntime;
  decision?: Gate2Decision;
  evidence?: Gate2EvidencePaths;
  identity: WorkflowControlIdentity;
  lifecycleContext: LifecycleContext;
  sessionFile?: string;
};
export type RuntimeSurfaceResolver = {
  resolve(cwd: string, identity: WorkflowControlIdentity): Promise<RuntimeSurfaceBinding>;
  handoff(options: ControllerRuntimeHandoffOptions): Promise<RuntimeHandoffReceipt>;
  shutdown(): void;
};

type SharedRuntimeControllerDependencies = {
  handoffFault?: (stage: "after-prepare" | "after-selector-persist" | "before-reclaim") => void;
};

/** One process-local slot per checkout. Every adapter resolves this same generation. */
export class SharedRuntimeController implements RuntimeSurfaceResolver {
  private readonly slots = new Map<string, RuntimeSurfaceBinding>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly pi: ExtensionAPI;
  private readonly integrity: ParentIntegrityRouter;
  private readonly processRuntimeIds = new Map<string, string>();
  private readonly dependencies: SharedRuntimeControllerDependencies;

  constructor(pi: ExtensionAPI, dependencies: SharedRuntimeControllerDependencies = {}) {
    // Registration is safe during extension loading: action APIs are intentionally deferred.
    validatePiApi(pi);
    this.pi = pi;
    this.dependencies = dependencies;
    this.integrity = registerParentIntegrity(pi, { passive: true });
    this.integrity.onSessionShutdown((cwd) => this.shutdownCheckout(cwd));
  }

  async resolve(cwdInput: string, identity: WorkflowControlIdentity): Promise<RuntimeSurfaceBinding> {
    const cwd = realpathSync(resolve(cwdInput));
    return this.serialize(cwd, () => this.resolveUnlocked(cwd, identity));
  }

  private async resolveUnlocked(cwd: string, identity: WorkflowControlIdentity): Promise<RuntimeSurfaceBinding> {
    let selected = readRuntimeSelection(cwd);
    this.preflight();
    let prior = this.slots.get(cwd);
    const coldStart = !prior;
    if (selected.status === "blocked") {
      this.stopBinding(cwd, prior);
      this.integrity.block(cwd);
      const blocked = { kind: "blocked" as const, generation: null, identity: prior?.identity ?? this.boundIdentity(cwd, identity), mutations: new WorkflowMutationService(cwd), registry: prior?.registry ?? sweRuntimeRegistry, reason: selected.reason };
      this.slots.set(cwd, blocked);
      return blocked;
    }
    if (prior?.kind === selected.runtime && prior.generation === selected.generation && this.bindingStillAuthoritative(cwd, prior, selected, identity)) return prior;
    this.stopBinding(cwd, prior);
    if (prior) { this.slots.delete(cwd); prior = undefined; }
    if (coldStart && selected.record) selected = await this.rotateRestartParent(cwd, selected, identity);
    const boundIdentity = this.boundIdentity(cwd, identity, selected.record?.handoff.parent.runtimeId);
    if (coldStart && selected.record?.handoff.parent.sessionId === identity.sessionId) {
      await recoverRuntimeWorkflows(cwd, { sessionId: boundIdentity.sessionId, runtimeId: boundIdentity.runtimeId });
    } else if (coldStart && !selected.record) {
      const competing = listWorkflowTopics(cwd).map((topic) => loadWorkflow(cwd, topic, false)?.workflow.orchestration.parent).find((parent) => parent?.valid && parent.sessionId !== identity.sessionId);
      if (competing) {
        const blocked = { kind: "blocked" as const, generation: selected.generation, identity: boundIdentity, mutations: new WorkflowMutationService(cwd), registry: sweRuntimeRegistry, reason: "compatibility runtime belongs to a different live session; use explicit recovery" };
        this.integrity.block(cwd);
        this.slots.set(cwd, blocked);
        return blocked;
      }
      await recoverRuntimeWorkflows(cwd, { sessionId: boundIdentity.sessionId, runtimeId: boundIdentity.runtimeId });
    }
    if (selected.runtime === "compatibility") {
      const service = new WorkflowMutationService(cwd);
      if (selected.record) {
        const workflow = service.read("swe-production-rollout", false)?.workflow;
        const parent = workflow?.orchestration.parent;
        const handoff = workflow?.orchestration.runtimeHandoff;
        const receipt = selected.record.handoff.parent;
        const durableMatch = handoff?.phase === "reclaimed" && handoff.id === selected.record.handoff.id && handoff.decisionId === selected.record.decision.decisionId && handoff.selectorGeneration === selected.generation && handoff.to === "compatibility" && parent?.valid === true && parent.ownerId === receipt.ownerId && parent.sessionId === receipt.sessionId && parent.runtimeId === receipt.runtimeId && parent.cwd === cwd;
        if (!durableMatch || parent.sessionId !== identity.sessionId) {
          const blocked = { kind: "blocked" as const, generation: selected.generation, identity: boundIdentity, mutations: service, registry: sweRuntimeRegistry, reason: "selected compatibility runtime lacks matching reclaimed durable parent authority" };
          this.integrity.block(cwd);
          this.slots.set(cwd, blocked);
          return blocked;
        }
        this.integrity.install(cwd, selected.generation, boundIdentity.runtimeId, boundIdentity.sessionId);
      } else {
        this.integrity.install(cwd, selected.generation, boundIdentity.runtimeId, boundIdentity.sessionId);
      }
      const binding = { kind: "compatibility" as const, generation: selected.generation, ...selectionBindingIdentity(selected), identity: boundIdentity, mutations: service, registry: new SweRuntimeRegistry() };
      this.slots.set(cwd, binding);
      return binding;
    }
    const receiptParent = selected.record?.handoff.parent;
    const service = new WorkflowMutationService(cwd);
    let authority = loadWorkflow(cwd, "swe-production-rollout", false)?.workflow;
    const handoff = authority?.orchestration.runtimeHandoff;
    const durableParent = authority?.orchestration.parent;
    const durableMatch = handoff?.phase === "reclaimed" && handoff.id === selected.record?.handoff.id && handoff.decisionId === selected.record?.decision.decisionId && handoff.selectorGeneration === selected.generation && handoff.to === "v2" && durableParent?.valid === true && durableParent.ownerId === receiptParent?.ownerId && durableParent.sessionId === receiptParent?.sessionId && durableParent.runtimeId === receiptParent?.runtimeId && durableParent.cwd === cwd;
    if (!receiptParent || !durableMatch) {
      const blocked = { kind: "blocked" as const, generation: selected.generation, identity: boundIdentity, mutations: service, registry: sweRuntimeRegistry, reason: "selected v2 runtime lacks matching reclaimed durable workflow authority" };
      this.integrity.block(cwd);
      this.slots.set(cwd, blocked);
      return blocked;
    }
    const parent = authority!.orchestration.parent!;
    if (parent.sessionId !== identity.sessionId) {
      const blocked = { kind: "blocked" as const, generation: selected.generation, identity: boundIdentity, mutations: service, registry: sweRuntimeRegistry, reason: "selected v2 runtime belongs to a different session; use the explicit recovery handoff" };
      this.integrity.block(cwd);
      this.slots.set(cwd, blocked);
      return blocked;
    }
    const runtime = createProductionRuntime({ cwd, pi: this.pi, parent: { ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, cwd, branchLength: identity.branchLength }, provider: identity.provider, model: identity.model, thinking: identity.thinking as AgentRunRequest["thinking"] });
    const binding = { kind: "v2" as const, generation: selected.generation, ...selectionBindingIdentity(selected), identity: boundIdentity, mutations: runtime.mutations, registry: runtime.registry, runtime };
    this.integrity.install(cwd, selected.generation, parent.runtimeId, identity.sessionId);
    this.slots.set(cwd, binding);
    return binding;
  }

  private bindingStillAuthoritative(cwd: string, binding: RuntimeSurfaceBinding, selected: Extract<RuntimeSelectionState, { status: "selected" }>, identity: WorkflowControlIdentity): boolean {
    if (binding.selectorPreimageHash !== selected.preimageHash || binding.authorityKey !== selectionAuthorityKey(selected)) return false;
    if (binding.identity.sessionId !== identity.sessionId) return false;
    const workflow = loadWorkflow(cwd, "swe-production-rollout", false)?.workflow;
    if (!selected.record) {
      const parent = workflow?.orchestration.parent;
      return !parent?.valid || parent.cwd === cwd && parent.sessionId === identity.sessionId && parent.runtimeId === binding.identity.runtimeId;
    }
    const parent = workflow?.orchestration.parent;
    const handoff = workflow?.orchestration.runtimeHandoff;
    const receipt = selected.record.handoff.parent;
    return handoff?.phase === "reclaimed" && handoff.id === selected.record.handoff.id && handoff.decisionId === selected.record.decision.decisionId
      && handoff.selectorGeneration === selected.generation && handoff.to === selected.runtime && parent?.valid === true
      && parent.ownerId === receipt.ownerId && parent.sessionId === receipt.sessionId && parent.runtimeId === receipt.runtimeId && parent.cwd === cwd
      && binding.identity.runtimeId === receipt.runtimeId;
  }

  private async rotateRestartParent(cwd: string, selected: Extract<RuntimeSelectionState, { status: "selected" }>, identity: WorkflowControlIdentity): Promise<Extract<RuntimeSelectionState, { status: "selected" }>> {
    const service = new WorkflowMutationService(cwd);
    let workflow = service.read("swe-production-rollout", false)?.workflow;
    if (!workflow) return selected;
    const parent = workflow.orchestration.parent;
    const durable = workflow.orchestration.runtimeHandoff;
    if (!parent || parent.sessionId !== identity.sessionId || parent.cwd !== cwd || parent.ownerId !== selected.record!.handoff.parent.ownerId) return selected;

    let record = selected.record!;
    const selectorAhead = record.handoff.from === record.handoff.to
      && record.generation === (durable?.selectorGeneration ?? 0) + 1
      && record.handoff.parent.runtimeId !== parent.runtimeId;
    if (!selectorAhead) {
      const exact = durable?.phase === "reclaimed" && durable.id === record.handoff.id && durable.selectorGeneration === record.generation && parent.runtimeId === record.handoff.parent.runtimeId;
      if (!exact) return selected;
      const now = new Date().toISOString();
      record = {
        ...record, generation: record.generation + 1,
        handoff: { id: randomUUID(), from: selected.runtime, to: selected.runtime, preparedWorkflowRevision: workflow.revision, preparedAt: now, selectedAt: now, parent: { ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: randomUUID() } },
      };
      writeRuntimeSelection(cwd, record, selected.generation, selected.preimageHash);
      selected = readRuntimeSelection(cwd) as Extract<RuntimeSelectionState, { status: "selected" }>;
    }
    const now = new Date().toISOString();
    const rotated = await service.rotateRuntimeParent("swe-production-rollout", workflow.revision, {
      handoffId: record.handoff.id, decisionId: record.decision.decisionId, from: record.handoff.from, to: record.handoff.to, selectorGeneration: record.generation,
      authority: { ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: record.handoff.parent.runtimeId, cwd, ...(parent.sessionFile ? { sessionFile: parent.sessionFile } : {}), claimedAt: now, valid: true },
    }, now);
    workflow = rotated.workflow;
    if (workflow.orchestration.parent?.runtimeId !== record.handoff.parent.runtimeId) throw new Error("atomic restart rotation did not install the selector parent");
    return selected;
  }

  async handoff(options: ControllerRuntimeHandoffOptions): Promise<RuntimeHandoffReceipt> {
    const cwd = realpathSync(resolve(options.cwd));
    return this.serialize(cwd, () => this.handoffUnlocked(cwd, options));
  }

  private async handoffUnlocked(cwd: string, options: ControllerRuntimeHandoffOptions): Promise<RuntimeHandoffReceipt> {
    this.preflight();
    const current = await this.resolveUnlocked(cwd, options.identity);
    const topic = "swe-production-rollout";
    const controlling = current.mutations.read(topic, false)?.workflow;
    if (controlling?.orchestration.parent && !controlling.orchestration.parent.valid && controlling.orchestration.runtimeHandoff?.phase !== "prepared") {
      const recoveredAt = new Date().toISOString();
      await current.mutations.mutate(topic, controlling.revision, (workflow) => reduceWorkflow(workflow, {
        type: "recover-parent",
        authority: { ownerId: `parent:${options.identity.sessionId}`, sessionId: options.identity.sessionId, runtimeId: `handoff-recovery-${randomUUID()}`, cwd, ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}), claimedAt: recoveredAt, valid: true },
        reason: "explicit runtime handoff after fenced parent shutdown",
        decidedBy: `interactive-session:${options.identity.sessionId}`,
      }, recoveredAt));
    }
    const freshRuntimeId = randomUUID();
    const activeTodo = await coordinatedActiveTodo(options.lifecycleContext);
    let provisional: RuntimeSurfaceBinding | undefined;
    try {
      const receipt = await performRuntimeHandoff({
        cwd, topic, targetRuntime: options.targetRuntime, ...(options.decision ? { decision: options.decision } : {}), ...(options.evidence ? { evidence: options.evidence } : {}), activeTodoCount: activeTodo ? 1 : 0, piVersion: PINNED_PI_VERSION, freshRuntimeId,
        parent: { ownerId: `parent:${options.identity.sessionId}`, sessionId: options.identity.sessionId, runtimeId: loadWorkflow(cwd, topic, false)?.workflow.orchestration.parent?.runtimeId, ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}) },
        currentRuntime: {
          registry: current.registry,
          shutdown: () => {
            if (this.slots.get(cwd) !== current) throw new Error("runtime slot changed before shutdown");
            this.stopBinding(cwd, current);
            this.slots.delete(cwd);
          },
        },
        fault: this.dependencies.handoffFault,
        reload: ({ runtime, generation, runtimeId }) => {
          if (runtime === "compatibility") {
            provisional = { kind: "compatibility", generation, identity: { ...options.identity, runtimeId }, mutations: new WorkflowMutationService(cwd), registry: new SweRuntimeRegistry() };
            return { runtimeId };
          }
          const production = createProductionRuntime({ cwd, pi: this.pi, parent: { ownerId: `parent:${options.identity.sessionId}`, sessionId: options.identity.sessionId, runtimeId, cwd, branchLength: options.identity.branchLength }, provider: options.identity.provider, model: options.identity.model, thinking: options.identity.thinking as AgentRunRequest["thinking"] });
          provisional = { kind: "v2", generation, identity: { ...options.identity, runtimeId }, mutations: production.mutations, registry: production.registry, runtime: production };
          return { runtimeId };
        },
      });
      provisional ??= this.slots.get(cwd);
      const selected = readRuntimeSelection(cwd);
      if (!provisional || selected.status !== "selected" || selected.runtime !== options.targetRuntime || selected.generation !== receipt.selectorGeneration || selected.record?.handoff.id !== receipt.handoffId || selected.record.handoff.parent.runtimeId !== receipt.freshParentRuntimeId) throw new Error("reclaimed runtime no longer matches the exact selector identity");
      Object.assign(provisional, selectionBindingIdentity(selected));
      this.integrity.install(cwd, receipt.selectorGeneration, receipt.freshParentRuntimeId, options.identity.sessionId);
      this.processRuntimeIds.set(cwd, receipt.freshParentRuntimeId);
      this.slots.set(cwd, provisional);
      return receipt;
    } catch (error) {
      if (provisional) this.stopBinding(cwd, provisional);
      this.slots.delete(cwd);
      this.processRuntimeIds.delete(cwd);
      this.integrity.block(cwd);
      throw error;
    }
  }

  shutdown(): void {
    for (const [cwd, slot] of this.slots) this.stopBinding(cwd, slot);
    this.integrity.invalidate();
    this.slots.clear();
    this.processRuntimeIds.clear();
  }

  private async shutdownCheckout(cwdInput: string): Promise<void> {
    const cwd = realpathSync(resolve(cwdInput));
    await this.serialize(cwd, async () => {
      this.stopBinding(cwd, this.slots.get(cwd));
      this.slots.delete(cwd);
      this.processRuntimeIds.delete(cwd);
      this.integrity.remove(cwd);
    });
  }

  private stopBinding(cwd: string, binding: RuntimeSurfaceBinding | undefined): void {
    if (!binding) return;
    for (const topic of listWorkflowTopics(cwd)) binding.registry.signal(topic, "interrupted");
    binding.runtime?.shutdown();
    if (binding.kind === "v2") this.integrity.remove(cwd, binding.generation ?? undefined);
  }

  private preflight(): void {
    validateTrustedTools(this.pi);
    if (resolvePinnedPiCli().version !== PINNED_PI_VERSION) throw new Error(`Pi API version mismatch: expected ${PINNED_PI_VERSION}`);
  }

  private boundIdentity(cwd: string, identity: WorkflowControlIdentity, selectedRuntimeId?: string): WorkflowControlIdentity {
    const route = this.integrity.identity(cwd);
    const routedRuntimeId = route?.generation === 0 && route.sessionId === identity.sessionId ? route.runtimeId : undefined;
    const runtimeId = selectedRuntimeId ?? this.processRuntimeIds.get(cwd) ?? routedRuntimeId ?? `parent-runtime-${randomUUID()}`;
    this.processRuntimeIds.set(cwd, runtimeId);
    return { ...identity, runtimeId };
  }

  private serialize<T>(cwd: string, operation: () => Promise<T> | T): Promise<T> {
    const prior = this.operations.get(cwd) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.operations.set(cwd, tail);
    void tail.finally(() => { if (this.operations.get(cwd) === tail) this.operations.delete(cwd); });
    return result;
  }
}

function selectionAuthorityKey(selected: Extract<RuntimeSelectionState, { status: "selected" }>): string {
  const record = selected.record;
  return record ? [record.handoff.id, record.decision.decisionId, record.handoff.parent.ownerId, record.handoff.parent.sessionId, record.handoff.parent.runtimeId].join("\0") : "generation-0";
}
function selectionBindingIdentity(selected: Extract<RuntimeSelectionState, { status: "selected" }>): Pick<RuntimeSurfaceBinding, "selectorPreimageHash" | "authorityKey"> {
  return { selectorPreimageHash: selected.preimageHash, authorityKey: selectionAuthorityKey(selected) };
}

export async function recoverRuntimeWorkflows(cwd: string, identity: { sessionId: string; runtimeId: string; now?: string }): Promise<Array<{ topic: string; recovered: boolean; reason: string }>> {
  const now = identity.now ?? new Date().toISOString();
  const outcomes: Array<{ topic: string; recovered: boolean; reason: string }> = [];
  for (const topic of listWorkflowTopics(cwd)) {
    const located = loadWorkflow(cwd, topic, false);
    if (!located || located.workflow.orchestration.mode !== "multi-agent" || located.workflow.status === "complete") continue;
    const service = new WorkflowMutationService(cwd);
    let workflow = located.workflow;
    const reasons: string[] = [];
    const lease = workflow.orchestration.activeRun;
    if (lease) {
      const cancelled = await service.cancelRun(topic, workflow.revision, lease, "parent runtime restart fenced orphaned child result");
      workflow = cancelled.workflow;
      reasons.push(`fenced run ${lease.runId}`);
    }
    const parent = workflow.orchestration.parent;
    if (parent?.valid && (parent.sessionId !== identity.sessionId || parent.runtimeId !== identity.runtimeId)) {
      const invalidated = await service.fenceParent(topic, workflow.revision, parent, "parent runtime restart or session replacement", now);
      workflow = invalidated.workflow;
      reasons.push("invalidated prior parent authority and one-shot checkpoints");
    }
    outcomes.push({ topic, recovered: reasons.length > 0, reason: reasons.join("; ") || "no orphaned runtime authority" });
  }
  return outcomes;
}

export function redactRuntimeText(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  let redacted = value.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/\b(token|password|secret|api[_-]?key)\s*=\s*[^\s]+/gi, "$1=[REDACTED]");
  for (const [name, secret] of Object.entries(environment)) {
    if (!secret || secret.length < 8 || !/(token|password|secret|api.?key|credential)/i.test(name)) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function validatedConfig(options: ProductionRuntimeOptions): ProductionRuntimeConfig {
  const provider = bounded(options.provider, "provider", 128);
  const model = bounded(options.model, "model", 256);
  if (FIXTURE_PROVIDER.test(provider) && !options.qualificationMode) throw new Error("fixture provider is restricted to explicit qualification mode");
  const budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const workspace = { ...DEFAULT_WORKSPACE, ...options.workspace };
  bounds(budgets.timeoutMs, 1_000, 24 * 60 * 60_000, "timeout budget");
  bounds(budgets.maxTurns, 1, 256, "turn budget");
  bounds(budgets.maxOutputBytes, 1_024, 1024 * 1024, "output budget");
  bounds(budgets.maxRetries, 0, 8, "retry budget");
  bounds(budgets.killGraceMs, 1, 30_000, "kill grace budget");
  bounds(workspace.maxFiles, 1, 10_000, "workspace file bound");
  bounds(workspace.maxBytes, 1, 256 * 1024 * 1024, "workspace byte bound");
  bounds(workspace.maxPatchBytes, 1, 64 * 1024 * 1024, "workspace patch bound");
  bounds(workspace.maxPathBytes, 1, 8_192, "workspace path bound");
  const projectInstructions = boundedList(options.projectInstructions ?? ["Follow workflow.json, preserve user work, and perform no commit, push, deploy, publish, or release."], "project instructions", 16);
  return { provider, model, thinking: options.thinking ?? "medium", budgets, workspace, projectInstructions, readScope: boundedList(options.readScope ?? ["**"], "read scope", 64), approvedSkills: boundedList(options.approvedSkills ?? [], "approved skills", 16), trustedExtensions: boundedList(options.trustedExtensions ?? [], "trusted extensions", 16) };
}
function validatePiApi(pi: ExtensionAPI): void {
  for (const name of ["registerCommand", "registerTool", "on", "getAllTools"] as const) if (typeof pi?.[name] !== "function") throw new Error(`required Pi API ${name} is unavailable`);
}
function validateTrustedTools(pi: ExtensionAPI): void {
  if (typeof pi.getAllTools !== "function") throw new Error("required Pi API getAllTools is unavailable");
  const tools = pi.getAllTools();
  for (const name of REQUIRED_TOOLS) {
    const tool = tools.find((candidate) => candidate.name === name);
    const source = tool?.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo as { source?: unknown; path?: unknown } : undefined;
    if (!tool || source?.source !== "builtin" || source.path !== `<builtin:${name}>`) throw new Error(`required trusted tool identity failed: ${name}`);
  }
}
function bounded(value: string, name: string, max: number): string { const next = value.trim(); if (!next || next.length > max || /[\r\n\0]/.test(next)) throw new Error(`${name} is invalid`); return next; }
function boundedList(values: string[], name: string, max: number): string[] { if (values.length > max) throw new Error(`${name} exceed configured bound`); return values.map((value) => bounded(value, name, 2_048)); }
function bounds(value: number, min: number, max: number, name: string): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside the validated production bound`); }
function message(error: unknown): string { return redactRuntimeText(error instanceof Error ? error.message : String(error)); }
