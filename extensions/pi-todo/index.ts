import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTodoActivityProbe } from "../../src/lifecycle-coordination.ts";
import { BranchTodoCore } from "./src/state-core.ts";
import { registerLightweightTodoSurface } from "./src/thin-surface.ts";

export default function piTodo(pi: ExtensionAPI): void {
  registerTodoActivityProbe(async (ctx) => {
    const core = new BranchTodoCore({
      getBranch: () => ctx.sessionManager.getBranch() as never,
      appendEntry: () => undefined,
    });
    const state = core.state();
    const todo = state.activeTodoId ? state.todos[state.activeTodoId] : undefined;
    return todo ? { id: todo.id, title: todo.title } : undefined;
  });
  registerLightweightTodoSurface(pi);
}
