import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoEvent } from "../domain/types.ts";
import type { TodoEventStore } from "../app/service.ts";

const CUSTOM_TYPE = "gentic.todo.event";

export class PiTodoEventStore implements TodoEventStore {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
    this.pi = pi;
    this.ctx = ctx;
  }

  async read(): Promise<TodoEvent[]> {
    return this.ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE)
      .map((entry) => entry.data as TodoEvent);
  }

  async append(event: TodoEvent): Promise<void> {
    this.pi.appendEntry(CUSTOM_TYPE, event);
  }
}
