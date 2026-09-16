import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { coordinatedActiveTodo } from "../../../src/lifecycle-coordination.ts";
import { buildTaskExecutionPrompt } from "./command.ts";
import { loadWorkflow, resolveTopic, workflowPath } from "./store.ts";
import { WorkflowMutationService } from "./service.ts";
import { identityFromContext, renderRunTails, sweRuntimeRegistry, WorkflowControlService } from "./ux.ts";
import { bindVerificationCheckpoint, createWorkflow, reduceWorkflow, reviseWorkflow, summarizeWorkflow, WORKFLOW_APPROACHES, type ApproachReasons, type VerificationCommand, type Workflow, type WorkflowApproach, type WorkflowEvent } from "./workflow.ts";

const Action = StringEnum(["status", "inspect", "runs", "dismiss-run", "create", "migrate", "revise", "start", "pause", "stop", "resume", "verify", "complete", "block"] as const);
const Command = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 256 }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
});
const Approach = StringEnum(WORKFLOW_APPROACHES);
const ApproachReasonsSchema = Type.Object(Object.fromEntries(WORKFLOW_APPROACHES.map((approach) => [approach, Type.Optional(Type.String({ minLength: 1, maxLength: 1024 }))])));
const Task = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Optional(StringEnum(["implementation", "coordination"] as const)),
  dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 })),
  acceptance: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 })),
  approaches: Type.Array(Approach, { maxItems: WORKFLOW_APPROACHES.length, uniqueItems: true, description: "Applicable advisory approaches after assessing every supported concern; use [] when none apply" }),
  approachReasons: Type.Optional(ApproachReasonsSchema),
  writeScope: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 64, uniqueItems: true, description: "Project-relative paths or /** prefixes the implementer may change" }),
  nonGoals: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32, uniqueItems: true, description: "Explicit out-of-scope outcomes; use [] only after assessing non-goals" }),
  verification: Type.Optional(Type.Array(Command, { maxItems: 16 })),
  verificationDecision: Type.Optional(Type.Object({
    kind: StringEnum(["manual"] as const),
    rationale: Type.String({ minLength: 1, maxLength: 2048 }),
    decidedBy: Type.String({ minLength: 1, maxLength: 128 }),
    at: Type.String({ minLength: 1, maxLength: 64 }),
  })),
});

export const sweWorkflowParameters = Type.Object({
  action: Action,
  topic: Type.Optional(Type.String({ description: "Workflow topic; inferred only when exactly one workflow exists" })),
  goal: Type.Optional(Type.String({ maxLength: 2048 })),
  plan: Type.Optional(Type.String({ maxLength: 2048, description: "Optional project-relative plan path or concise plan summary" })),
  tasks: Type.Optional(Type.Array(Task, { minItems: 1, maxItems: 100 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exited runtime entry to dismiss; accepted workflow reports are never deleted" })),
});

export type SweWorkflowInput = {
  action: "status" | "inspect" | "runs" | "dismiss-run" | "create" | "migrate" | "revise" | "start" | "pause" | "stop" | "resume" | "verify" | "complete" | "block";
  topic?: string;
  goal?: string;
  plan?: string;
  tasks?: Array<{ id: string; title: string; kind?: "implementation" | "coordination"; dependsOn?: string[]; acceptance?: string[]; approaches: WorkflowApproach[]; approachReasons?: ApproachReasons; writeScope: string[]; nonGoals: string[]; verification?: VerificationCommand[]; verificationDecision?: { kind: "manual"; rationale: string; decidedBy: string; at: string } }>;
  reason?: string;
  runId?: string;
};

export function registerSweWorkflowTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "swe_workflow",
    label: "SWE Workflow",
    description: "Manage one lightweight repository SWE workflow. Create or safely revise a task graph with transparent per-task approach assessments, start one ready task, bind the latest protected bash result as verification, complete it, or report status. State is one workflow.json file. Existing pi-swe v2 initiatives can be migrated without shadowing them.",
    promptSnippet: "Manage durable multi-step SWE work without generated planning or report files",
    promptGuidelines: [
      "Use swe_workflow only for work that benefits from durable multi-step coordination; do not create a workflow for small or single-turn changes.",
      "On every swe_workflow create or revise, assess each task for tdd, diagnosis, dsa, security, performance, migration, accessibility-ux, and operations; store only applicable approaches, give a concise required applicability reason for each, and use an empty approaches array when none apply.",
      "For every swe_workflow implementation task, record a bounded project-relative writeScope and explicit nonGoals. Do not execute outside that scope.",
      "For applicable approaches, add corresponding acceptance criteria and planned verification commands wherever an objective check is possible. When automation is not meaningful, block for an explicit manual verification decision instead of inventing a passing command. Users may inspect or override the assessment with swe_workflow status or revise.",
      "Run every planned verification command with the protected bash tool and bind each result with swe_workflow verify in the following tool turn; all planned checks are required before completion.",
      "If implementation discovers a material scope or design change, call swe_workflow revise and reassess every incomplete task before continuing.",
    ],
    parameters: sweWorkflowParameters,
    async execute(_toolCallId, params: SweWorkflowInput, _signal, onUpdate, ctx) {
      if (["status", "inspect", "runs", "dismiss-run"].includes(params.action)) {
        const topic = resolveTopic(ctx.cwd, params.topic);
        const located = loadWorkflow(ctx.cwd, topic);
        if (!located) throw new Error(`workflow ${topic} was not found`);
        const control = new WorkflowControlService(ctx.cwd);
        if (params.action === "dismiss-run") {
          const dismissed = sweRuntimeRegistry.dismiss(topic, required(params.runId, "runId"));
          return result(`${dismissed ? "dismissed exited runtime entry" : "no exited runtime entry matched"}; accepted reports remain in workflow.json\n${control.inspect(topic, identityFromContext(ctx))}`, located.workflow, located.kind);
        }
        const text = params.action === "runs" ? renderRunTails(located.workflow, sweRuntimeRegistry.list(topic)) : control.inspect(topic, identityFromContext(ctx));
        return result(text, located.workflow, located.kind);
      }
      const topic = params.action === "create" ? required(params.topic, "topic") : resolveTopic(ctx.cwd, params.topic);
      const service = new WorkflowMutationService(ctx.cwd);
      if (params.action === "create") {
        const workflow = createWorkflow({ topic, goal: required(params.goal, "goal"), plan: params.plan, linkedPlanContent: service.linkedPlanContent(params.plan), tasks: params.tasks ?? [] });
        const path = await service.create(workflow);
        return result(`created ${topic}\n${summarizeWorkflow(workflow)}\nstate: ${path}`, workflow, "native");
      }
      if (params.action === "migrate") {
        const located = await service.migrate(topic);
        return result(`migrated ${topic}\n${summarizeWorkflow(located.workflow)}\nstate: ${located.path}`, located.workflow, "native");
      }
      const located = service.read(topic);
      if (!located) throw new Error(`workflow ${topic} was not found`);
      const workflow = located.workflow;
      if (params.action === "start" || params.action === "resume") await requireNoActiveTodo(ctx);
      if (["start", "resume", "pause", "stop"].includes(params.action)) {
        const control = new WorkflowControlService(ctx.cwd, { mutations: service });
        const transition = await control.transition(topic, params.action as "start" | "resume" | "pause" | "stop", identityFromContext(ctx));
        let text = `${transition.decision.message}\n${control.inspect(topic, identityFromContext(ctx))}`;
        if (transition.prompt) text += `\n\n${transition.prompt}`;
        else if ((params.action === "start" || params.action === "resume") && transition.decision.changed) {
          const task = activeTask(transition.decision.workflow);
          if (task?.assessmentStatus === "assessed") text += `\n\n${buildTaskExecutionPrompt(transition.decision.workflow, task, workflowPath(topic))}`;
        }
        return result(text, transition.decision.workflow, "native");
      }
      if (params.action === "revise") {
        const decision = await service.mutate(topic, workflow.revision, (current) => {
          const next = reviseWorkflow(current, { goal: params.goal, plan: params.plan, linkedPlanContent: service.linkedPlanContent(params.plan ?? current.plan), tasks: params.tasks ?? [] });
          next.workflow = bindVerificationCheckpoint(next.workflow, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch().length);
          return next;
        }, { allowPlanDrift: true });
        let text = `${decision.message}\n${summarizeWorkflow(decision.workflow)}`;
        const active = activeTask(decision.workflow);
        if (decision.workflow.status === "active" && active?.assessmentStatus === "assessed") text += `\n\n${buildTaskExecutionPrompt(decision.workflow, active, workflowPath(topic))}`;
        return result(text, decision.workflow, "native");
      }
      if (params.action === "verify") {
        const active = activeTask(workflow);
        if (!active?.verificationCheckpoint) throw new Error("active task has no activation/revision checkpoint; start or resume it before verification");
        const evidence = latestBashEvidence(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), workflow.revision, active.verificationCheckpoint);
        if (active.verification.length && !active.verification.some((command) => commandText(command) === evidence.command)) throw new Error(`latest bash command is not a planned verification for ${active.id}; expected one of: ${active.verification.map(commandText).join(", ")}`);
        onUpdate?.({ content: [{ type: "text", text: `Binding protected bash result ${evidence.source.toolCallId}` }], details: {} });
        const decision = await service.mutate(topic, workflow.revision, (current) => {
          if (current.tasks.some((task) => task.evidence.some((item) => item.source?.toolCallId === evidence.source.toolCallId && item.source.sessionId === evidence.source.sessionId))) throw new Error("latest bash result is already recorded in this workflow");
          return reduceWorkflow(current, { type: "record-verification", evidence });
        });
        return result(`${decision.message}; exit ${evidence.exitCode}`, decision.workflow, "native");
      }
      let event: WorkflowEvent;
      if (params.action === "complete" && workflow.orchestration.mode === "multi-agent") throw new Error("managed multi-agent completion must advance through OrchestrationEngine so live ownership, snapshot, review, verification, and final acceptance gates cannot diverge");
      if (params.action === "complete") ensureNoImplementationAfterVerification(ctx.sessionManager.getBranch(), workflow);
      if (params.action === "block") event = { type: "block", reason: required(params.reason, "reason") };
      else if (params.action === "complete") event = { type: "complete-task" };
      else throw new Error(`unsupported workflow action ${params.action}`);
      const decision = await service.mutate(topic, workflow.revision, (current) => {
        const next = reduceWorkflow(current, event);
        const activated = activeTask(next.workflow);
        if (next.changed && params.action === "complete" && activated?.id !== current.activeTask) next.workflow = bindVerificationCheckpoint(next.workflow, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch().length);
        return next;
      });
      const activated = activeTask(decision.workflow);
      const didActivate = decision.changed && params.action === "complete" && activated?.id !== workflow.activeTask;
      let text = `${decision.message}\n${summarizeWorkflow(decision.workflow)}`;
      if (didActivate && activated?.assessmentStatus === "assessed") text += `\n\n${buildTaskExecutionPrompt(decision.workflow, activated, workflowPath(topic))}`;
      return result(text, decision.workflow, "native");
    },
  });
}

async function requireNoActiveTodo(ctx: { cwd: string; sessionManager: { getBranch(): readonly unknown[] } }): Promise<void> {
  const todo = await coordinatedActiveTodo(ctx);
  if (todo) throw new Error(`cannot activate pi-swe while todo '${todo.title}' is active; finish or block that todo first`);
}
function activeTask(workflow: Workflow) {
  return workflow.activeTask ? workflow.tasks.find((task) => task.id === workflow.activeTask) : undefined;
}
function result(text: string, workflow: Workflow, source: "native" | "legacy") {
  return { content: [{ type: "text" as const, text }], details: { workflow, source } };
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function commandText(command: VerificationCommand): string {
  return [command.command, ...command.args].join(" ").trim();
}
type SessionEntry = { type?: string; message?: { role?: string; toolName?: string; toolCallId?: string; content?: unknown; isError?: boolean; timestamp?: number } };

function latestBashEvidence(entries: readonly SessionEntry[], sessionId: string, workflowRevision: number, checkpoint: { at: string; sessionId?: string; branchLength?: number }) {
  let latestResultIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index]?.type === "message" && entries[index]?.message?.role === "toolResult") { latestResultIndex = index; break; }
  const latestResult = latestResultIndex >= 0 ? entries[latestResultIndex] : undefined;
  if (!latestResult?.message || latestResult.message.toolName !== "bash" || !latestResult.message.toolCallId) {
    throw new Error("latest session tool result must be from the protected bash tool; run verification with bash first");
  }
  if (checkpoint.sessionId !== undefined && checkpoint.sessionId !== sessionId) throw new Error("verification session differs from the activation checkpoint; resume the task before verification");
  if (checkpoint.branchLength !== undefined && latestResultIndex < checkpoint.branchLength) throw new Error("latest bash result predates the active task branch checkpoint; run verification again");
  if (typeof latestResult.message.timestamp !== "number" || latestResult.message.timestamp <= Date.parse(checkpoint.at)) throw new Error("latest bash result predates the active task activation/revision checkpoint; run verification again");
  const callId = latestResult.message.toolCallId;
  const assistant = [...entries].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant" && toolCalls(entry.message.content).some((call) => call.id === callId));
  const call = assistant ? toolCalls(assistant.message?.content).find((item) => item.id === callId) : undefined;
  if (!call || call.name !== "bash" || typeof call.arguments.command !== "string" || !call.arguments.command.trim()) throw new Error("could not bind the latest bash result to its command");
  const text = textContent(latestResult.message.content);
  const reportedCode = text.match(/Command exited with code (\d+)\s*$/)?.[1];
  const exitCode = latestResult.message.isError ? Number(reportedCode ?? 1) : 0;
  return {
    command: call.arguments.command.trim(),
    args: [],
    exitCode,
    at: typeof latestResult.message.timestamp === "number" ? new Date(latestResult.message.timestamp).toISOString() : new Date().toISOString(),
    source: { kind: "bash-tool-result" as const, toolCallId: callId, workflowRevision, sessionId },
  };
}

const READ_ONLY_AFTER_VERIFICATION = new Set(["read", "swe_workflow", "todo", "ctx_search", "ctx_stats", "ctx_doctor", "context_mode_ctx_search", "context_mode_ctx_stats", "context_mode_ctx_doctor", "web_search", "code_search"]);

function ensureNoImplementationAfterVerification(entries: readonly SessionEntry[], workflow: Workflow): void {
  const active = activeTask(workflow);
  if (!active?.evidence.length) return; // The reducer reports the normal missing-evidence error.
  const resultIndex = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) resultIndex.set(entry.message.toolCallId, index);
  });
  const checkpoint = active.verificationCheckpoint;
  const checkpointEvidence = active.evidence.filter((item) => !!checkpoint && Date.parse(item.at) > Date.parse(checkpoint.at)
    && item.source?.workflowRevision !== undefined && item.source.workflowRevision >= checkpoint.revision
    && (checkpoint.sessionId === undefined || item.source.sessionId === checkpoint.sessionId));
  const recordedIds = new Set(checkpointEvidence.map((item) => item.source?.toolCallId).filter((id): id is string => !!id));
  const boundary = checkpoint?.branchLength ?? 0;
  let lastMutation = boundary - 1;
  for (let index = boundary; index < entries.length; index += 1) {
    const message = entries[index]?.message;
    if (entries[index]?.type === "message" && message?.role === "toolResult" && !READ_ONLY_AFTER_VERIFICATION.has(message.toolName ?? "") && !recordedIds.has(message.toolCallId ?? "")) lastMutation = index;
  }
  const currentPassing = checkpointEvidence.filter((item) => item.exitCode === 0 && !!item.source?.toolCallId && (resultIndex.get(item.source.toolCallId) ?? -1) > lastMutation);
  const missing = active.verification.filter((planned) => !currentPassing.some((item) => commandText(item) === commandText(planned)));
  const latest = active.evidence.at(-1)!;
  const latestIndex = latest.source?.toolCallId ? resultIndex.get(latest.source.toolCallId) : undefined;
  if (latestIndex === undefined) throw new Error("latest verification result is no longer on the active session branch; run verification again");
  if (latestIndex <= lastMutation || missing.length) {
    const detail = missing.length ? ` Missing checks after that change: ${missing.map(commandText).join(", ")}.` : "";
    throw new Error(`a potentially mutating tool ran after recorded verification; rerun verification before completion.${detail}`);
  }
}

function toolCalls(content: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return content.filter((item): item is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => !!item && typeof item === "object" && item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string" && !!item.arguments && typeof item.arguments === "object");
}

function textContent(content: unknown): string {
  return Array.isArray(content) ? content.filter((item): item is { type: "text"; text: string } => !!item && typeof item === "object" && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n") : "";
}
