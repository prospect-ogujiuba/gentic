import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { appendAudit } from "../app/audit.ts";
import { getConfig, getConfigPaths, loadConfig, type Config } from "../config/index.ts";
import { BUILTIN_PERMISSIONS, decideWithConfig, rulesFromPermissions, type Request } from "../domain/policy.ts";
import { getSessionDecision } from "../app/remember.ts";
import { promptPermission } from "../ui/prompt.ts";

const EXT = "pi-gate";

let stats = { allowed: 0, denied: 0, asked: 0 };

export function decide(req: Request) {
  return decideWithConfig(req, getConfig(), getSessionDecision(req.command));
}

export async function gate(ctx: ExtensionContext, req: Request): Promise<{ block: boolean; reason?: string }> {
  const d = decide(req);
  let action = d.action;
  if (action === "ask") {
    if (ctx.hasUI) stats.asked++;
    action = await promptPermission(ctx, req, d);
  }
  if (action === "allow") stats.allowed++; else stats.denied++;
  appendAudit(ctx, req, { ...d, action }, getConfig());
  ctx.ui.setStatus(EXT, `gate a:${stats.allowed} d:${stats.denied} ?:${stats.asked}`);
  return action === "deny" ? { block: true, reason: `pi-gate: ${d.reason}` } : { block: false };
}

export function registerPiGate(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => { loadConfig(ctx.cwd); ctx.ui.setStatus(EXT, `gate ${getConfig().enabled ? getConfig().mode : "off"}`); });
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const res = await gate(ctx, { source: "agent", command: event.input.command, cwd: ctx.cwd });
    if (res.block) return { block: true, reason: res.reason };
  });
  pi.on("user_bash", async (event, ctx) => {
    const res = await gate(ctx, { source: "user", command: event.command, cwd: event.cwd || ctx.cwd });
    if (res.block) return { result: { output: res.reason || "blocked by pi-gate", exitCode: 126, cancelled: false, truncated: false } };
  });
  pi.registerCommand("gate", { description: "Manage pi-gate bash permissions: status, reload, check <cmd>, mode <ask|strict|permissive|off>", handler: async (args, ctx) => {
    const [cmd, ...rest] = args.trim().split(/\s+/);
    if (cmd === "reload") { loadConfig(ctx.cwd); ctx.ui.notify(`pi-gate reloaded: ${rulesFromPermissions(getConfig().permissions).length} permission patterns`, "success"); return; }
    if (cmd === "mode") {
      const mode = rest[0];
      const config = getConfig();
      if (mode === "off") config.enabled = false;
      else if (["ask", "strict", "permissive"].includes(mode)) { config.enabled = true; config.mode = mode as Config["mode"] & string; }
      ctx.ui.setStatus(EXT, `gate ${config.enabled ? config.mode : "off"}`);
      return;
    }
    if (cmd === "check") { const command = args.replace(/^check\s+/, ""); ctx.ui.notify(JSON.stringify(decide({ source: "agent", command, cwd: ctx.cwd }), null, 2), "info"); return; }
    const config = getConfig();
    ctx.ui.notify(`pi-gate ${config.enabled ? config.mode : "off"}\npermission patterns: ${rulesFromPermissions(config.permissions).length} user + ${rulesFromPermissions(BUILTIN_PERMISSIONS).length} builtin\nconfig: ${getConfigPaths().join(", ")}\nstats: ${JSON.stringify(stats)}`, "info");
  }});
}
