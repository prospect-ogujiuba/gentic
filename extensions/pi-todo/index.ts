import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  activeTodo,
  executeTodoAction,
  executeTodoCommand,
  getTodoCommandCompletions,
  todoState,
  updateTodoWidget,
} from "./src/pi/actions.ts";
import { resetTodoSessionNameMemory } from "./src/pi/session-name.ts";
import { todoToolParameters } from "./src/pi/schema.ts";

export default function piTodo(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") resetTodoSessionNameMemory();
    await updateTodoWidget(pi, ctx);
  });
  pi.on("turn_end", async (_event, ctx) => updateTodoWidget(pi, ctx));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "todo") return;
    const state = await todoState(pi, ctx);
    if (activeTodo(state)) return;
    await updateTodoWidget(pi, ctx);
    return {
      block: true,
      reason: "pi-todo enforcement: use the todo tool first and claim/start a todo before using other tools.",
    };
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Unified Gentic todo ledger tool with create/update/split/split_check/claim/start/block/complete/attach_evidence/record_artifact/create_artifact/verify/reopen/list/get/history/graph actions.",
    promptSnippet:
      "Use todo first. Non-todo tools are blocked until a todo is claimed or started. Use todo as the unified Gentic todo ledger tool for durable planning and lifecycle actions. Generated notes, reports, plans, logs, TODO files, and artifacts belong under .model-artifacts/<kind>/<topic>/ and must be recorded with todo action=record_artifact. For TODO/planning artifacts use .model-artifacts/todo/<topic>/, where <topic> is preferably the concrete extension/project such as pi-todo, pi-swe, or gentic; use subfolders for coherent phase sets like pi-swe-phases.",
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
