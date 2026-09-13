import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadWorkflow, migrateLegacyWorkflow, resolveTopic, saveWorkflow } from "./store.ts";
import { reduceWorkflow, summarizeWorkflow } from "./workflow.ts";

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
          ctx.ui.notify("pi-swe is zero-config: one workflow.json, one active task, objective verification, no implicit workflows", "info");
          return;
        }
        if (root === "migrate") {
          const topic = resolveTopic(ctx.cwd, args[1]);
          const located = migrateLegacyWorkflow(ctx.cwd, topic);
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
        const located = migrateLegacyWorkflow(ctx.cwd, topic);
        const workflow = located.workflow;
        const event = workAction === "stop" ? { type: "pause" as const } : { type: workAction as "start" | "resume" | "pause" };
        const decision = reduceWorkflow(workflow, event);
        if (decision.changed) saveWorkflow(ctx.cwd, decision.workflow, workflow.revision);
        ctx.ui.notify(`pi-swe ${decision.message}`, decision.changed ? "info" : "warning");
        if ((workAction === "start" || workAction === "resume") && decision.workflow.activeTask) {
          const task = decision.workflow.tasks.find((item) => item.id === decision.workflow.activeTask)!;
          pi.sendUserMessage(
            `Continue pi-swe workflow ${topic}, task ${task.id}: ${task.title}. Read ${located.path === ".model-artifacts/initiatives/" + topic + "/specs/manifest.json" ? located.path : `.model-artifacts/initiatives/${topic}/workflow.json`} and any linked plan. Implement only this task, run appropriate checks with swe_workflow action=verify, then call swe_workflow action=complete. Stop for a genuine user decision, unsafe external action, or material plan change.`,
          );
        }
      } catch (error) {
        ctx.ui.notify(`pi-swe: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
