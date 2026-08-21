import { isAbsolute, relative, resolve, sep } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ProjectTrustContext, type ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

import { appendAudit } from "../app/audit.ts";
import { clearSessionDecisions, getSessionDecision } from "../app/remember.ts";
import { getConfig, getConfigDiagnostics, getConfigPaths, loadConfig, type Config } from "../config/index.ts";
import { BUILTIN_PERMISSIONS, decideWithConfig, rulesFromPermissions, type Request } from "../domain/policy.ts";
import { cancelPendingGatePrompts, promptPermissionOutcome, type GatePromptOutcomeKind } from "../ui/prompt.ts";

const EXT = "pi-gate";
let stats = { allowed: 0, denied: 0, asked: 0 };

export function decide(req: Request) {
  return decideWithConfig(req, getConfig(), getSessionDecision(req.command));
}

export async function gate(ctx: ExtensionContext, req: Request): Promise<{ block: boolean; reason?: string }> {
  const d = decide(req);
  let action = d.action;
  let promptOutcome: GatePromptOutcomeKind | undefined;
  if (action === "ask") {
    stats.asked++;
    const result = await promptPermissionOutcome(ctx, req, d);
    action = result.action;
    promptOutcome = result.outcome;
  }
  if (action === "allow") stats.allowed++; else stats.denied++;
  appendAudit(ctx, req, { ...d, action }, getConfig());
  if (ctx.hasUI) ctx.ui.setStatus(EXT, `gate a:${stats.allowed} d:${stats.denied} ?:${stats.asked}`);
  return action === "deny" ? { block: true, reason: `pi-gate: ${d.reason}${promptOutcome ? ` (${promptOutcome})` : ""}` } : { block: false };
}

function protectedPath(tool: "read" | "edit" | "write", inputPath: string, cwd: string): string | undefined {
  const root = resolve(cwd);
  const target = resolve(cwd, inputPath.replace(/^@/, ""));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || (isAbsolute(rel) && rel !== "")) return "path outside project root";
  const normalized = rel.split(sep).join("/");
  return getConfig().protectedPaths[tool].find((entry) => {
    const candidate = entry.replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === candidate || normalized.startsWith(`${candidate}/`) || normalized.split("/").includes(candidate);
  });
}

async function projectTrust(event: { cwd: string }, ctx: ProjectTrustContext): Promise<ProjectTrustEventResult> {
  const policy = loadConfig(event.cwd, { includeProject: false }).projectTrust;
  if (policy === "allow") return { trusted: "yes" };
  if (policy === "deny") return { trusted: "no" };
  if (policy === "defer") return { trusted: "undecided" };
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return { trusted: "no" };
  try {
    const trusted = await ctx.ui.confirm("pi-gate project trust", `Trust project resources in ${event.cwd}?`, { timeout: 30_000 });
    return { trusted: trusted ? "yes" : "no" };
  } catch {
    return { trusted: "no" };
  }
}

export function registerPiGate(pi: ExtensionAPI): void {
  pi.on("project_trust", projectTrust);
  pi.on("session_start", (event, ctx) => {
    loadConfig(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? true });
    if (event.reason !== "reload") { stats = { allowed: 0, denied: 0, asked: 0 }; clearSessionDecisions(); }
    if (ctx.hasUI) ctx.ui.setStatus(EXT, `gate ${getConfig().enabled ? getConfig().mode : "off"}`);
    const errors = getConfigDiagnostics();
    if (ctx.hasUI && errors.length > 0) ctx.ui.notify(`pi-gate retained last-known-good policy:\n${errors.join("\n")}`, "error");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    cancelPendingGatePrompts();
    if (ctx.hasUI) ctx.ui.setStatus(EXT, undefined);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const res = await gate(ctx, { source: "agent", command: event.input.command, cwd: ctx.cwd });
      if (res.block) return { block: true, reason: res.reason };
      return;
    }
    if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: unknown }).path;
      if (typeof path !== "string") return { block: true, reason: `pi-gate: ${event.toolName} path is missing` };
      const match = protectedPath(event.toolName, path, ctx.cwd);
      if (match) return { block: true, reason: `pi-gate: protected ${event.toolName} path '${path}' (${match})` };
    }
  });
  pi.on("user_bash", async (event, ctx) => {
    const res = await gate(ctx, { source: "user", command: event.command, cwd: event.cwd || ctx.cwd });
    if (res.block) return { result: { output: res.reason || "blocked by pi-gate", exitCode: 126, cancelled: false, truncated: false } };
  });
  pi.registerCommand("gate", {
    description: "Manage pi-gate permissions: status, reload, check <cmd>, mode <ask|strict|permissive|off>",
    getArgumentCompletions: (prefix) => ["status", "reload", "check ", "mode ask", "mode strict", "mode permissive", "mode off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [cmd = "status", ...rest] = args.trim().split(/\s+/);
      if (cmd === "reload") {
        loadConfig(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? true });
        const errors = getConfigDiagnostics();
        ctx.ui.notify(errors.length ? `pi-gate reload rejected; retained last-known-good policy:\n${errors.join("\n")}` : `pi-gate reloaded: ${rulesFromPermissions(getConfig().permissions).length} glob patterns`, errors.length ? "error" : "info");
        return;
      }
      if (cmd === "mode") {
        const mode = rest[0];
        const config = getConfig();
        if (mode === "off") config.enabled = false;
        else if (["ask", "strict", "permissive"].includes(mode)) { config.enabled = true; config.mode = mode as Config["mode"] & string; }
        else { ctx.ui.notify("Invalid gate mode. Use ask, strict, permissive, or off. Runtime mode changes last until reload.", "error"); return; }
        ctx.ui.setStatus(EXT, `gate ${config.enabled ? config.mode : "off"}`);
        ctx.ui.notify("pi-gate runtime mode updated; reload restores configured mode", "info");
        return;
      }
      if (cmd === "check") {
        const command = args.replace(/^check\s+/, "");
        if (!command) { ctx.ui.notify("Usage: /gate check <command>", "error"); return; }
        ctx.ui.notify(JSON.stringify(decide({ source: "agent", command, cwd: ctx.cwd }), null, 2), "info");
        return;
      }
      if (cmd !== "status") { ctx.ui.notify("Unknown /gate command", "error"); return; }
      const config = getConfig();
      ctx.ui.notify(`pi-gate ${config.enabled ? config.mode : "off"}\nglob patterns: ${rulesFromPermissions(config.permissions).length} user + ${rulesFromPermissions(BUILTIN_PERMISSIONS).length} builtin\nexact remembered rules: ${rulesFromPermissions(config.literalPermissions).length}\nconfig: ${getConfigPaths().join(", ")}\nstats: ${JSON.stringify(stats)}`, "info");
    },
  });
}
