import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { coordinatedActiveTodo } from "../../../src/lifecycle-coordination.ts";
import { activeWorkflowTopics, loadWorkflow, resolveTopic } from "./store.ts";
import { WorkflowMutationService } from "./service.ts";
import { bindVerificationCheckpoint, reduceWorkflow, summarizeWorkflow, type Workflow, type WorkflowApproach, type WorkflowTask } from "./workflow.ts";

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
  { value: "work", label: "work", description: "/swe work <start|resume|pause|stop|status> [topic] — control one workflow" },
  { value: "migrate", label: "migrate", description: "/swe migrate <topic> — import an existing pi-swe v2 initiative" },
  { value: "config", label: "config", description: "/swe config — explain the zero-config replacement" },
];
const WORK: AutocompleteItem[] = [
  { value: "work status", label: "status", description: "/swe work status [topic] — show workflow state" },
  { value: "work start", label: "start", description: "/swe work start [topic] — start ready work in one agent run" },
  { value: "work resume", label: "resume", description: "/swe work resume [topic] — resume paused or blocked work" },
  { value: "work pause", label: "pause", description: "/swe work pause [topic] — pause durable work" },
  { value: "work stop", label: "stop", description: "/swe work stop [topic] — pause without deleting state" },
];

export function completeSweArgument(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trimStart();
  const choices = normalized.startsWith("work ") || normalized === "work" ? WORK : ROOT;
  const matches = choices.filter((item) => item.value.startsWith(normalized));
  return matches.length ? matches : null;
}

export function registerSweCommand(pi: ExtensionAPI): void {
  pi.registerCommand("swe", {
    description: "Manage lightweight durable SWE workflows",
    getArgumentCompletions: completeSweArgument,
    handler: async (raw, ctx) => {
      try {
        const args = raw.trim().split(/\s+/).filter(Boolean);
        const root = args[0] ?? "status";
        if (root === "config") {
          ctx.ui.notify("pi-swe is zero-config: one workflow.json, one active task, agent-guided transparent approach assessment, objective verification, no implicit workflows", "info");
          return;
        }
        if (root === "migrate") {
          const topic = resolveTopic(ctx.cwd, args[1]);
          const located = await new WorkflowMutationService(ctx.cwd).migrate(topic);
          ctx.ui.notify(`pi-swe migrated ${topic} to ${located.path}`, "info");
          return;
        }
        const workAction = root === "work" ? args[1] ?? "status" : root;
        const topicArg = root === "work" ? args[2] : args[1];
        const topic = resolveTopic(ctx.cwd, topicArg);
        if (workAction === "status") {
          const located = loadWorkflow(ctx.cwd, topic);
          if (!located) throw new Error(`workflow ${topic} was not found`);
          ctx.ui.notify(summarizeWorkflow(located.workflow), "info");
          return;
        }
        if (!["start", "resume", "pause", "stop"].includes(workAction)) throw new Error("usage: /swe <status|config|migrate|work>");
        if (workAction === "start" || workAction === "resume") {
          const todo = await coordinatedActiveTodo(ctx);
          if (todo) throw new Error(`cannot activate while todo '${todo.title}' is active; finish or block that todo first`);
          const active = activeWorkflowTopics(ctx.cwd, topic);
          if (active.length) throw new Error(`cannot activate ${topic} while workflow ${active.join(", ")} is active; pause or complete it first`);
        }
        const service = new WorkflowMutationService(ctx.cwd);
        const located = service.read(topic);
        if (!located) throw new Error(`workflow ${topic} was not found`);
        const workflow = located.workflow;
        const event = workAction === "stop" ? { type: "pause" as const } : { type: workAction as "start" | "resume" | "pause" };
        const decision = await service.mutate(topic, workflow.revision, (current) => {
          if (workAction === "start" || workAction === "resume") {
            const active = activeWorkflowTopics(ctx.cwd, topic);
            if (active.length) throw new Error(`cannot activate ${topic} while workflow ${active.join(", ")} is active; pause or complete it first`);
          }
          const next = reduceWorkflow(current, event);
          if (next.changed && (workAction === "start" || workAction === "resume")) next.workflow = bindVerificationCheckpoint(next.workflow, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch().length);
          return next;
        });
        ctx.ui.notify(`pi-swe ${decision.message}`, decision.changed ? "info" : "warning");
        if (decision.changed && (workAction === "start" || workAction === "resume") && decision.workflow.activeTask) {
          const task = decision.workflow.tasks.find((item) => item.id === decision.workflow.activeTask)!;
          if (task.assessmentStatus !== "assessed") return;
          const path = located.path === ".model-artifacts/initiatives/" + topic + "/specs/manifest.json" ? located.path : `.model-artifacts/initiatives/${topic}/workflow.json`;
          pi.sendUserMessage(buildTaskExecutionPrompt(decision.workflow, task, path));
        }
      } catch (error) {
        ctx.ui.notify(`pi-swe: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
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
