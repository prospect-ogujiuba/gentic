import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { renderUsage } from "../../../../src/command-guidance.ts";
import { registerSweActivityProbe } from "../../../../src/lifecycle-coordination.ts";
import { SweService } from "../app/service.ts";
import type { Initiative } from "../domain/initiative.ts";
import { getSweCommandCompletions, renderSweQuickHelp, SWE_COMMAND_ACTIONS } from "./autocomplete.ts";
import { refreshSweContextMessages, restoreSweFocus, SWE_CONTEXT_TYPE, SWE_FOCUS_ENTRY_TYPE } from "./context.ts";
import { buildSwePlanningPrompt, prepareSwePlanRequest } from "./planning.ts";
import { projectSweDocket, renderSweDocketLines } from "../ui/docket.ts";
import { SweDocketModal } from "../ui/modal.ts";
import { plainSweTheme } from "../ui/theme.ts";

const ACTIONS = ["create", "status", "next", "start", "implemented", "revise", "prepare_verification", "record_review", "complete", "pause", "resume"] as const;
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
  const service = (cwd: string) => { let value = services.get(cwd); if (!value) { value = new SweService(cwd); services.set(cwd, value); } return value; };
  const rememberFocus = (cwd: string, initiativeId: string) => {
    focused.set(cwd, initiativeId);
    pi.appendEntry(SWE_FOCUS_ENTRY_TYPE, { initiativeId });
  };
  registerSweActivityProbe((ctx) => service(ctx.cwd).hasActiveWork());

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
      "After every executable work item is complete or disposed, call swe complete without workId to finalize the initiative.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      try {
        const result = await executeAction(service(ctx.cwd), input, ctx.sessionManager.getSessionId(), signal);
        signal?.throwIfAborted();
        rememberFocus(ctx.cwd, input.initiativeId);
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerCommand("swe", {
    description: "Manage durable initiatives · /swe <action> <topic> [work-id]",
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
      if (!known || !initiativeId || extra.length || (requiresWork && !workId) || (!allowsWork && Boolean(workId))) {
        ctx.ui.notify(renderUsage(SWE_COMMAND_ACTIONS), "warning"); return;
      }
      try {
        const current = service(ctx.cwd);
        if (action === "open") { await openSweDocket(current.status(initiativeId).initiative, ctx); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "list") { ctx.ui.notify(renderDocket(current.status(initiativeId).initiative), "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "status") { ctx.ui.notify(renderStatus(current.status(initiativeId).initiative), "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "next") { const next = current.next(initiativeId); ctx.ui.notify(next ? `${next.id}: ${next.title}` : "No dependency-ready work.", "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        const stored = action === "pause" ? await current.pause(initiativeId)
          : action === "resume" ? await current.resume(initiativeId)
          : action === "start" ? await current.start(initiativeId, workId!)
          : action === "implemented" ? await current.markImplemented(initiativeId, workId!)
          : await current.complete(initiativeId, workId);
        ctx.ui.notify(renderStatus(stored.initiative), "info");
        rememberFocus(ctx.cwd, initiativeId);
        if (action === "start" || action === "resume") triggerContinuation(ctx.cwd, initiativeId);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
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
  const stored = input.action === "start" ? await service.start(input.initiativeId, workId())
    : input.action === "implemented" ? await service.markImplemented(input.initiativeId, workId())
    : input.action === "complete" ? await service.complete(input.initiativeId, input.workId?.trim() || undefined)
    : input.action === "pause" ? await service.pause(input.initiativeId)
    : await service.resume(input.initiativeId);
  return { text: renderStatus(stored.initiative), details: { initiative: stored.initiative, hash: stored.hash } };
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

function continuationInstruction(initiativeId: string): string {
  return `[SWE continuation: ${initiativeId}] Continue the active workflow from repository authority now. Treat its approved scope as standing authorization for routine reversible implementation, verification, corrective fixes, and cleanup; do not ask for confirmation between those steps. Preserve normal permission gates. Stop only for credentials, destructive or irreversible operations, a required contract/scope revision, a genuine blocker, or authorization not already granted by the user or repository policy. When all executable work is terminal, explicitly finalize the initiative.`;
}

function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
function requiredNumber(value: number | undefined, name: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${name} is required`); return value!; }
