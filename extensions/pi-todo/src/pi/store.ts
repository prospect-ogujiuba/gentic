import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoEvent } from "../domain/types.ts";
import type { TodoEventStore } from "../app/service.ts";

export const PI_TODO_EVENT_CUSTOM_TYPE = "gentic.todo.event";
export const PI_TODO_EVENT_VERSION = 1 as const;

export type PiTodoEventEnvelope = {
  version: typeof PI_TODO_EVENT_VERSION;
  event: TodoEvent;
};

export function decodeTodoEvent(data: unknown): TodoEvent | undefined {
  if (isTodoEvent(data)) return data; // Legacy pre-envelope sessions.
  if (!isRecord(data) || data.version !== PI_TODO_EVENT_VERSION || !isTodoEvent(data.event)) return undefined;
  return data.event;
}

export class PiTodoEventStore implements TodoEventStore {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
    this.pi = pi;
    this.ctx = ctx;
  }

  async read(): Promise<TodoEvent[]> {
    return this.ctx.sessionManager
      .getBranch()
      .flatMap((entry) => {
        if (entry.type !== "custom" || entry.customType !== PI_TODO_EVENT_CUSTOM_TYPE) return [];
        const event = decodeTodoEvent(entry.data);
        return event ? [event] : [];
      });
  }

  async append(event: TodoEvent): Promise<void> {
    const envelope: PiTodoEventEnvelope = { version: PI_TODO_EVENT_VERSION, event };
    this.pi.appendEntry(PI_TODO_EVENT_CUSTOM_TYPE, envelope);
  }
}

function isTodoEvent(value: unknown): value is TodoEvent {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.type === "string" && value.type.startsWith("todo.") && typeof value.at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
