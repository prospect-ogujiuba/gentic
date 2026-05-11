import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoState } from "../domain/types.ts";
import { todoSessionTitle } from "../app/query.ts";

let lastAutoSessionName: string | undefined;

export function syncTodoSessionName(pi: ExtensionAPI, ctx: ExtensionContext, state: TodoState): void {
  const title = todoSessionTitle(state);
  if (!title) return;

  const current = pi.getSessionName();
  if (current === title) {
    lastAutoSessionName = title;
  } else if (!current || current === lastAutoSessionName) {
    pi.setSessionName(title);
    lastAutoSessionName = title;
  }

  if (ctx.hasUI && typeof ctx.ui.setTitle === "function") {
    const cwdName = ctx.cwd.split(/[\\/]/).filter(Boolean).at(-1);
    ctx.ui.setTitle(`π - ${title}${cwdName ? ` - ${cwdName}` : ""}`);
  }
}

export function resetTodoSessionNameMemory(): void {
  lastAutoSessionName = undefined;
}
