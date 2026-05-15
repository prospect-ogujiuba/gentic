import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  activeTodo,
  executeTodoAction,
  executeTodoCommand,
  getTodoCommandCompletions,
  reconcileTodoDocket,
  checkTodoDocketAtAgentEnd,
  checkTodoDocketAtMessageStart,
  checkTodoDocketBeforeFinalMessage,
  todoState,
  updateTodoWidget,
} from "./src/pi/actions.ts";
import { loadEffectiveTodoConfig } from "./src/config.ts";
import { decideToolPolicy } from "./src/domain/policy.ts";
import { resetTodoSessionNameMemory } from "./src/pi/session-name.ts";
import { todoToolParameters } from "./src/pi/schema.ts";

export default function piTodo(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") resetTodoSessionNameMemory();
    await updateTodoWidget(pi, ctx);
  });
  pi.on("message_start", async (event, ctx) => checkTodoDocketAtMessageStart(pi, ctx, event));
  pi.on("turn_end", async (_event, ctx) => checkTodoDocketBeforeFinalMessage(pi, ctx));
  pi.on("agent_end", async (_event, ctx) => checkTodoDocketAtAgentEnd(pi, ctx));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "todo") return;
    const state = await todoState(pi, ctx);
    if (activeTodo(state)) return;

    const { config, diagnostics } = loadEffectiveTodoConfig({ cwd: ctx.cwd });
    const decision = decideToolPolicy(event.toolName, config.enforcement);
    if (decision.action === "allow") return;

    const policySource = decision.reason === "rule" && decision.pattern ? `requireTodo rule '${decision.pattern}'` : "default requireTodo policy";
    const diagnosticNote = diagnostics.length > 0
      ? ` Config diagnostics: ${diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}.`
      : "";

    await updateTodoWidget(pi, ctx);
    return {
      block: true,
      reason: `pi-todo enforcement: ${policySource}; no active todo. Call todo({ "action": "begin" }) then retry the blocked tool.${diagnosticNote}`,
    };
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Unified Gentic todo ledger tool with create/create_organized/update/split/split_check/begin/claim/start/block/complete/finish/attach_evidence/create_artifact/note_artifact/record_artifact/verify/reopen/list/get/history/graph actions.",
    promptSnippet:
      "Use todo first. If no active todo, call todo action=begin; it deterministically returns active work or starts the next ready todo. Prefer finish over complete when ending active work. Prefer create_artifact/note_artifact for generated notes, reports, plans, logs, TODO files, and artifacts so pi-todo creates a valid .model-artifacts/<kind>/<topic>/ path and records evidence automatically. Use record_artifact only for files that already exist. For TODO/planning artifacts use kind=todo with category such as pi-todo, pi-swe, or gentic and subcategory for phase sets like pi-swe-phases.",
    parameters: todoToolParameters,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeTodoAction(pi, ctx, params);
    },
  });

  pi.registerCommand("todo", {
    description:
      "Open the Gentic todo dashboard. Observability: /todo list, /todo next, /todo graph <id>, /todo history <id>, /todo get <id>.",
    getArgumentCompletions: getTodoCommandCompletions,
    handler: async (args, ctx) => executeTodoCommand(pi, ctx, args),
  });
}
