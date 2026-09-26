import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TODO_WORKFLOW_FOCUS_CHANGED_EVENT } from "../../src/pi-todo/workflow-integration.ts";
import { registerWorkflowTodoProvider } from "./integrations/todo.ts";
import { registerSweSurface } from "./src/pi/register.ts";

export default function piSwe(pi: ExtensionAPI): void {
  const swe = registerSweSurface(pi, {
    onFocusChange: async (ctx: ExtensionContext) => {
      const pending: Promise<void>[] = [];
      pi.events?.emit(TODO_WORKFLOW_FOCUS_CHANGED_EVENT, {
        ctx,
        waitUntil(promise: Promise<void>) { pending.push(Promise.resolve(promise)); },
      });
      await Promise.all(pending);
    },
  });
  registerWorkflowTodoProvider(pi, swe);
}
