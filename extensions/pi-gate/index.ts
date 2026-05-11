import { DynamicBorder, isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Action = "allow" | "deny" | "ask";
type Source = "agent" | "user";
type Remember = false | "session" | "project";
type PermissionChoice = { k: string; label: string; action: Action; remember: Remember };
type Permissions = Partial<Record<Action, string[]>>;
type Rule = { id: string; pattern: string; action: Action; reason?: string; timeoutSeconds?: number; defaultOnTimeout?: Action };
type Config = {
  $schema?: string;
  version?: number;
  enabled?: boolean;
  mode?: "strict" | "ask" | "permissive";
  defaultAction?: Action;
  audit?: { enabled?: boolean; path?: string };
  permissions?: Permissions;
};
type Request = { source: Source; command: string; cwd: string };
type Decision = { action: Action; ruleId: string; reason: string; timeoutSeconds?: number; defaultOnTimeout?: Action };

const EXT = "pi-gate";
const SCHEMA_URL = new URL("./pi-gate.schema.json", import.meta.url).href;
const MIN_PROMPT_LINES = 12;
const PROMPT_SCREEN_RATIO = 0.78;
const MIN_COMMAND_LINES = 3;
const MAX_COMMAND_LINES = 10;
const BUILTIN_PERMISSIONS: Permissions = {
  deny: ["rm * -rf /", "rm * -rf ~", "rm * -rf $HOME"],
  ask: ["sudo *", "doas *", "curl * | sh", "curl * | bash", "curl * | zsh", "wget * | sh", "wget * | bash", "wget * | zsh", "rm *", "chmod -R *", "chown -R *", "mkfs *", "dd *"],
  allow: ["ls*", "pwd", "rg*", "grep*", "git status*", "git diff*", "git log*", "git branch*", "git remote*", "git rev-parse*"],
};

type LoadedConfig = Required<Omit<Config, "$schema">> & Pick<Config, "$schema">;

let config: LoadedConfig = defaultConfig();
let configPaths: string[] = [];
const sessionMemory = new Map<string, Action>();
let stats = { allowed: 0, denied: 0, asked: 0 };

function defaultConfig(): LoadedConfig {
  return { version: 2, enabled: true, mode: "ask", defaultAction: "ask", audit: { enabled: true, path: ".pi/pi-gate-audit.jsonl" }, permissions: {} };
}
function readJson(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
}
export function loadConfig(cwd: string): void {
  configPaths = [process.env.PI_GATE_CONFIG, join(process.env.HOME || "", ".pi/agent/pi-gate.json"), join(cwd, ".pi/pi-gate.json")].filter(Boolean) as string[];
  config = defaultConfig();
  for (const p of configPaths) {
    const raw = readJson(p);
    if (!raw) continue;
    config = { ...config, ...raw, audit: { ...config.audit, ...raw.audit }, permissions: mergePermissions(config.permissions, raw.permissions || {}) };
  }
}
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${escapeRegex(pattern.trim()).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
}
function hit(rule: Rule, req: Request): boolean {
  return patternRegex(rule.pattern).test(normalizeCommand(req.command));
}
function firstHit(rules: Rule[], req: Request, action: Action): Rule | undefined {
  return rules.find((rule) => rule.action === action && hit(rule, req));
}
function mergePermissions(...items: Permissions[]): Permissions {
  return {
    deny: items.flatMap((item) => item.deny || []),
    ask: items.flatMap((item) => item.ask || []),
    allow: items.flatMap((item) => item.allow || []),
  };
}
function rulesFromPermissions(permissions: Permissions, prefix = "config"): Rule[] {
  const rules: Rule[] = [];
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const pattern of permissions[action] || []) rules.push({ id: `${prefix}:${action}:${pattern}`, pattern, action, reason: `${action} permission` });
  }
  return rules;
}
function projectConfigPath(ctx: ExtensionContext): string {
  return join(ctx.cwd, ".pi/pi-gate.json");
}
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
function persistRule(ctx: ExtensionContext, path: string, pattern: string, action: Action): void {
  const existing = readJson(path) || {};
  const permissions = existing.permissions || {};
  const current = permissions[action] || [];
  const next = {
    $schema: existing.$schema || SCHEMA_URL,
    version: existing.version || 2,
    enabled: existing.enabled ?? true,
    mode: existing.mode || "ask",
    defaultAction: existing.defaultAction || "ask",
    audit: {
      enabled: existing.audit?.enabled ?? true,
      path: existing.audit?.path || ".pi/pi-gate-audit.jsonl",
    },
    permissions: {
      allow: permissions.allow || [],
      ask: permissions.ask || [],
      deny: permissions.deny || [],
      [action]: current.includes(pattern) ? current : [...current, pattern],
    },
  } satisfies Config;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  loadConfig(ctx.cwd);
  ctx.ui.notify(`pi-gate saved ${action} rule to ${path}`, "success");
}
export function decide(req: Request): Decision {
  if (!config.enabled) return { action: "allow", ruleId: "disabled", reason: "pi-gate disabled" };
  if (config.mode === "permissive") return { action: "allow", ruleId: "mode", reason: "permissive mode" };
  if (config.mode === "strict") return { action: "deny", ruleId: "mode", reason: "strict mode" };
  const all = [...rulesFromPermissions(config.permissions), ...rulesFromPermissions(BUILTIN_PERMISSIONS, "builtin")];
  const deny = firstHit(all, req, "deny");
  if (deny) return { action: deny.action, ruleId: deny.id, reason: deny.reason || deny.id, timeoutSeconds: deny.timeoutSeconds, defaultOnTimeout: deny.defaultOnTimeout };
  const remembered = sessionMemory.get(normalizeCommand(req.command));
  if (remembered) return { action: remembered, ruleId: "remember:session", reason: "remembered decision" };
  const rule = firstHit(all, req, "ask") || firstHit(all, req, "allow");
  if (rule) return { action: rule.action, ruleId: rule.id, reason: rule.reason || rule.id, timeoutSeconds: rule.timeoutSeconds, defaultOnTimeout: rule.defaultOnTimeout };
  return { action: config.defaultAction, ruleId: "default", reason: "default policy" };
}
function audit(ctx: ExtensionContext, req: Request, d: Decision): void {
  if (!config.audit.enabled || !config.audit.path) return;
  const path = resolve(ctx.cwd, config.audit.path);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...req, decision: d }) + "\n");
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function visibleSlice(lines: string[], offset: number, maxLines: number, marker: (text: string) => string): string[] {
  if (lines.length <= maxLines) return lines;
  const end = Math.min(lines.length, offset + maxLines - 1);
  return [...lines.slice(offset, end), marker(`↑↓ command scroll ${offset + 1}-${end}/${lines.length}`)];
}
async function prompt(ctx: ExtensionContext, req: Request, d: Decision): Promise<Action> {
  if (!ctx.hasUI) return d.defaultOnTimeout || "deny";
  stats.asked++;
  const result = await ctx.ui.custom<PermissionChoice>((tui, theme, _kb, done) => {
    const opts: PermissionChoice[] = [
      { k: "y", label: "yes, run once", action: "allow", remember: false },
      { k: "s", label: "yes, remember this session", action: "allow", remember: "session" },
      { k: "p", label: "yes, remember for this project", action: "allow", remember: "project" },
      { k: "n", label: "no, block it", action: "deny", remember: false },
    ];
    let selected = 0;
    let commandOffset = 0;
    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
        else if (matchesKey(data, Key.down)) selected = Math.min(opts.length - 1, selected + 1);
        else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) commandOffset = Math.max(0, commandOffset - 5);
        else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) commandOffset += 5;
        else if (matchesKey(data, Key.home)) commandOffset = 0;
        else if (matchesKey(data, Key.end)) commandOffset = Number.MAX_SAFE_INTEGER;
        else if (matchesKey(data, Key.enter)) done(opts[selected]!);
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done({ action: "deny", remember: false });
        else {
          const o = opts.find((x) => data.toLowerCase() === x.k);
          if (o) done(o);
        }
        tui.requestRender();
      },
      render(width: number) {
        const inner = Math.max(10, width - 4);
        const termRows = tui.terminal.rows || 24;
        const maxPromptLines = Math.max(MIN_PROMPT_LINES, Math.floor(termRows * PROMPT_SCREEN_RATIO));
        const reservedLines = 15;
        const commandLineBudget = clamp(maxPromptLines - reservedLines, MIN_COMMAND_LINES, MAX_COMMAND_LINES);
        const commandLines = wrapTextWithAnsi(req.command, inner);
        const maxCommandOffset = Math.max(0, commandLines.length - commandLineBudget + 1);
        commandOffset = clamp(commandOffset, 0, maxCommandOffset);
        const c = new Container();
        c.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
        c.addChild(new Text(`${theme.fg("warning", theme.bold("pi-gate"))} ${theme.fg("muted", "run this command?")}`, 1, 0));
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("accent", "command"), 1, 0));
        c.addChild(new Text(visibleSlice(commandLines, commandOffset, commandLineBudget, (s) => theme.fg("dim", s)).join("\n"), 2, 0));
        c.addChild(new Spacer(1));
        c.addChild(new Text(`${theme.fg("warning", "reason")} ${d.reason}\n${theme.fg("dim", `rule ${d.ruleId} • ${req.source} • ${req.cwd}`)}`, 1, 0));
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("accent", "answer"), 1, 0));
        c.addChild(new Text(opts.map((o, i) => {
          const marker = i === selected ? theme.fg("accent", "›") : " ";
          const label = i === selected ? theme.fg("accent", o.label) : o.label;
          return `${marker} ${theme.fg("muted", o.k)}  ${label}`;
        }).join("\n"), 2, 0));
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("dim", "y/n/s/p or ↑/↓ then enter • esc blocks"), 1, 0));
        c.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
        return c.render(width).slice(0, maxPromptLines).map((l) => truncateToWidth(l, width));
      },
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 50, margin: 1 } });
  if (result.remember === "session") sessionMemory.set(normalizeCommand(req.command), result.action);
  if (result.remember === "project") persistRule(ctx, projectConfigPath(ctx), normalizeCommand(req.command), result.action);
  return result.action;
}
async function gate(ctx: ExtensionContext, req: Request): Promise<{ block: boolean; reason?: string }> {
  const d = decide(req);
  let action = d.action;
  if (action === "ask") action = await prompt(ctx, req, d);
  if (action === "allow") stats.allowed++; else stats.denied++;
  audit(ctx, req, { ...d, action });
  ctx.ui.setStatus(EXT, `gate a:${stats.allowed} d:${stats.denied} ?:${stats.asked}`);
  return action === "deny" ? { block: true, reason: `pi-gate: ${d.reason}` } : { block: false };
}

export default function piGate(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => { loadConfig(ctx.cwd); ctx.ui.setStatus(EXT, `gate ${config.enabled ? config.mode : "off"}`); });
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
    if (cmd === "reload") { loadConfig(ctx.cwd); ctx.ui.notify(`pi-gate reloaded: ${rulesFromPermissions(config.permissions).length} permission patterns`, "success"); return; }
    if (cmd === "mode") { const mode = rest[0]; if (mode === "off") config.enabled = false; else if (["ask", "strict", "permissive"].includes(mode)) { config.enabled = true; config.mode = mode as Config["mode"] & string; } ctx.ui.setStatus(EXT, `gate ${config.enabled ? config.mode : "off"}`); return; }
    if (cmd === "check") { const command = args.replace(/^check\s+/, ""); ctx.ui.notify(JSON.stringify(decide({ source: "agent", command, cwd: ctx.cwd }), null, 2), "info"); return; }
    ctx.ui.notify(`pi-gate ${config.enabled ? config.mode : "off"}\npermission patterns: ${rulesFromPermissions(config.permissions).length} user + ${rulesFromPermissions(BUILTIN_PERMISSIONS).length} builtin\nconfig: ${configPaths.join(", ")}\nstats: ${JSON.stringify(stats)}`, "info");
  }});
}
