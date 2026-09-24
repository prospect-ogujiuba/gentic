import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { renderUsage } from "../../../../src/command-guidance.ts";
import { SweService, type CompletionResult } from "../app/service.ts";
import type { PreparedCompletionCommit } from "../app/completion-commit.ts";
import type { Initiative } from "../domain/initiative.ts";
import { getSweCommandCompletions, renderSweInitiativeList, renderSweQuickHelp, SWE_COMMAND_ACTIONS } from "./autocomplete.ts";
import { refreshSweContextMessages, restoreSweFocus, SWE_CONTEXT_TYPE, SWE_FOCUS_ENTRY_TYPE } from "./context.ts";
import { buildSwePlanningPrompt, prepareSwePlanRequest } from "./planning.ts";
import { projectSweDocket, renderSweDocketLines } from "../ui/docket.ts";
import { SweDocketModal } from "../ui/modal.ts";
import { plainSweTheme } from "../ui/theme.ts";
import { registerLightweightTodoSurface } from "../todo/thin-surface.ts";
import { WorkflowTodoBackend } from "../todo/workflow-backend.ts";

const ACTIONS = ["create", "status", "next", "start", "implemented", "revise", "prepare_verification", "prepare_independent_review", "record_review", "complete", "pause", "resume"] as const;
const parameters = Type.Object({
  action: StringEnum(ACTIONS),
  initiativeId: Type.String({ maxLength: 128 }),
  workId: Type.Optional(Type.String({ maxLength: 128 })),
  obligationIds: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 100 })),
  command: Type.Optional(Type.String({ maxLength: 8_192 })),
  relevantPaths: Type.Optional(Type.Array(Type.String({ maxLength: 1_024 }), { maxItems: 256 })),
  outcome: Type.Optional(StringEnum(["passed", "failed"] as const)),
  dimensions: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 })),
  summary: Type.Optional(Type.String({ maxLength: 8_192 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedHash: Type.Optional(Type.String({ maxLength: 71 })),
  reason: Type.Optional(Type.String({ maxLength: 2_048 })),
  proposal: Type.Optional(Type.Unknown()),
});

const COMMAND_ACTIONS = new Set<string>(SWE_COMMAND_ACTIONS.map((item) => item.action));
const REQUIRED_WORK_COMMANDS = new Set(["start", "implemented"]);
const OPTIONAL_WORK_COMMANDS = new Set(["complete"]);

export { getSweCommandCompletions } from "./autocomplete.ts";

export function registerSweSurface(pi: ExtensionAPI): void {
  const services = new Map<string, SweService>();
  const focused = new Map<string, string>();
  let completionCwd = process.cwd();
  let refreshTodoSurface: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  const service = (cwd: string) => { let value = services.get(cwd); if (!value) { value = new SweService(cwd); services.set(cwd, value); } return value; };
  const rememberFocus = async (ctx: ExtensionContext, initiativeId: string): Promise<void> => {
    focused.set(ctx.cwd, initiativeId);
    pi.appendEntry(SWE_FOCUS_ENTRY_TYPE, { initiativeId });
    try {
      await refreshTodoSurface?.(ctx);
    } catch {
      // Presentation refresh must never turn a successful durable SWE mutation
      // into an apparent failure; todo execution still resolves authority afresh.
      try { ctx.ui.notify("Todo presentation refresh failed; use todo list to retry.", "warning"); }
      catch { /* UI failure is non-authoritative. */ }
    }
  };
  const triggerContinuation = (cwd: string, initiativeId: string) => {
    const initiative = service(cwd).status(initiativeId).initiative;
    const unfinished = initiative.work.some((item) => item.kind !== "phase" && item.status !== "complete" && !item.disposition);
    if (initiative.status !== "active" || !unfinished) return;
    pi.sendMessage({
      customType: SWE_CONTEXT_TYPE,
      content: continuationInstruction(initiativeId),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  };
  pi.on("session_start", (_event, ctx) => {
    completionCwd = ctx.cwd;
    const initiativeId = restoreSweFocus(ctx.sessionManager.getEntries());
    if (!initiativeId) { focused.delete(ctx.cwd); return; }
    focused.set(ctx.cwd, initiativeId);
    triggerContinuation(ctx.cwd, initiativeId);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const initiativeId = focused.get(ctx.cwd);
    if (!initiativeId) return;
    const content = service(ctx.cwd).contextProjection(initiativeId);
    return { message: { customType: SWE_CONTEXT_TYPE, content, display: false } };
  });
  pi.on("context", (event, ctx) => {
    const initiativeId = focused.get(ctx.cwd);
    if (!initiativeId) return;
    return { messages: refreshSweContextMessages(event.messages, service(ctx.cwd).contextProjection(initiativeId)) };
  });
  pi.on("tool_call", (event, ctx) => { service(ctx.cwd).observeToolCall(event, ctx.cwd); });
  pi.on("tool_result", async (event, ctx) => { await service(ctx.cwd).observeToolResult(event); });

  pi.registerTool({
    name: "swe",
    label: "SWE",
    description: "Create, inspect, and mutate one durable SWE initiative. Complete without workId finalizes an all-terminal initiative. Verification preparation must be followed by the exact ordinary bash tool call so installed shell permissions apply.",
    promptSnippet: "Use swe create as the sole workflow.json bootstrap path, then use swe for durable status, legal work transitions, verification preparation, review, and evidence-gated completion.",
    promptGuidelines: [
      "Use swe create with a complete schema-valid draft proposal to bootstrap workflow.json; /swe plan turns a natural-language request into an agent planning turn and still bootstraps authority only through swe create.",
      "An active focused initiative is standing authorization to continue its workflow through routine reversible implementation, verification, fixes, and cleanup without asking for confirmation between steps.",
      "Stop for credentials, destructive or irreversible operations, a contract/scope revision, a genuine blocker, or authorization not already granted by the user or repository policy.",
      "Use swe prepare_verification before running the exact command through Pi's ordinary bash tool; never substitute internal pi.exec.",
      "Use swe record_review only for an explicit model self-review; label it as self-review, not independent or human review.",
      "Every new initiative requires passing independent-review evidence before its designated work can complete. Use swe prepare_independent_review, launch another Pi session through interactive_shell with the returned token instruction, wait for it to exit, then query that session so pi-swe can observe its completed token-bearing output. A launch acknowledgement is not review evidence.",
      "When successful work-item completion returns an opt-in completionCommit, invoke its exact command through Pi's ordinary bash tool, report any failure without reverting completion, and never claim a commit before that command succeeds.",
      "After every executable work item is complete or disposed, call swe complete without workId to finalize the initiative.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      try {
        const result = await executeAction(service(ctx.cwd), input, ctx.sessionManager.getSessionId(), signal);
        signal?.throwIfAborted();
        await rememberFocus(ctx, input.initiativeId);
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerCommand("swe", {
    description: "Manage durable initiatives · /swe list [topic] · /swe <action> <topic> [work-id]",
    getArgumentCompletions: (prefix) => getSweCommandCompletions(prefix, {
      cwd: completionCwd,
      focusedInitiativeId: focused.get(completionCwd),
    }),
    handler: async (args, ctx) => {
      completionCwd = ctx.cwd;
      if (!args.trim()) {
        const initiativeId = focused.get(ctx.cwd);
        let initiative: Initiative | undefined;
        if (initiativeId) {
          try { initiative = service(ctx.cwd).status(initiativeId).initiative; }
          catch { focused.delete(ctx.cwd); }
        }
        ctx.ui.notify(renderSweQuickHelp(initiative), "info");
        return;
      }
      const actionMatch = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (actionMatch?.[1] === "plan") {
        try {
          const plan = prepareSwePlanRequest(ctx.cwd, actionMatch[2] ?? "");
          ctx.ui.notify(`Planning ${plan.initiativeId} from your request.`, "info");
          pi.sendUserMessage(buildSwePlanningPrompt(plan));
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const [action, initiativeId, workId, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      const known = COMMAND_ACTIONS.has(action);
      const requiresWork = REQUIRED_WORK_COMMANDS.has(action);
      const allowsWork = requiresWork || OPTIONAL_WORK_COMMANDS.has(action);
      const allowsMissingInitiative = action === "list";
      if (!known || (!initiativeId && !allowsMissingInitiative) || extra.length || (requiresWork && !workId) || (!allowsWork && Boolean(workId))) {
        ctx.ui.notify(renderUsage(SWE_COMMAND_ACTIONS), "warning"); return;
      }
      try {
        const current = service(ctx.cwd);
        if (action === "open") { await openSweDocket(current.status(initiativeId).initiative, ctx); await rememberFocus(ctx, initiativeId); return; }
        if (action === "list") {
          if (!initiativeId) { ctx.ui.notify(renderSweInitiativeList(ctx.cwd, focused.get(ctx.cwd)), "info"); return; }
          ctx.ui.notify(renderDocket(current.status(initiativeId).initiative), "info"); await rememberFocus(ctx, initiativeId); return;
        }
        if (action === "status") { ctx.ui.notify(renderStatus(current.status(initiativeId).initiative), "info"); await rememberFocus(ctx, initiativeId); return; }
        if (action === "next") { const next = current.next(initiativeId); ctx.ui.notify(next ? `${next.id}: ${next.title}` : "No dependency-ready work.", "info"); await rememberFocus(ctx, initiativeId); return; }
        const stored = action === "pause" ? await current.pause(initiativeId)
          : action === "resume" ? await current.resume(initiativeId)
          : action === "start" ? await current.start(initiativeId, workId!)
          : action === "implemented" ? await current.markImplemented(initiativeId, workId!)
          : await current.complete(initiativeId, workId);
        const completionResult = action === "complete" && workId ? stored as CompletionResult : undefined;
        const completionCommit = completionResult?.completionCommit;
        const commitMessage = completionCommit ? renderCommitInstruction(completionCommit) : completionResult?.completionCommitError;
        ctx.ui.notify(`${renderStatus(stored.initiative)}${commitMessage ? `\n${commitMessage}` : ""}`, completionResult?.completionCommitError ? "warning" : "info");
        await rememberFocus(ctx, initiativeId);
        if (completionCommit) {
          pi.sendMessage({ customType: "gentic.swe.completion-commit", content: renderCommitInstruction(completionCommit), display: false }, { triggerTurn: true, deliverAs: "followUp" });
        }
        if (action === "start" || action === "resume") triggerContinuation(ctx.cwd, initiativeId);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  refreshTodoSurface = registerLightweightTodoSurface(pi, {
    resolveWorkflowBackend: (ctx) => {
      const initiativeId = focused.get(ctx.cwd);
      if (!initiativeId) return undefined;
      const current = service(ctx.cwd);
      if (current.status(initiativeId).initiative.status !== "active") return undefined;
      return new WorkflowTodoBackend(current, initiativeId);
    },
  }).refresh;
}

async function executeAction(service: SweService, input: {
  action: typeof ACTIONS[number]; initiativeId: string; workId?: string; obligationIds?: string[]; command?: string; relevantPaths?: string[];
  outcome?: "passed" | "failed"; dimensions?: string[]; summary?: string;
  expectedRevision?: number; expectedHash?: string; reason?: string; proposal?: unknown;
}, sessionId: string, signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
  const workId = () => required(input.workId, "workId");
  if (input.action === "create") {
    const stored = await service.create(input.initiativeId, input.proposal, signal);
    return { text: `Created ${stored.path}\n${renderStatus(stored.initiative)}`, details: { initiative: stored.initiative, hash: stored.hash, path: stored.path } };
  }
  if (input.action === "status") { const stored = service.status(input.initiativeId); return { text: renderStatus(stored.initiative), details: { initiative: stored.initiative, hash: stored.hash } }; }
  if (input.action === "next") { const next = service.next(input.initiativeId); return { text: next ? `${next.id}: ${next.title}` : "No dependency-ready work.", details: { work: next } }; }
  if (input.action === "revise") {
    const stored = await service.revise(input.initiativeId, {
      expectedRevision: requiredNumber(input.expectedRevision, "expectedRevision"),
      expectedHash: required(input.expectedHash, "expectedHash"),
      reason: required(input.reason, "reason"),
      proposal: input.proposal,
    });
    return { text: renderStatus(stored.initiative), details: { initiative: stored.initiative, hash: stored.hash } };
  }
  if (input.action === "prepare_verification") {
    const prepared = service.prepareVerification(input.initiativeId, { workId: workId(), obligationIds: input.obligationIds ?? [], command: required(input.command, "command"), relevantPaths: input.relevantPaths ?? [] });
    return { text: `Prepared verification ${prepared.token}. Invoke the ordinary bash tool with exactly: ${prepared.command}`, details: { prepared } };
  }
  if (input.action === "record_review") {
    const stored = await service.recordReview(input.initiativeId, {
      workId: workId(), obligationIds: input.obligationIds ?? [], outcome: input.outcome ?? "failed",
      relevantPaths: input.relevantPaths ?? [], dimensions: input.dimensions ?? [], summary: required(input.summary, "summary"), sessionId,
    });
    return { text: renderStatus(stored.initiative), details: { initiative: stored.initiative, hash: stored.hash } };
  }
  if (input.action === "prepare_independent_review") {
    const prepared = service.prepareIndependentReview(input.initiativeId, {
      workId: workId(), obligationIds: input.obligationIds ?? [], relevantPaths: input.relevantPaths ?? [],
      dimensions: input.dimensions ?? [], summary: required(input.summary, "summary"), recorderSessionId: sessionId,
    });
    return { text: `Prepared independent review ${prepared.token}. ${prepared.instruction}`, details: { prepared } };
  }
  const stored = input.action === "start" ? await service.start(input.initiativeId, workId())
    : input.action === "implemented" ? await service.markImplemented(input.initiativeId, workId())
    : input.action === "complete" ? await service.complete(input.initiativeId, input.workId?.trim() || undefined)
    : input.action === "pause" ? await service.pause(input.initiativeId)
    : await service.resume(input.initiativeId);
  const completionResult = input.action === "complete" && input.workId?.trim() ? stored as CompletionResult : undefined;
  const completionCommit = completionResult?.completionCommit;
  const commitMessage = completionCommit ? renderCommitInstruction(completionCommit) : completionResult?.completionCommitError;
  return {
    text: `${renderStatus(stored.initiative)}${commitMessage ? `\n${commitMessage}` : ""}`,
    details: {
      initiative: stored.initiative,
      hash: stored.hash,
      ...(completionCommit ? { completionCommit } : {}),
      ...(completionResult?.completionCommitError ? { completionCommitError: completionResult.completionCommitError } : {}),
    },
  };
}

function renderStatus(initiative: Initiative): string {
  const active = initiative.work.filter((item) => item.kind !== "phase" && item.status !== "complete").slice(0, 8);
  return `${initiative.id} · ${initiative.status} · revision ${initiative.revision}${active.length ? `\n${active.map((item) => `${item.id} [${item.status}] ${item.title}`).join("\n")}` : "\nAll work complete."}`;
}

function renderDocket(initiative: Initiative): string {
  return renderSweDocketLines(projectSweDocket(initiative), plainSweTheme, { width: 92, includeDone: true, limit: 100 }).join("\n") || "No work.";
}

async function openSweDocket(initiative: Initiative, ctx: ExtensionCommandContext): Promise<void> {
  const docket = projectSweDocket(initiative);
  if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify(renderDocket(initiative), "info"); return; }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SweDocketModal({
    docket,
    theme,
    requestRender: () => tui.requestRender(),
    close: () => done(undefined),
    terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40,
  }), { overlay: true, overlayOptions: { width: "80%", minWidth: 44, maxHeight: "85%", anchor: "center", margin: 1 } });
}

function renderCommitInstruction(commit: PreparedCompletionCommit): string {
  return `Opt-in work-item commit prepared for ${commit.workId}. Invoke Pi's ordinary bash tool with exactly the completionCommit command. The work item remains complete if it fails; report the failure and recovery state without claiming a commit.\n${commit.command}`;
}

function continuationInstruction(initiativeId: string): string {
  return `[SWE continuation: ${initiativeId}] Continue the active workflow from repository authority now. Treat its approved scope as standing authorization for routine reversible implementation, verification, corrective fixes, and cleanup; do not ask for confirmation between those steps. Preserve normal permission gates. Stop only for credentials, destructive or irreversible operations, a required contract/scope revision, a genuine blocker, or authorization not already granted by the user or repository policy. When all executable work is terminal, explicitly finalize the initiative.`;
}

function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
function requiredNumber(value: number | undefined, name: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${name} is required`); return value!; }
