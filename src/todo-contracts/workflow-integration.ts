import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TodoBackend } from "./provider.ts";

/** Native Pi event channels used by the optional pi-swe projection adapter. */
export const TODO_WORKFLOW_PROVIDER_REQUEST_EVENT = "gentic:todo:workflow-provider-request";
export const TODO_WORKFLOW_PROVIDER_AVAILABLE_EVENT = "gentic:todo:workflow-provider-available";
export const TODO_WORKFLOW_FOCUS_CHANGED_EVENT = "gentic:todo:workflow-focus-changed";

/** Public, provider-neutral bridge. Todo never imports a workflow implementation. */
export interface TodoWorkflowProvider {
  resolve(ctx: ExtensionContext): TodoBackend | undefined | Promise<TodoBackend | undefined>;
}

export type TodoWorkflowFocusChanged = {
  ctx: ExtensionContext;
  /** Lets the publisher preserve mutation/result ordering while the bus stays synchronous. */
  waitUntil(promise: Promise<void>): void;
};

export function isTodoWorkflowProvider(value: unknown): value is TodoWorkflowProvider {
  return typeof value === "object" && value !== null && typeof (value as TodoWorkflowProvider).resolve === "function";
}

export function asTodoWorkflowFocusChanged(value: unknown): TodoWorkflowFocusChanged | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Partial<TodoWorkflowFocusChanged>;
  return event.ctx && typeof event.ctx === "object" && typeof event.ctx.cwd === "string" && typeof event.waitUntil === "function"
    ? event as TodoWorkflowFocusChanged
    : undefined;
}
