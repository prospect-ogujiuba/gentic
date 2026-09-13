import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadWorkflow, migrateLegacyWorkflow, resolveTopic, saveWorkflow, workflowPath } from "./store.ts";
import { createWorkflow, reduceWorkflow, summarizeWorkflow, type VerificationCommand, type Workflow, type WorkflowEvent } from "./workflow.ts";

const Action = StringEnum(["status", "create", "migrate", "start", "pause", "resume", "verify", "complete", "block"] as const);
const Command = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 256 }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
});
const Task = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 })),
  acceptance: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64 })),
  verification: Type.Optional(Type.Array(Command, { maxItems: 16 })),
});

export const sweWorkflowParameters = Type.Object({
  action: Action,
  topic: Type.Optional(Type.String({ description: "Workflow topic; inferred only when exactly one workflow exists" })),
  goal: Type.Optional(Type.String({ maxLength: 2048 })),
  plan: Type.Optional(Type.String({ maxLength: 2048, description: "Optional project-relative plan path or concise plan summary" })),
  tasks: Type.Optional(Type.Array(Task, { minItems: 1, maxItems: 100 })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Executable for verify; shell syntax is not interpreted" })),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
});

export type SweWorkflowInput = {
  action: "status" | "create" | "migrate" | "start" | "pause" | "resume" | "verify" | "complete" | "block";
  topic?: string;
  goal?: string;
  plan?: string;
  tasks?: Array<{ id: string; title: string; dependsOn?: string[]; acceptance?: string[]; verification?: VerificationCommand[] }>;
  command?: string;
  args?: string[];
  reason?: string;
};

export function registerSweWorkflowTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "swe_workflow",
    label: "SWE Workflow",
    description: "Manage one lightweight repository SWE workflow. Create a task graph, start one ready task, run and record an objective verification command, complete it, or report status. State is one workflow.json file. Existing pi-swe v2 initiatives are migrated on first mutation.",
    promptSnippet: "Manage durable multi-step SWE work without generated planning or report files",
    promptGuidelines: [
      "Use swe_workflow only for work that benefits from durable multi-step coordination; do not create a workflow for small or single-turn changes.",
      "Use swe_workflow verify to run acceptance commands, then complete the active task only after a passing result.",
    ],
    parameters: sweWorkflowParameters,
    async execute(_toolCallId, params: SweWorkflowInput, signal, onUpdate, ctx) {
      if (params.action === "status") {
        const topic = resolveTopic(ctx.cwd, params.topic);
        const located = loadWorkflow(ctx.cwd, topic);
        if (!located) throw new Error(`workflow ${topic} was not found`);
        return result(summarizeWorkflow(located.workflow), located.workflow, located.kind);
      }
      const topic = params.action === "create" ? required(params.topic, "topic") : resolveTopic(ctx.cwd, params.topic);
      const target = resolve(ctx.cwd, workflowPath(topic));
      return withFileMutationQueue(target, async () => {
        if (params.action === "create") {
          if (loadWorkflow(ctx.cwd, topic, false)) throw new Error(`workflow ${topic} already exists`);
          const workflow = createWorkflow({ topic, goal: required(params.goal, "goal"), plan: params.plan, tasks: params.tasks ?? [] });
          const path = saveWorkflow(ctx.cwd, workflow);
          return result(`created ${topic}\n${summarizeWorkflow(workflow)}\nstate: ${path}`, workflow, "native");
        }
        if (params.action === "migrate") {
          const located = migrateLegacyWorkflow(ctx.cwd, topic);
          return result(`migrated ${topic}\n${summarizeWorkflow(located.workflow)}\nstate: ${located.path}`, located.workflow, "native");
        }
        const located = migrateLegacyWorkflow(ctx.cwd, topic);
        const workflow = located.workflow;
        if (params.action === "verify") {
          const configured = workflow.tasks.find((task) => task.id === workflow.activeTask)?.verification[0];
          const command = params.command?.trim() || configured?.command;
          if (!command) throw new Error("command is required because the active task has no configured verification");
          const args = params.args ?? configured?.args ?? [];
          onUpdate?.({ content: [{ type: "text", text: `Running ${[command, ...args].join(" ")}` }], details: {} });
          const execution = await pi.exec(command, args, { signal });
          const evidence = { command, args, exitCode: execution.code, at: new Date().toISOString() };
          const decision = reduceWorkflow(workflow, { type: "record-verification", evidence });
          if (decision.changed) saveWorkflow(ctx.cwd, decision.workflow, workflow.revision);
          const output = bounded([execution.stdout, execution.stderr].filter(Boolean).join("\n"));
          return result(`${decision.message}; exit ${execution.code}${output ? `\n${output}` : ""}`, decision.workflow, "native");
        }
        let event: WorkflowEvent;
        if (params.action === "block") event = { type: "block", reason: required(params.reason, "reason") };
        else if (params.action === "complete") event = { type: "complete-task" };
        else if (params.action === "start" || params.action === "resume" || params.action === "pause") event = { type: params.action };
        else throw new Error(`unsupported workflow action ${params.action}`);
        const decision = reduceWorkflow(workflow, event);
        if (decision.changed) saveWorkflow(ctx.cwd, decision.workflow, workflow.revision);
        return result(`${decision.message}\n${summarizeWorkflow(decision.workflow)}`, decision.workflow, "native");
      });
    },
  });
}

function result(text: string, workflow: Workflow, source: "native" | "legacy") {
  return { content: [{ type: "text" as const, text }], details: { workflow, source } };
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function bounded(value: string): string { return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n[output truncated]`; }
