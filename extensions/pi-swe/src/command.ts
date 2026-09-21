import { execFileSync } from "node:child_process";

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { coordinatedActiveTodo } from "../../../src/lifecycle-coordination.ts";
import { parseGate1Authorization, type Gate1Authorization } from "../../../src/swe-migration-record.ts";
import { parseGate2Decision, parseStoredGate2Decision, readRuntimeSelection, runtimeSelectionStatus, type Gate2Decision } from "./cutover.ts";
import { loadWorkflow, resolveTopic } from "./store.ts";
import { applyWorkflowMigration, applyWorkflowMigrationBatch, inventoryWorkflowMigrations, planWorkflowMigration, recoverWorkflowMigration, renderWorkflowMigrationAudit, rollbackWorkflowMigration, type WorkflowMigrationDisposition } from "./migration.ts";
import type { RuntimeSurfaceResolver } from "./runtime.ts";
import { assertV2ExecutionRuntime, WorkflowMutationService } from "./service.ts";
import { identityFromContext, renderRunTails, SweRuntimeRegistry, WorkflowControlService } from "./ux.ts";
import { reduceWorkflow, type Workflow, type WorkflowApproach, type WorkflowTask } from "./workflow.ts";

const APPROACH_INSTRUCTIONS: Record<WorkflowApproach, string> = {
  tdd: "Establish a failing or characterization test before changing production code, then make it pass.",
  diagnosis: "Reproduce the problem and isolate the cause before selecting a fix.",
  dsa: "Document access patterns and complexity, compare alternatives, then choose the representation or algorithm.",
  security: "Check threats, trust boundaries, authorization, secrets, and hostile inputs relevant to the change.",
  performance: "Establish a measurable baseline and compare the same measurement after the change.",
  migration: "Validate compatibility, data or API transition behavior, and a safe rollback path.",
  "accessibility-ux": "Check affected user flows, keyboard and assistive use, states, and actionable feedback.",
  operations: "Check deployment, observability, failure recovery, rollback, and operator impact.",
};

const ROOT: AutocompleteItem[] = [
  { value: "status", label: "status", description: "/swe status [topic] — show workflow state" },
  { value: "work", label: "work", description: "/swe work <start|resume|pause|stop|status|inspect|runs> [topic] — control or inspect one workflow" },
  { value: "migrate", label: "migrate", description: "/swe migrate <audit|apply|recover|rollback> [topic] — explicit workflow migration" },
  { value: "runtime", label: "runtime", description: "/swe runtime cutover — keyboard-controlled Gate 2 v2 activation" },
  { value: "config", label: "config", description: "/swe config — explain the zero-config replacement" },
];
const RUNTIME: AutocompleteItem[] = [
  { value: "runtime cutover", label: "cutover", description: "/swe runtime cutover — validate reviewed Gate 2 evidence and activate v2" },
];
const WORK: AutocompleteItem[] = [
  { value: "work status", label: "status", description: "/swe work status [topic] — show bounded workflow and run state" },
  { value: "work inspect", label: "inspect", description: "/swe work inspect [topic] — inspect stage, decisions, and recovery" },
  { value: "work runs", label: "runs", description: "/swe work runs [topic] — show bounded recent report/output tails" },
  { value: "work start", label: "start", description: "/swe work start [topic] — start orchestrated work" },
  { value: "work resume", label: "resume", description: "/swe work resume [topic] — resume paused or blocked work" },
  { value: "work retry", label: "retry", description: "/swe work retry [topic] — explicitly retry recoverable blocked work" },
  { value: "work answer", label: "answer", description: "/swe work answer [topic] [question] — answer a clarification" },
  { value: "work reset", label: "reset", description: "/swe work reset [topic] — explicitly reset remediation budget" },
  { value: "work validate", label: "validate", description: "/swe work validate [topic] <approve|reject> — record manual validation" },
  { value: "work pause", label: "pause", description: "/swe work pause [topic] — pause durable work" },
  { value: "work stop", label: "stop", description: "/swe work stop [topic] — pause without deleting state" },
];

export function completeSweArgument(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trimStart();
  const choices = normalized.startsWith("work ") || normalized === "work" ? WORK : normalized.startsWith("runtime ") || normalized === "runtime" ? RUNTIME : ROOT;
  const matches = choices.filter((item) => item.value.startsWith(normalized));
  return matches.length ? matches : null;
}

export function registerControllerBoundSweCommand(pi: ExtensionAPI, runtimeResolver: RuntimeSurfaceResolver): void {
  registerSweCommandAdapter(pi, runtimeResolver);
}

function registerSweCommandAdapter(pi: ExtensionAPI, runtimeResolver: RuntimeSurfaceResolver, assertCwd?: (cwd: string) => void): void {
  pi.registerCommand("swe", {
    description: "Manage lightweight durable SWE workflows",
    getArgumentCompletions: completeSweArgument,
    handler: async (raw, ctx) => {
      try {
        assertCwd?.(ctx.cwd);
        const args = raw.trim().split(/\s+/).filter(Boolean);
        const root = args[0] ?? "status";
        if (root === "config") {
          ctx.ui.notify("pi-swe is zero-config: one workflow.json, one active task, agent-guided transparent approach assessment, objective verification, no implicit workflows", "info");
          return;
        }
        if (root === "migrate") {
          const operation = args[1] ?? "audit";
          if (operation === "audit") {
            const report = inventoryWorkflowMigrations(ctx.cwd);
            ctx.ui.notify(renderWorkflowMigrationAudit(report), report.complete ? "info" : "warning");
            return;
          }
          const selectedTopics = (args[2] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
          if (operation === "apply" && selectedTopics.length > 1) {
            const authorization = await requestMigrationAuthorization(ctx, selectedTopics);
            const plans = selectedTopics.map((topic) => planWorkflowMigration(ctx.cwd, topic, { disposition: authorization.topicDispositions[topic] as WorkflowMigrationDisposition, authorization }));
            if (!await ctx.ui.confirm("Apply authorized workflow migrations", `${selectedTopics.length} topics; actor ${authorization.authorizedBy}; audit ${authorization.auditHash}; retention ${authorization.rollbackRetentionUntil}?`)) throw new Error("workflow migration was not confirmed");
            const outcomes = await applyWorkflowMigrationBatch(ctx.cwd, plans);
            ctx.ui.notify(`pi-swe migration batch\n${outcomes.map((outcome) => `- ${outcome.topic}: ${outcome.status}${outcome.error ? `; next: ${outcome.error}` : "; next: re-audit"}`).join("\n")}`, outcomes.some((outcome) => outcome.status === "failed") ? "warning" : "info");
            return;
          }
          const topic = resolveTopic(ctx.cwd, selectedTopics[0]);
          if (operation === "recover") {
            const outcome = await recoverWorkflowMigration(ctx.cwd, topic);
            ctx.ui.notify(`pi-swe migration ${outcome.status}: ${outcome.nextAction}`, "info");
            return;
          }
          if (operation === "rollback") {
            if (!ctx.hasUI || !await ctx.ui.confirm("Rollback workflow migration", `${topic}: compare exact postimage and restore retained preimage?`)) throw new Error("migration rollback was not confirmed");
            const outcome = await rollbackWorkflowMigration(ctx.cwd, topic);
            ctx.ui.notify(`pi-swe migration ${outcome.status}; recovery receipt retained at ${outcome.receiptPath}`, "warning");
            return;
          }
          if (operation !== "apply") throw new Error("usage: /swe migrate <audit|apply|recover|rollback> [topic] [reopen|grandfather-read-only]");
          const inventory = inventoryWorkflowMigrations(ctx.cwd);
          const entry = inventory.entries.find((candidate) => candidate.topic === topic);
          if (!entry) throw new Error(`workflow ${topic} was not found`);
          if (!ctx.hasUI) throw new Error("migration apply requires an interactive keyboard-accessible explicit authorization record");
          const authorization = await requestMigrationAuthorization(ctx, [topic]);
          const disposition = authorization.topicDispositions[topic] as WorkflowMigrationDisposition;
          if (entry.action === "decide-completed-workflow" && !["reopen", "grandfather-read-only"].includes(disposition)) throw new Error("completed workflow authorization must explicitly choose reopen or grandfather-read-only");
          if (!await ctx.ui.confirm("Apply authorized workflow migration", `${topic}: ${disposition}; actor ${authorization.authorizedBy}; audit ${authorization.auditHash}; retention ${authorization.rollbackRetentionUntil}?`)) throw new Error("workflow migration was not confirmed");
          const plan = planWorkflowMigration(ctx.cwd, topic, { disposition, authorization });
          const outcome = await applyWorkflowMigration(ctx.cwd, plan);
          ctx.ui.notify(`pi-swe migration ${outcome.status}: ${topic}; receipt ${outcome.receiptPath}; next: re-audit before start/resume`, "info");
          return;
        }
        if (root === "runtime") {
          if (!ctx.hasUI) throw new Error("Gate 2 cutover and rollback require an interactive keyboard-accessible decision");
          const operation = args[1];
          if (operation === "rollback") assertV2ExecutionRuntime("compatibility", "roll back the runtime and restart");
          if (operation !== "cutover") throw new Error("usage: /swe runtime cutover");
          const selector = readRuntimeSelection(ctx.cwd);
          if (selector.status === "blocked") throw new Error(`runtime selector is ambiguous: ${selector.reason}`);
          const durableHandoff = loadWorkflow(ctx.cwd, "swe-production-rollout", false)?.workflow.orchestration.runtimeHandoff;
          let hasPreparedAttestation = false;
          if (durableHandoff?.phase === "prepared" && durableHandoff.decision) {
            parseStoredGate2Decision(durableHandoff.decision);
            hasPreparedAttestation = true;
          }
          const initialV2Admission = !selector.record && !hasPreparedAttestation;
          let decision: Gate2Decision | undefined;
          if (initialV2Admission) {
            const raw = await ctx.ui.input("Gate 2 decision JSON", "Paste the complete human authorization record");
            if (!raw || Buffer.byteLength(raw) > 16 * 1024) throw new Error("Gate 2 decision was cancelled, empty, or exceeds 16384 bytes");
            try { decision = parseGate2Decision(JSON.parse(raw)); } catch (error) { throw new Error(`invalid Gate 2 decision: ${error instanceof Error ? error.message : String(error)}`); }
          }
          let evidence: { readiness: string; migration: string } | undefined;
          if (initialV2Admission) {
            const readiness = await ctx.ui.input("Reviewed readiness evidence", "Absolute path to the mode-0600 readiness report");
            const migration = await ctx.ui.input("Reviewed migration evidence", "Absolute path to the mode-0600 migration report");
            if (!readiness?.trim() || !migration?.trim()) throw new Error("both reviewed Gate 2 evidence paths are required for initial v2 admission");
            evidence = { readiness: readiness.trim(), migration: migration.trim() };
          }
          const targetRuntime = "v2" as const;
          if (!await ctx.ui.confirm("Activate v2 runtime", `${runtimeSelectionStatus(ctx.cwd)}; atomically rotate parent authority to ${targetRuntime}?`)) throw new Error("runtime cutover was not confirmed");
          const identity = identityFromContext(ctx);
          const receipt = await runtimeResolver.handoff({ cwd: ctx.cwd, targetRuntime, ...(decision ? { decision } : {}), ...(evidence ? { evidence } : {}), identity, lifecycleContext: ctx, sessionFile: ctx.sessionManager.getSessionFile?.() });
          ctx.ui.notify(`pi-swe runtime cutover complete; generation ${receipt.selectorGeneration}; handoff ${receipt.handoffId}; fresh parent ${receipt.freshParentRuntimeId}\n${runtimeSelectionStatus(ctx.cwd)}`, "info");
          return;
        }
        const workAction = root === "work" ? args[1] ?? "status" : root;
        const topicArg = root === "work" ? args[2] : args[1];
        const topic = resolveTopic(ctx.cwd, topicArg);
        const identity = identityFromContext(ctx);
        const binding = await runtimeResolver.resolve(ctx.cwd, identity);
        const boundIdentity = binding.identity;
        const control = new WorkflowControlService(ctx.cwd, { mutations: binding.mutations, runtimes: binding.registry });
        if (workAction === "status" || workAction === "inspect") {
          ctx.ui.notify(`${runtimeSelectionStatus(ctx.cwd)}${binding.kind === "blocked" ? `\nruntime authority: blocked; ${binding.reason}` : ""}\n${control.inspect(topic, boundIdentity)}`, binding.kind === "blocked" ? "warning" : "info");
          return;
        }
        if (workAction === "runs") {
          const located = loadWorkflow(ctx.cwd, topic);
          if (!located) throw new Error(`workflow ${topic} was not found`);
          ctx.ui.notify(renderRunTails(located.workflow, binding.registry.list(topic)), "info");
          return;
        }
        if (binding?.kind === "blocked") throw new Error(`managed execution blocked: ${binding.reason}`);
        if (["start", "resume", "retry"].includes(workAction)) assertV2ExecutionRuntime(binding.kind, workAction === "retry" ? "resume" : workAction);
        if (["answer", "reset", "validate"].includes(workAction)) {
          if (!ctx.hasUI) throw new Error(`${workAction} requires an interactive keyboard-accessible user decision`);
          const located = control.mutations.read(topic);
          if (!located) throw new Error(`workflow ${topic} was not found`);
          const current = located.workflow;
          if (workAction === "answer") {
            const questions = [...(current.planReview?.questions ?? []), ...current.tasks.flatMap((task) => task.clarifications), ...(current.initiativeAcceptance?.questions ?? [])].filter((question) => !question.answer);
            if (!questions.length) throw new Error("no unanswered clarification is available");
            const requested = args[3];
            const questionId = requested ?? await ctx.ui.select("Choose clarification", questions.map((question) => `${question.id}: ${question.question}`)).then((choice) => choice?.split(":", 1)[0]);
            const question = questions.find((item) => item.id === questionId);
            if (!question) throw new Error(`clarification ${questionId ?? "selection"} was not found`);
            const answer = await ctx.ui.input(question.question, "Type an explicit answer");
            if (!answer?.trim()) throw new Error("clarification answer was cancelled or empty");
            const taskId = current.tasks.find((task) => task.clarifications.some((item) => item.id === question.id))?.id;
            const decision = await control.mutations.mutate(topic, current.revision, (state) => reduceWorkflow(state, { type: "respond-clarification", ...(taskId ? { taskId } : {}), questionId: question.id, answer, answeredBy: `interactive-user:${boundIdentity.sessionId}` }));
            ctx.ui.notify(`${decision.message}\n${control.inspect(topic, boundIdentity)}`, "info");
            return;
          }
          if (workAction === "reset") {
            const task = current.tasks.find((item) => item.status === "blocked" && item.phase === "remediation");
            if (!task) throw new Error("no remediation-blocked task is available to reset");
            const reason = await ctx.ui.input(`Reset remediation budget for ${task.id}?`, "Reason for explicit reset");
            if (!reason?.trim() || !await ctx.ui.confirm("Reset remediation budget", `${task.id}: ${reason}`)) throw new Error("remediation reset was not confirmed");
            const decision = await control.mutations.mutate(topic, current.revision, (state) => reduceWorkflow(state, { type: "reset-remediation", taskId: task.id, max: task.remediation.max + 1, reason, decidedBy: `interactive-user:${boundIdentity.sessionId}` }));
            ctx.ui.notify(`${decision.message}\n${control.inspect(topic, boundIdentity)}`, "info");
            return;
          }
          const disposition = args[3];
          if (disposition !== "approve" && disposition !== "reject") throw new Error("usage: /swe work validate <topic> <approve|reject>");
          if (current.closeout?.manualValidation?.status !== "required") throw new Error("manual validation is not currently required");
          const rationale = await ctx.ui.input(`Manual validation: ${disposition}`, "Observed result and rationale");
          if (!rationale?.trim() || !await ctx.ui.confirm("Record manual validation", `${disposition}: ${rationale}`)) throw new Error("manual validation was not confirmed");
          const decision = await control.mutations.mutate(topic, current.revision, (state) => reduceWorkflow(state, { type: "record-manual-validation", outcome: { status: disposition === "approve" ? "approved" : "rejected", rationale, decidedBy: `interactive-user:${boundIdentity.sessionId}`, at: new Date().toISOString() } }));
          ctx.ui.notify(`${decision.message}\n${control.inspect(topic, boundIdentity)}`, "info");
          return;
        }
        const transitionAction = workAction === "retry" ? "resume" : workAction;
        if (!["start", "resume", "pause", "stop"].includes(transitionAction)) throw new Error("usage: /swe work <start|resume|retry|pause|stop|status|inspect|runs|answer|reset|validate> [topic]");
        if (transitionAction === "start" || transitionAction === "resume") {
          const todo = await coordinatedActiveTodo(ctx);
          if (todo) throw new Error(`cannot activate while todo '${todo.title}' is active; finish or block that todo first`);
        }
        const located = control.mutations.read(topic);
        if (!located) throw new Error(`workflow ${topic} was not found`);
        if (binding?.kind === "v2" && (transitionAction === "start" || transitionAction === "resume")) {
          const driven = await binding.runtime!.driver[transitionAction](topic);
          ctx.ui.notify(`pi-swe v2 ${driven.outcome}: ${driven.handoff.message}\n${runtimeSelectionStatus(ctx.cwd)}\n${control.inspect(topic, boundIdentity)}`, driven.outcome === "infrastructure-failure" ? "error" : "info");
          return;
        }
        const outcome = await control.transition(topic, transitionAction as "pause" | "stop", boundIdentity);
        const { decision } = outcome;
        ctx.ui.notify(`pi-swe ${decision.message}\n${runtimeSelectionStatus(ctx.cwd)}\n${control.inspect(topic, boundIdentity)}`, decision.changed ? "info" : "warning");
        if (!decision.changed || (transitionAction !== "start" && transitionAction !== "resume")) return;
        if (outcome.prompt) {
          pi.sendUserMessage(outcome.prompt);
          return;
        }
        const task = decision.workflow.activeTask ? decision.workflow.tasks.find((item) => item.id === decision.workflow.activeTask) : undefined;
        if (task?.assessmentStatus === "assessed") pi.sendUserMessage(buildTaskExecutionPrompt(decision.workflow, task, located.path));
      } catch (error) {
        ctx.ui.notify(`pi-swe: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

async function requestMigrationAuthorization(ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1], selectedTopics: string[]): Promise<Gate1Authorization> {
  if (!ctx.hasUI) throw new Error("migration apply requires an interactive keyboard-accessible explicit authorization record");
  const raw = await ctx.ui.input("Gate 1 migration authorization JSON", "Paste the complete reviewed authorization record");
  if (!raw || Buffer.byteLength(raw) > 16 * 1024) throw new Error("migration authorization was cancelled, empty, or exceeds 16384 bytes");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("migration authorization must be valid JSON"); }
  const authorization = parseGate1Authorization(parsed);
  const covered = Object.keys(authorization.topicDispositions);
  if (JSON.stringify(covered) !== JSON.stringify([...selectedTopics].sort())) throw new Error("migration authorization topic dispositions must exactly cover the selected topics");
  return authorization;
}

/** @deprecated Test-fixture-only adapter retained for legacy unit tests. Production must use registerControllerBoundSweCommand. */
export function registerSweCommandFixtureOnly(pi: ExtensionAPI, suppliedResolver?: RuntimeSurfaceResolver): void {
  assertFixtureOnlyPi(pi);
  if (suppliedResolver) {
    registerSweCommandAdapter(pi, suppliedResolver, assertFixtureOnlyCheckout);
    return;
  }
  const fixtureResolver: RuntimeSurfaceResolver = {
    async resolve(cwd, identity) {
      assertFixtureOnlyCheckout(cwd);
      return { kind: "compatibility", generation: 0, identity, mutations: new WorkflowMutationService(cwd), registry: new SweRuntimeRegistry() };
    },
    async handoff() { throw new Error("runtime handoff is unavailable in the test-fixture-only adapter"); },
    shutdown() {},
  };
  registerSweCommandAdapter(pi, fixtureResolver, assertFixtureOnlyCheckout);
}

/** @deprecated Legacy unit-test alias; never import this from production composition. */
export const registerSweCommand = registerSweCommandFixtureOnly;

function assertFixtureOnlyPi(pi: ExtensionAPI): void {
  if (typeof (pi as ExtensionAPI & { on?: unknown }).on === "function" || typeof (pi as ExtensionAPI & { getAllTools?: unknown }).getAllTools === "function") throw new Error("test-fixture-only command registration rejects the complete production ExtensionAPI");
}

function assertFixtureOnlyCheckout(cwd: string): void {
  try {
    if (execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true") throw new Error("test-fixture-only command adapter rejects Git worktrees");
  } catch (error) {
    if (error instanceof Error && error.message === "test-fixture-only command adapter rejects Git worktrees") throw error;
  }
}

export function buildTaskExecutionPrompt(workflow: Workflow, task: WorkflowTask, path: string): string {
  const approaches = task.approaches.length
    ? task.approaches.map((approach) => `- ${approach}${task.approachReasons[approach] ? ` (${task.approachReasons[approach]})` : ""}: ${APPROACH_INSTRUCTIONS[approach]}`).join("\n")
    : "- none; use normal engineering judgment";
  const acceptance = task.acceptance.length ? task.acceptance.map((item) => `- ${item}`).join("\n") : "- no explicit criteria recorded";
  const scope = task.writeScope.length ? task.writeScope.map((item) => `- ${item}`).join("\n") : "- no write scope recorded; stop for plan revision";
  const nonGoals = task.nonGoals.length ? task.nonGoals.map((item) => `- ${item}`).join("\n") : "- none recorded";
  const verification = task.verification.length
    ? task.verification.map((item) => `- ${[item.command, ...item.args].join(" ")}`).join("\n")
    : task.verificationDecision
      ? `- manual validation decision by ${task.verificationDecision.decidedBy}: ${task.verificationDecision.rationale}`
      : "- no objective check recorded; block for an explicit validation decision";
  return `Continue pi-swe workflow ${workflow.topic}, task ${task.id}: ${task.title}.
Read ${path} and any linked plan. Implement only this task.

Write scope:
${scope}

Non-goals:
${nonGoals}

Applicable approaches (advisory and user-overridable):
${approaches}

Acceptance:
${acceptance}

Planned verification:
${verification}

Follow the applicable approach instructions during implementation. Run every planned objective check with the protected bash tool and call swe_workflow action=verify after each result, then call swe_workflow action=complete. If implementation reveals a material scope or design change, stop and call swe_workflow action=revise to reassess every incomplete task before continuing. Stop for a genuine user decision or unsafe external action.`;
}
