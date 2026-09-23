import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { registerSweActivityProbe } from "../../../../src/lifecycle-coordination.ts";
import { SweService } from "../app/service.ts";
import { initiativePath } from "../app/store.ts";
import type { Initiative } from "../domain/initiative.ts";
import { getSweCommandCompletions, renderSweQuickHelp } from "./autocomplete.ts";
import { refreshSweContextMessages, restoreSweFocus, SWE_CONTEXT_TYPE, SWE_FOCUS_ENTRY_TYPE } from "./context.ts";
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

const COMMAND_ACTIONS = new Set(["plan", "open", "list", "status", "next", "start", "implemented", "complete", "resume", "pause"]);
const WORK_COMMANDS = new Set(["start", "implemented", "complete"]);

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

  pi.on("session_start", (_event, ctx) => {
    completionCwd = ctx.cwd;
    const initiativeId = restoreSweFocus(ctx.sessionManager.getEntries());
    if (initiativeId) focused.set(ctx.cwd, initiativeId);
    else focused.delete(ctx.cwd);
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
    description: "Create, inspect, and mutate one durable SWE initiative. Verification preparation must be followed by the exact ordinary bash tool call so installed shell permissions apply.",
    promptSnippet: "Use swe create as the sole workflow.json bootstrap path, then use swe for durable status, legal work transitions, verification preparation, review, and evidence-gated completion.",
    promptGuidelines: [
      "Use swe create with a complete schema-valid draft proposal to bootstrap workflow.json; /swe plan only reports the canonical path and does not create authority.",
      "Use swe prepare_verification before running the exact command through Pi's ordinary bash tool; never substitute internal pi.exec.",
      "Use swe record_review only for an explicit model self-review; label it as self-review, not independent or human review.",
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
      const [action, initiativeId, workId, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      const known = COMMAND_ACTIONS.has(action);
      const needsWork = WORK_COMMANDS.has(action);
      if (!known || !initiativeId || extra.length || needsWork !== Boolean(workId)) {
        ctx.ui.notify("Usage: /swe [plan|open|list|status|next|resume|pause] <topic> or /swe [start|implemented|complete] <topic> <work-id>", "warning"); return;
      }
      try {
        const current = service(ctx.cwd);
        if (action === "plan") {
          initiativePath(ctx.cwd, initiativeId);
          ctx.ui.notify(`No authority was created. Prepare a complete schema-valid draft proposal for .model-artifacts/initiatives/${initiativeId}/workflow.json, then invoke the swe tool with action=create, initiativeId=${initiativeId}, and proposal.`, "info");
          return;
        }
        if (action === "open") { await openSweDocket(current.status(initiativeId).initiative, ctx); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "list") { ctx.ui.notify(renderDocket(current.status(initiativeId).initiative), "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "status") { ctx.ui.notify(renderStatus(current.status(initiativeId).initiative), "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        if (action === "next") { const next = current.next(initiativeId); ctx.ui.notify(next ? `${next.id}: ${next.title}` : "No dependency-ready work.", "info"); rememberFocus(ctx.cwd, initiativeId); return; }
        const stored = action === "pause" ? await current.pause(initiativeId)
          : action === "resume" ? await current.resume(initiativeId)
          : action === "start" ? await current.start(initiativeId, workId!)
          : action === "implemented" ? await current.markImplemented(initiativeId, workId!)
          : await current.complete(initiativeId, workId!);
        ctx.ui.notify(renderStatus(stored.initiative), "info");
        rememberFocus(ctx.cwd, initiativeId);
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
    : input.action === "complete" ? await service.complete(input.initiativeId, workId())
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

function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
function requiredNumber(value: number | undefined, name: string): number { if (!Number.isSafeInteger(value)) throw new Error(`${name} is required`); return value!; }
