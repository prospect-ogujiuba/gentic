import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  registerLightweightTodoSurface,
  type TodoSurfaceController,
} from "../public.ts";
import {
  TODO_WORKFLOW_FOCUS_CHANGED_EVENT,
  TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT,
  TODO_WORKFLOW_PROVIDER_REQUEST_EVENT,
  asTodoWorkflowFocusChanged,
  isTodoWorkflowProvider,
  type TodoWorkflowProvider,
} from "../../../../src/todo-contracts/workflow-integration.ts";

/** Independently discovered Todo runtime with an optional Pi-event workflow projection. */
export function registerTodo(pi: ExtensionAPI): void {
  let workflowProvider: TodoWorkflowProvider | undefined;
  let surface: TodoSurfaceController | undefined;

  pi.events?.on(TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT, (value) => {
    if (isTodoWorkflowProvider(value)) workflowProvider = value;
  });
  pi.events?.on(TODO_WORKFLOW_FOCUS_CHANGED_EVENT, (value) => {
    const event = asTodoWorkflowFocusChanged(value);
    if (!event || !surface) return;
    event.waitUntil(refreshAfterFocusChange(surface, event.ctx));
  });

  surface = registerLightweightTodoSurface(pi, {
    resolveWorkflowBackend: (ctx) => workflowProvider?.resolve(ctx),
  });

  // The request plus provider announcement handshake works in either load order:
  // an existing provider answers this request, while a later provider announces itself.
  pi.events?.emit(TODO_WORKFLOW_PROVIDER_REQUEST_EVENT, undefined);
}

async function refreshAfterFocusChange(surface: TodoSurfaceController, ctx: ExtensionContext): Promise<void> {
  try {
    await surface.refresh(ctx);
  } catch {
    try { ctx.ui.notify("Todo presentation refresh failed; use todo list to retry.", "warning"); }
    catch { /* Presentation failure is non-authoritative. */ }
  }
}
