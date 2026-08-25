import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Action, Decision, PermissionChoice, Request } from "../domain/policy.ts";
import { normalizeCommand } from "../domain/policy.ts";
import { persistGlobalRule, persistProjectRule, rememberSessionDecision } from "../app/remember.ts";

export type GatePromptOutcomeKind = "allow" | "deny" | "cancel" | "timeout" | "unavailable" | "error";

export interface GatePromptOutcome {
  action: Action;
  outcome: GatePromptOutcomeKind;
  remember: PermissionChoice["remember"];
  error?: string;
}

export interface GatePromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
const activePromptControllers = new Set<AbortController>();
const CHOICES: readonly PermissionChoice[] = [
  { label: "allow once", action: "allow", remember: false },
  { label: "allow and remember for this session", action: "allow", remember: "session" },
  { label: "allow and remember globally", action: "allow", remember: "global" },
  { label: "allow and remember for this project", action: "allow", remember: "project" },
  { label: "deny", action: "deny", remember: false },
];

export function cancelPendingGatePrompts(): void {
  for (const controller of activePromptControllers) controller.abort(new Error("pi-gate session ended"));
  activePromptControllers.clear();
}

function safeOutcome(outcome: GatePromptOutcomeKind, error?: unknown): GatePromptOutcome {
  return {
    action: "deny",
    outcome,
    remember: false,
    error: error === undefined ? undefined : "prompt operation failed",
  };
}

export async function promptPermissionOutcome(
  ctx: ExtensionContext,
  req: Request,
  d: Decision,
  options: GatePromptOptions = {},
): Promise<GatePromptOutcome> {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return safeOutcome("unavailable");
  if (options.signal?.aborted) return safeOutcome("cancel");

  const controller = new AbortController();
  activePromptControllers.add(controller);
  let timedOut = false;
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("pi-gate prompt timed out"));
  }, timeoutMs);
  timer.unref?.();

  try {
    const labels = CHOICES.map((choice) => choice.label);
    const selected = await ctx.ui.select(`pi-gate: ${d.reason}\n${req.command}`, labels, { signal: controller.signal, timeout: timeoutMs });
    if (selected === undefined) return safeOutcome(timedOut ? "timeout" : "cancel");
    const choice = CHOICES[labels.indexOf(selected)];
    if (!choice) return safeOutcome("error", "pi-gate returned an unknown prompt choice");

    const action: "allow" | "deny" = choice.action === "allow" ? "allow" : "deny";
    if (choice.remember === "session") rememberSessionDecision(normalizeCommand(req.command), action);
    if (choice.remember === "global") persistGlobalRule(ctx, req.command, action);
    if (choice.remember === "project") persistProjectRule(ctx, req.command, action);
    return { action, outcome: action, remember: choice.remember };
  } catch (error) {
    if (timedOut) return safeOutcome("timeout");
    if (options.signal?.aborted || controller.signal.aborted) return safeOutcome("cancel");
    return safeOutcome("error", error);
  } finally {
    clearTimeout(timer);
    activePromptControllers.delete(controller);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function promptPermission(ctx: ExtensionContext, req: Request, d: Decision, options?: GatePromptOptions): Promise<Action> {
  return (await promptPermissionOutcome(ctx, req, d, options)).action;
}
