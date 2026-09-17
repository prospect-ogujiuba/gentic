import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { GitInitiativeCloseoutInspector, InitiativeCloseoutAuthority, type InitiativeCloseoutInspector } from "./closeout.ts";
import { registerSweCommand } from "./command.ts";
import { AutonomousWorkflowDriver } from "./driver.ts";
import { GitRelevantSourceInspector, ManagedVerificationAuthority, registerParentIntegrity, type ParentExecutionIdentity, type RelevantSourceInspector } from "./integrity.ts";
import { OrchestrationEngine, type OrchestrationRunner, type OrchestrationWorkspace } from "./orchestration.ts";
import { AgentRunner, resolvePinnedPiCli, type AgentRunRequest, type RunnerBudgets } from "./runner.ts";
import { WorkflowMutationService } from "./service.ts";
import { listWorkflowTopics, loadWorkflow } from "./store.ts";
import { registerSweWorkflowTool } from "./tool.ts";
import { SweRuntimeRegistry } from "./ux.ts";
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

export type ActivationQualificationInput = {
  requested: boolean;
  migrationReady: boolean;
  piVersion: string;
  expectedPiVersion: string;
  extensionId: string;
  expectedExtensionId: string;
  repositorySupported: boolean;
  requiredTools: readonly string[];
  availableTools: readonly string[];
};
export type ActivationQualification = { active: boolean; reason: string };

/** Default is deliberately fail-closed. Production v2 activation is not enabled by this rollout phase. */
export function qualifyV2Activation(input: ActivationQualificationInput): ActivationQualification {
  if (!input.requested) return { active: false, reason: "v2 activation is disabled; compatibility runtime retained" };
  if (!input.migrationReady) return { active: false, reason: "workflow migration readiness is incomplete" };
  if (input.piVersion !== input.expectedPiVersion) return { active: false, reason: `Pi API version mismatch: expected ${input.expectedPiVersion}, found ${input.piVersion}` };
  if (input.extensionId !== input.expectedExtensionId) return { active: false, reason: "extension-runtime identity mismatch" };
  if (!input.repositorySupported) return { active: false, reason: "repository does not satisfy managed runtime preflight" };
  const missing = input.requiredTools.filter((tool) => !input.availableTools.includes(tool));
  if (missing.length) return { active: false, reason: `required trusted tools are unavailable: ${missing.join(", ")}` };
  return { active: true, reason: "qualification fixture prerequisites passed" };
}

export type QualifiedRuntimeSurface = Pick<ProductionRuntime, "registry" | "driver">;

/** Registration is callable only by qualification fixtures; the installed entrypoint retains compatibility v1. */
export function registerQualifiedV2Runtime(pi: ExtensionAPI, qualification: ActivationQualification, runtime?: QualifiedRuntimeSurface): ActivationQualification & { invalidate?: () => void } {
  validatePiApi(pi);
  if (!qualification.active) return qualification;
  if (!runtime || typeof runtime.registry?.list !== "function" || typeof runtime.driver?.start !== "function" || typeof runtime.driver?.resume !== "function") throw new Error("complete production runtime is required before v2 registration");
  validateTrustedTools(pi);
  try {
    const integrity = registerParentIntegrity(pi);
    registerSweCommand(pi);
    registerSweWorkflowTool(pi);
    return { ...qualification, invalidate: integrity.invalidate };
  } catch (error) {
    throw new Error(`v2 registration aborted; extension startup must fail rather than retain a partial compatibility/v2 mixture: ${message(error)}`);
  }
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
      const invalidated = await service.mutate(topic, workflow.revision, (current) => reduceWorkflow(current, { type: "invalidate-parent", ownerId: parent.ownerId, sessionId: parent.sessionId, runtimeId: parent.runtimeId, reason: "parent runtime restart or session replacement" }, now));
      workflow = invalidated.workflow;
      reasons.push("invalidated prior parent authority and one-shot checkpoints");
    }
    outcomes.push({ topic, recovered: reasons.length > 0, reason: reasons.join("; ") || "no orphaned runtime authority" });
  }
  return outcomes;
}

export function productionActivationQualification(pi: ExtensionAPI): ActivationQualification {
  const version = resolvePinnedPiCli().version;
  return qualifyV2Activation({ requested: false, migrationReady: false, piVersion: version, expectedPiVersion: PINNED_PI_VERSION, extensionId: "pi-swe", expectedExtensionId: "pi-swe", repositorySupported: false, requiredTools: REQUIRED_TOOLS, availableTools: pi.getAllTools().map((tool) => tool.name) });
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
