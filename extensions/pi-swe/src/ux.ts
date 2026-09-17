import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activeWorkflowTopics, loadWorkflow, workflowPath } from "./store.ts";
import { WorkflowMutationService } from "./service.ts";
import { GitWorkspaceManager, type GitIntegrationReceipt, type GitWorkspaceReceipt } from "./workspace.ts";
import { bindVerificationCheckpoint, reduceWorkflow, type Clarification, type RunLease, type RunnerRole, type StageReport, type Workflow, type WorkflowDecision, type WorkflowTask } from "./workflow.ts";

const MAX_RUNS = 12;
const MAX_TAIL_CHARS = 4_096;
const MAX_ITEMS = 8;

export type RunOutcome = "running" | "cancelled" | "interrupted" | "crashed" | "timed-out" | "changes-requested" | "blocked" | "completed";
export type RuntimeRun = {
  topic: string;
  runId: string;
  role?: RunnerRole;
  stage: RunLease["stage"];
  taskId?: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  outcome: RunOutcome;
  reportTail?: string;
  outputTail?: string;
  controller?: AbortController;
};

/** Process-local handles only. Durable lifecycle and accepted reports remain in workflow.json. */
export class SweRuntimeRegistry {
  private readonly runs = new Map<string, RuntimeRun[]>();

  begin(run: RuntimeRun): void {
    const entries = this.runs.get(run.topic) ?? [];
    entries.push({ ...run, reportTail: boundedTail(run.reportTail), outputTail: boundedTail(run.outputTail) });
    this.runs.set(run.topic, entries.slice(-MAX_RUNS));
  }

  settle(topic: string, runId: string, patch: Pick<RuntimeRun, "outcome"> & Partial<Pick<RuntimeRun, "completedAt" | "reportTail" | "outputTail">>): void {
    const run = this.runs.get(topic)?.findLast((entry) => entry.runId === runId);
    if (!run) return;
    const outcome = (run.outcome === "cancelled" || run.outcome === "interrupted") && patch.outcome === "completed" ? run.outcome : patch.outcome;
    Object.assign(run, patch, { outcome, reportTail: boundedTail(patch.reportTail ?? run.reportTail), outputTail: boundedTail(patch.outputTail ?? run.outputTail), controller: undefined });
  }

  signal(topic: string, outcome: "cancelled" | "interrupted"): boolean {
    const running = (this.runs.get(topic) ?? []).filter((entry) => entry.outcome === "running");
    for (const run of running) {
      run.outcome = outcome;
      run.completedAt = new Date().toISOString();
      run.controller?.abort(new Error(`pi-swe run ${outcome}`));
    }
    return running.length > 0;
  }

  list(topic: string): RuntimeRun[] { return (this.runs.get(topic) ?? []).map((run) => ({ ...run, controller: undefined })); }
  dismiss(topic: string, runId: string): boolean {
    const entries = this.runs.get(topic) ?? [];
    const next = entries.filter((run) => run.runId !== runId || run.outcome === "running");
    this.runs.set(topic, next);
    return next.length !== entries.length;
  }
}

export const sweRuntimeRegistry = new SweRuntimeRegistry();

export type WorkflowControlIdentity = {
  sessionId: string;
  runtimeId: string;
  provider: string;
  model: string;
  thinking: string;
  branchLength: number;
};

export type WorkflowControlResult = {
  decision: WorkflowDecision;
  prompt?: string;
  recovery: RecoveryAssessment;
};

export type RecoveryAssessment = {
  safe: boolean;
  issues: string[];
  preservedWorkspace: string;
  nextAction: string;
};

export type ContextualWorkflowAction = {
  id: "start" | "resume" | "inspect" | "answer" | "validate" | "retry" | "reset" | "pause" | "stop";
  command: string;
  label: string;
  primary: boolean;
};

/** Ordered, keyboard-addressable actions derived only from durable workflow state. */
export function contextualWorkflowActions(workflow: Workflow): ContextualWorkflowAction[] {
  const primaryCommand = nextAction(workflow);
  const id = actionId(primaryCommand);
  const actions: ContextualWorkflowAction[] = id ? [{ id, command: primaryCommand, label: actionLabel(id), primary: true }] : [];
  if (["active", "blocked", "paused"].includes(workflow.status)) {
    for (const control of ["pause", "stop"] as const) if (control !== id) actions.push({ id: control, command: `/swe work ${control} ${workflow.topic}`, label: actionLabel(control), primary: false });
  }
  return actions;
}

export class WorkflowControlService {
  readonly cwd: string;
  readonly mutations: WorkflowMutationService;
  readonly runtimes: SweRuntimeRegistry;

  constructor(cwd: string, options: { mutations?: WorkflowMutationService; runtimes?: SweRuntimeRegistry } = {}) {
    this.cwd = cwd;
    this.mutations = options.mutations ?? new WorkflowMutationService(cwd);
    this.runtimes = options.runtimes ?? sweRuntimeRegistry;
  }

  status(topic: string, identity?: Partial<WorkflowControlIdentity>, now = new Date()): string {
    const located = loadWorkflow(this.cwd, topic);
    if (!located) throw new Error(`workflow ${topic} was not found`);
    return renderWorkflowInspection(located.workflow, this.runtimes.list(topic), identity, now);
  }

  inspect(topic: string, identity?: Partial<WorkflowControlIdentity>, now = new Date()): string {
    return this.status(topic, identity, now);
  }

  async transition(topic: string, action: "start" | "resume" | "pause" | "stop", identity: WorkflowControlIdentity): Promise<WorkflowControlResult> {
    const located = this.mutations.read(topic);
    if (!located) throw new Error(`workflow ${topic} was not found`);
    let workflow = located.workflow;
    if (action === "pause" || action === "stop") {
      // Abort first: cancellation must never queue behind the workflow mutation lock.
      this.runtimes.signal(topic, action === "stop" ? "cancelled" : "interrupted");
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const latest = this.mutations.read(topic);
        if (!latest) throw new Error(`workflow ${topic} was not found`);
        try {
          const cancelled = latest.workflow.orchestration.activeRun
            ? await this.mutations.cancelRun(topic, latest.workflow.revision, latest.workflow.orchestration.activeRun, action === "stop" ? "stopped by user" : "paused by user")
            : { workflow: latest.workflow };
          const decision = await this.mutations.mutate(topic, cancelled.workflow.revision, (current) => reduceWorkflow(current, { type: "pause" }));
          return { decision, recovery: assessRecovery(decision.workflow) };
        } catch (error) {
          if (!/workflow changed|stale run lease/i.test(error instanceof Error ? error.message : String(error)) || attempt === 3) throw error;
        }
      }
      throw new Error("pause could not fence the active child after bounded retries");
    }

    const others = activeWorkflowTopics(this.cwd, topic);
    if (others.length) throw new Error(`cannot activate ${topic} while workflow ${others.join(", ")} is active; pause or complete it first`);
    let recovery = assessRecovery(workflow);
    if (workflow.orchestration.mode === "multi-agent") {
      const active = workflow.orchestration.activeRun;
      if (active && Date.parse(active.expiresAt) > Date.now()) throw new Error(`run ${active.runId} is still active; pause or stop it before resuming`);
      if (active) {
        const cancelled = await this.mutations.cancelRun(topic, workflow.revision, active, "expired or orphaned lease recovered before resume");
        workflow = cancelled.workflow;
      }
      if (workflow.orchestration.parent && !workflow.orchestration.parent.valid) {
        const recovered = await this.mutations.mutate(topic, workflow.revision, (current) => reduceWorkflow(current, { type: "recover-parent", authority: {
          ownerId: `parent:${identity.sessionId}`, sessionId: identity.sessionId, runtimeId: identity.runtimeId, cwd: this.cwd, claimedAt: new Date().toISOString(), valid: true,
        }, reason: "explicit start/resume after invalidated parent", decidedBy: `interactive-session:${identity.sessionId}` }));
        workflow = recovered.workflow;
      }
      const task = currentTask(workflow);
      if (task?.workspaceReceipt?.version === 1 && task.integrationReceipt?.version === 1 && ["verification", "ready-to-complete"].includes(task.phase)) {
        let observed;
        try { observed = new GitWorkspaceManager(this.cwd).inspectVerificationSource(task.workspaceReceipt as GitWorkspaceReceipt, task.integrationReceipt as GitIntegrationReceipt); }
        catch (error) { throw new Error(`recovery inspection failed; preserved workspace was not discarded: ${error instanceof Error ? error.message : String(error)}`); }
        if (observed.hash !== task.integrationReceipt.postSnapshotHash) {
          const invalidated = await this.mutations.mutate(topic, workflow.revision, (current) => reduceWorkflow(current, { type: "invalidate-integrated-source", observedSnapshotHash: observed.hash, observedChangedPaths: observed.changedPaths, reason: "stale repository snapshot detected during resume" }));
          throw new Error(`stale repository snapshot entered bounded remediation; inspect ${invalidated.workflow.topic} before retrying`);
        }
      }
      recovery = assessRecovery(workflow);
      if (!recovery.safe) throw new Error(`recovery decision required: ${recovery.issues.join("; ")}. ${recovery.nextAction}`);
    }
    const decision = await this.mutations.mutate(topic, workflow.revision, (current) => {
      const next = reduceWorkflow(current, { type: action });
      if (next.changed) next.workflow = bindVerificationCheckpoint(next.workflow, identity.sessionId, identity.branchLength);
      return next;
    });
    const prompt = decision.changed && decision.workflow.orchestration.mode === "multi-agent"
      ? buildOrchestratorPrompt(decision.workflow, identity)
      : undefined;
    return { decision, prompt, recovery: assessRecovery(decision.workflow) };
  }
}

export function assessRecovery(workflow: Workflow, now = new Date()): RecoveryAssessment {
  const issues: string[] = [];
  const task = currentTask(workflow);
  const lease = workflow.orchestration.activeRun;
  if (lease && Date.parse(lease.expiresAt) <= now.getTime()) issues.push(`expired/orphaned lease ${lease.runId} will be fenced`);
  if (workflow.orchestration.parent && !workflow.orchestration.parent.valid) issues.push("parent ownership is invalidated; claim a fresh parent and checkpoints before execution");
  if (task?.workspaceReceipt && !task.integrationReceipt) issues.push(task.workspaceReceipt.preparedResultRef ? "prepared integration is preserved and must be resumed idempotently" : "recovery workspace exists but integration is not prepared");
  if (task?.integrationReceipt && ["verification", "ready-to-complete"].includes(task.phase)) issues.push("integrated snapshot must be re-inspected before verification or completion");
  const answered = clarifications(workflow).filter((item) => item.answer && !answerConsumed(workflow, item));
  if (answered.length) issues.push(`${answered.length} clarification answer(s) remain unconsumed`);
  if (workflow.orchestration.phase === "initiative-acceptance" && workflow.closeout && !workflow.initiativeAcceptance) issues.push("initiative acceptance was interrupted; re-inspect the closeout snapshot before continuing");
  const unsafe = issues.some((item) => /invalidated|not prepared/i.test(item));
  const preservedWorkspace = task?.workspaceReceipt ? `${task.workspaceReceipt.workspaceId} (${task.workspaceReceipt.changedPaths.length} paths, preserved)` : "none";
  return {
    safe: !unsafe,
    issues,
    preservedWorkspace,
    nextAction: unsafe ? "Inspect recovery state and make an explicit retry/reset decision; no parent fallback is allowed." : nextAction(workflow),
  };
}

export function buildOrchestratorPrompt(workflow: Workflow, identity: WorkflowControlIdentity): string {
  const task = currentTask(workflow);
  return `Orchestrate pi-swe workflow ${workflow.topic} from ${workflowPath(workflow.topic)} at revision ${workflow.revision}.
Use the v2 OrchestrationEngine one finite stage at a time with fresh role children; do not implement in this parent and never fall back to a single implementing parent if a child cannot start.
Parent: owner parent:${identity.sessionId}, session ${identity.sessionId}, runtime ${identity.runtimeId}. Child provider/model: ${identity.provider}/${identity.model} (${identity.thinking}).
Current stage: ${stage(workflow, task)}${task ? `; task ${task.id}` : ""}.
Re-read workflow.json before every mutation. Respect fenced ownership, prepared workspaces, protected verification, remediation limits, independent review, and final initiative acceptance. Treat controls as workflow-integrity mechanisms, not an OS sandbox. Do not commit, push, deploy, release, or perform other external side effects.
Inspect progress with /swe work inspect ${workflow.topic} or swe_workflow action=inspect topic=${workflow.topic}; these are native non-PTY runs, so interactive-shell /attach does not apply.`;
}

export function renderWorkflowInspection(workflow: Workflow, runtimeRuns: RuntimeRun[] = [], identity: Partial<WorkflowControlIdentity> = {}, now = new Date()): string {
  const task = currentTask(workflow);
  const recovery = assessRecovery(workflow, now);
  const reports = durableRuns(workflow);
  const runs = [...reports, ...runtimeRuns].filter((run, index, all) => all.findIndex((item) => item.runId === run.runId) === index).slice(-MAX_RUNS).reverse();
  const active = workflow.orchestration.activeRun;
  const activeRuntime = active ? runtimeRuns.findLast((run) => run.runId === active.runId) : undefined;
  const providerModel = activeRuntime ? `${activeRuntime.provider}/${activeRuntime.model}` : identity.provider && identity.model ? `${identity.provider}/${identity.model}` : "not recorded";
  const findingList = (task?.findings ?? workflow.initiativeAcceptance?.findings ?? []).slice(-MAX_ITEMS);
  const questions = clarifications(workflow).filter((item) => !item.answer).slice(-MAX_ITEMS);
  const outcome = runs[0]?.outcome ?? (workflow.status === "complete" ? "completed" : workflow.status === "blocked" ? "blocked" : "pending");
  const lines = [
    `pi-swe ${workflow.topic} — ${workflow.status} (revision ${workflow.revision})`,
    `stage: ${stage(workflow, task)}`,
    `run: ${active?.runId ?? "none"}; role: ${activeRuntime?.role ?? roleForStage(active?.stage ?? stage(workflow, task)) ?? "none"}`,
    `provider/model: ${providerModel}`,
    `elapsed: ${elapsed(activeRuntime?.startedAt ?? active?.acquiredAt, now)}; outcome: ${outcome}`,
    `findings: ${findingList.length ? findingList.map((item) => `${item.id}[${item.severity}/${item.status}] ${boundedLine(item.summary)}`).join(" | ") : "none"}`,
    `clarifications: ${questions.length ? questions.map((item) => `${item.id}: ${boundedLine(item.question)}`).join(" | ") : "none"}`,
    `retry/remediation: ${task ? `${task.remediation.used}/${task.remediation.max}` : "n/a"}`,
    `workspace: ${recovery.preservedWorkspace}`,
    `recovery: ${recovery.issues.length ? recovery.issues.slice(0, MAX_ITEMS).join(" | ") : "none"}`,
    `next: ${recovery.nextAction}`,
    `actions: ${contextualWorkflowActions(workflow).map((action) => `${action.primary ? "primary" : "secondary"}:${action.label} (${action.command})`).join(" | ") || "none"}`,
    "inspect: /swe work inspect [topic] or swe_workflow action=inspect; /swe work runs [topic] shows bounded report/output tails. Native non-PTY runs cannot be opened with interactive-shell /attach.",
  ];
  if (runs.length) lines.push("recent runs:", ...runs.slice(0, 5).map((run) => `- ${run.runId} ${run.role ?? roleForStage(run.stage) ?? "stage"} ${run.outcome} ${elapsed(run.startedAt, now)}${run.reportTail ? ` — ${boundedLine(run.reportTail, 240)}` : ""}`));
  return boundedTail(lines.join("\n"), 12_000)!;
}

export function renderRunTails(workflow: Workflow, runtimeRuns: RuntimeRun[] = [], now = new Date()): string {
  const runs = [...durableRuns(workflow), ...runtimeRuns].slice(-MAX_RUNS).reverse();
  if (!runs.length) return `No active or recent runs for ${workflow.topic}. Reports remain in workflow.json.`;
  return runs.map((run) => `${run.runId} | ${run.role ?? roleForStage(run.stage) ?? "stage"} | ${run.provider}/${run.model} | ${run.outcome} | ${elapsed(run.startedAt, now)}\nreport: ${boundedTail(run.reportTail, 640) ?? "none"}\noutput: ${boundedTail(run.outputTail, 640) ?? "not retained"}`).join("\n\n").slice(0, 16_000);
}

function durableRuns(workflow: Workflow): RuntimeRun[] {
  const reports = [workflow.planReview, ...workflow.tasks.flatMap((task) => task.reports), workflow.initiativeAcceptance].filter((value): value is StageReport => !!value);
  return reports.slice(-MAX_RUNS).map((report) => ({
    topic: workflow.topic, runId: report.provenance.runId, role: report.provenance.role, stage: report.kind === "final-acceptance" ? "initiative-acceptance" : report.kind === "plan-review" ? "plan-review" : report.kind === "implementation" ? "implementation" : report.kind,
    taskId: workflow.tasks.find((task) => task.reports.includes(report))?.id,
    provider: report.provenance.provider ?? "not recorded", model: report.provenance.model ?? "not recorded", startedAt: report.provenance.startedAt, completedAt: report.provenance.completedAt,
    outcome: report.outcome === "changes-requested" ? "changes-requested" : report.outcome === "failed" ? "crashed" : report.outcome === "needs-input" ? "blocked" : "completed",
    reportTail: [report.summary, report.rationale, ...report.findings.map((finding) => `${finding.id}: ${finding.summary}`)].filter(Boolean).join("\n"),
  }));
}

function currentTask(workflow: Workflow): WorkflowTask | undefined {
  return workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : workflow.tasks.find((task) => task.status === "blocked");
}
function stage(workflow: Workflow, task?: WorkflowTask): RunLease["stage"] {
  if (workflow.orchestration.phase === "complete") return "complete";
  if (workflow.orchestration.phase === "initiative-acceptance") return "initiative-acceptance";
  return task?.phase ?? workflow.orchestration.phase;
}
function roleForStage(value: RunLease["stage"] | string): RunnerRole | undefined {
  if (value === "plan-review") return "plan-reviewer";
  if (value === "implementation" || value === "remediation") return "implementer";
  if (value === "general-review") return "general-reviewer";
  if (value === "concern-review") return "concern-reviewer";
  if (value === "initiative-acceptance") return "final-reviewer";
  return undefined;
}
function clarifications(workflow: Workflow): Clarification[] {
  return [...(workflow.planReview?.questions ?? []), ...workflow.tasks.flatMap((task) => task.clarifications), ...(workflow.initiativeAcceptance?.questions ?? [])];
}
function answerConsumed(workflow: Workflow, clarification: Clarification): boolean {
  return [workflow.planReview, ...workflow.tasks.flatMap((task) => task.reports), workflow.initiativeAcceptance].filter((report): report is StageReport => !!report).some((report) => report.provenance.runId !== clarification.askedByRunId && Date.parse(report.provenance.startedAt) >= Date.parse(clarification.answeredAt ?? ""));
}
function nextAction(workflow: Workflow): string {
  if (workflow.status === "complete") return "No workflow action; implementation acceptance does not authorize commit, push, deployment, or release.";
  if (workflow.closeout?.manualValidation?.status === "required") return `/swe work validate ${workflow.topic} <approve|reject> (interactive user decision required)`;
  if (clarifications(workflow).some((item) => !item.answer)) return `/swe work answer ${workflow.topic} [question-id]`;
  const blocked = workflow.tasks.find((task) => task.status === "blocked");
  if (blocked?.phase === "remediation" && blocked.remediation.used >= blocked.remediation.max) return `/swe work reset ${workflow.topic} (interactive reason and confirmation required)`;
  if (workflow.status === "paused") return `/swe work resume ${workflow.topic}`;
  if (workflow.status === "blocked") return `/swe work retry ${workflow.topic} after resolving the displayed blocker; tool calls cannot fabricate a user decision.`;
  if (workflow.orchestration.activeRun) return `/swe work inspect ${workflow.topic}`;
  return `/swe work start ${workflow.topic}`;
}
function actionId(command: string): ContextualWorkflowAction["id"] | undefined {
  return (["answer", "validate", "reset", "resume", "retry", "inspect", "start"] as const).find((id) => command.includes(`/swe work ${id} `));
}
function actionLabel(id: ContextualWorkflowAction["id"]): string {
  return ({ start: "Start workflow", resume: "Resume workflow", inspect: "Inspect active run", answer: "Answer clarification", validate: "Record manual validation", retry: "Retry blocked stage", reset: "Reset remediation budget", pause: "Pause safely", stop: "Stop child work" })[id];
}
function elapsed(start: string | undefined, now: Date): string {
  if (!start || !Number.isFinite(Date.parse(start))) return "n/a";
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(start)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}
function boundedLine(value: string, max = 320): string { const line = value.replace(/\s+/g, " ").trim(); return line.length <= max ? line : `${line.slice(0, max - 1)}…`; }
function boundedTail(value: string | undefined, max = MAX_TAIL_CHARS): string | undefined { if (!value) return undefined; return value.length <= max ? value : `…${value.slice(-(max - 1))}`; }

export function identityFromContext(ctx: Partial<Pick<ExtensionContext, "sessionManager" | "model" | "thinkingLevel">>): WorkflowControlIdentity {
  const sessionId = ctx.sessionManager?.getSessionId() ?? "unbound-session";
  return {
    sessionId, runtimeId: `session:${sessionId}`,
    provider: ctx.model?.provider ?? "unselected", model: ctx.model?.id ?? "unselected", thinking: ctx.thinkingLevel ?? "off",
    branchLength: ctx.sessionManager?.getBranch().length ?? 0,
  };
}
