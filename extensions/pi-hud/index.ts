import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type HudComponentId = "model" | "context" | "git" | "session" | "agent" | "tools" | "events";
type AgentState = "idle" | "thinking" | "reading" | "editing" | "writing" | "executing" | "testing";
type Placement = "footer" | "widget" | "both";

type Theme = {
  fg(color: any, text: string): string;
  bg?: (color: any, text: string) => string;
};

interface ActiveTool {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
}

interface GitStatus {
  branch: string;
  dirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  upstream?: string;
  remoteName?: string;
  aheadCount: number;
  behindCount: number;
}

interface UsageSnapshot {
  input?: number;
  output?: number;
  cost?: number;
  totalTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPct?: number;
}

interface HudSnapshot {
  modelId?: string;
  worktreeId: string;
  usage?: UsageSnapshot;
  git?: GitStatus;
  activeTools: ActiveTool[];
  toolCounts: Record<string, number>;
  recentEvents: string[];
  thinkingLevel?: string;
}

interface HudState {
  enabled: boolean;
  placement: Placement;
  components: Record<HudComponentId, boolean>;
  agent: AgentState;
  turn: number;
  recentEvents: string[];
  activeTools: ActiveTool[];
  toolCounts: Record<string, number>;
  successCalls: number;
  errorCalls: number;
  warningCalls: number;
  thinkingLevel?: string;
  modal?: { update(snapshot: HudSnapshot): void };
}

const COMPONENT_IDS = ["model", "context", "git", "session", "agent", "tools", "events"] as const satisfies readonly HudComponentId[];
const PLACEMENTS = ["footer", "widget", "both"] as const satisfies readonly Placement[];
const CONTEXT_BAR_WIDTH = 16;
const FRESH_COLOR = "syntaxComment";
const MUTED_WARNING_COLOR = "syntaxString";
const TEST_COMMAND_RE = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)(\s|$)|\b(vitest|jest|pytest|ruff|eslint|tsc)\b/i;

const state: HudState = {
  enabled: true,
  placement: "footer",
  components: { model: true, context: true, git: true, session: true, agent: true, tools: true, events: true },
  agent: "idle",
  turn: 0,
  recentEvents: ["loaded"],
  activeTools: [],
  toolCounts: {},
  successCalls: 0,
  errorCalls: 0,
  warningCalls: 0,
};

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 700 }).trim();
  } catch {
    return undefined;
  }
}

function getGitStatus(cwd: string): GitStatus | undefined {
  if (!git(cwd, ["rev-parse", "--show-toplevel"])) return undefined;

  const branch = git(cwd, ["branch", "--show-current"]) || git(cwd, ["rev-parse", "--short", "HEAD"]) || "detached";
  const porcelain = git(cwd, ["status", "--porcelain=v1"]) || "";
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const line of porcelain.split("\n").filter(Boolean)) {
    if (line.startsWith("??")) {
      untrackedCount += 1;
      continue;
    }
    if (line[0] !== " ") stagedCount += 1;
    if (line[1] !== " ") unstagedCount += 1;
  }

  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const [ahead = "0", behind = "0"] = upstream
    ? (git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])?.split(/\s+/) ?? [])
    : [];

  return {
    branch,
    dirty: stagedCount + unstagedCount + untrackedCount > 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    upstream,
    remoteName: upstream?.split("/")[0],
    aheadCount: Number(ahead),
    behindCount: Number(behind),
  };
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createSnapshot(ctx: ExtensionContext): HudSnapshot {
  const usage = ctx.getContextUsage?.();
  const tokens = numberOrUndefined(usage?.tokens);
  return {
    modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    worktreeId: ctx.cwd,
    usage: usage ? {
      totalTokens: tokens,
      contextTokens: tokens,
      contextWindow: usage.contextWindow,
      contextPct: numberOrUndefined(usage.percent),
    } : undefined,
    git: getGitStatus(ctx.cwd),
    activeTools: state.activeTools,
    toolCounts: state.toolCounts,
    recentEvents: state.recentEvents,
    thinkingLevel: state.thinkingLevel,
  };
}

function compactNumber(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function compactCurrency(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "$-";
}

function formatPercent(n: number | undefined): string | undefined {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)}%` : undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function cleanTruncate(text: string, width: number): string {
  return truncateToWidth(text, width, "").replace(/\x1b\[0m$/, "");
}

function fitLeftRight(width: number, left: string, right: string): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + 1 + rightWidth <= width) return left + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + right;
  if (rightWidth + 1 >= width) return truncateToWidth(right, width);
  return truncateToWidth(left, Math.max(1, width - rightWidth - 1)) + " " + right;
}

function fitResponsive(width: number, leftCandidates: string[], rightCandidates: string[]): string {
  for (const left of leftCandidates) {
    for (const right of rightCandidates) {
      if (!left) return right;
      if (!right) return left;
      if (visibleWidth(left) + 1 + visibleWidth(right) <= width) return cleanTruncate(fitLeftRight(width, left, right), width);
    }
  }
  return cleanTruncate([leftCandidates.at(-1), rightCandidates.at(-1)].filter(Boolean).join(" "), width);
}

function contextColor(pct: number | undefined): string {
  if (pct === undefined) return FRESH_COLOR;
  if (pct >= 90) return "error";
  if (pct >= 60) return MUTED_WARNING_COLOR;
  return FRESH_COLOR;
}

function renderContextBar(s: HudSnapshot, theme: Theme): string {
  const usage = s.usage;
  if (!usage || usage.contextWindow === undefined || usage.contextPct === undefined) {
    return [theme.fg("dim", "░".repeat(CONTEXT_BAR_WIDTH)), theme.fg("dim", "-/-"), theme.fg("dim", "-")].join(" ");
  }

  const pct = Math.max(0, Math.min(100, usage.contextPct));
  const filled = Math.max(0, Math.min(CONTEXT_BAR_WIDTH, Math.round((pct / 100) * CONTEXT_BAR_WIDTH)));
  const color = contextColor(pct);
  const tokens = compactNumber(usage.contextTokens ?? usage.totalTokens);
  return `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(CONTEXT_BAR_WIDTH - filled))} ${theme.fg("text", `${tokens}/${compactNumber(usage.contextWindow)}`)} ${theme.fg(color, formatPercent(pct) ?? "-")}`;
}

function renderUsageSummary(s: HudSnapshot, theme: Theme): string {
  const u = s.usage;
  if (!u) {
    return [`${theme.fg("dim", "I")} ${theme.fg("dim", "-")}`, `${theme.fg("dim", "O")} ${theme.fg("dim", "-")}`, theme.fg("dim", "$-")].join("  ");
  }
  return [`${theme.fg("dim", "I")} ${theme.fg("text", compactNumber(u.input))}`, `${theme.fg("dim", "O")} ${theme.fg("text", compactNumber(u.output))}`, theme.fg(MUTED_WARNING_COLOR, compactCurrency(u.cost))].join("  ");
}

function renderModel(s: HudSnapshot, theme: Theme): string {
  const model = String(s.modelId ?? "no-model");
  return theme.fg("accent", model.includes("/") ? (model.split("/").pop() ?? model) : model);
}

function renderThinkingLevel(s: HudSnapshot, theme: Theme): string {
  const level = s.thinkingLevel?.trim();
  return level ? `${theme.fg("dim", "(")}${theme.fg(level === "off" ? "dim" : "accent", level)}${theme.fg("dim", ")")}` : "";
}

function getWorktreeLabel(worktreeId: string): string {
  const home = process.env.HOME?.replace(/\/$/, "");
  return home && (worktreeId === home || worktreeId.startsWith(`${home}/`)) ? `~${worktreeId.slice(home.length)}` : basename(worktreeId);
}

function renderGitStatus(s: HudSnapshot, theme: Theme): string {
  const cwd = getWorktreeLabel(s.worktreeId);
  if (!s.git) return [theme.fg("text", cwd), theme.fg("dim", "no git repo")].join(` ${theme.fg("dim", "·")} `);

  const parts = [theme.fg("text", cwd), `${theme.fg("text", s.git.branch)}${s.git.dirty ? theme.fg("error", "(*)") : ""}`];
  if (!s.git.upstream) {
    parts.push(theme.fg("dim", "no upstream"));
  } else {
    if (s.git.remoteName) parts.push(theme.fg("text", s.git.remoteName));
    if (s.git.aheadCount === 0 && s.git.behindCount === 0) parts.push(theme.fg("success", "synced"));
    parts.push(`${theme.fg(s.git.behindCount > 0 ? MUTED_WARNING_COLOR : "dim", `↓(${s.git.behindCount})`)}${theme.fg("dim", "|")}${theme.fg(s.git.aheadCount > 0 ? "accent" : "dim", `↑(${s.git.aheadCount})`)}`);
  }
  if (s.git.unstagedCount > 0) parts.push(`${theme.fg(MUTED_WARNING_COLOR, "unstaged")} ${theme.fg(MUTED_WARNING_COLOR, `(${s.git.unstagedCount})`)}`);
  if (s.git.untrackedCount > 0) parts.push(`${theme.fg("muted", "untracked")} ${theme.fg("muted", `(${s.git.untrackedCount})`)}`);
  if (s.git.stagedCount > 0) parts.push(`${theme.fg("success", "staged")} ${theme.fg("success", `(${s.git.stagedCount})`)}`);
  return parts.join(` ${theme.fg("dim", "·")} `);
}

function renderAgentStatus(_s: HudSnapshot, theme: Theme): string {
  return `${theme.fg("dim", "agent:")} ${theme.fg(state.agent === "idle" ? "dim" : "accent", state.agent)}`;
}

function renderToolBadges(s: HudSnapshot, theme: Theme): string {
  return Object.entries(s.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const active = s.activeTools.some((tool) => tool.toolName === name);
      const label = theme.fg(active ? "accent" : count === 0 ? "dim" : "text", `[${name} ${count}]`);
      return theme.bg ? theme.bg("selectedBg", label) : label;
    })
    .join(theme.fg("dim", " "));
}

function renderToolSummary(s: HudSnapshot, theme: Theme): string {
  const completed = state.successCalls + state.errorCalls;
  const parts: string[] = [];
  if (completed > 0) {
    parts.push(`${theme.fg("error", "err")} ${theme.fg(state.errorCalls > 0 ? "error" : "dim", `${state.errorCalls}`)}`);
    parts.push(`${theme.fg(MUTED_WARNING_COLOR, "warn")} ${theme.fg(state.warningCalls > 0 ? MUTED_WARNING_COLOR : "dim", `${state.warningCalls}`)}`);
    parts.push(`${theme.fg("dim", "ok/fail")} ${theme.fg(state.successCalls > 0 ? "success" : "dim", `${state.successCalls}`)}${theme.fg("dim", ":")}${theme.fg(state.errorCalls > 0 ? "error" : "dim", `${state.errorCalls}`)}`);
  }
  if (s.activeTools.length > 0) parts.push(`${theme.fg("accent", "pending")} ${theme.fg("accent", `${s.activeTools.length}`)}`);
  return parts.join(` ${theme.fg("dim", "·")} `);
}

function shortEventName(name: string): string {
  return name.replace(/^tool_execution_/, "tool_").replace(/^session_/, "sess_").replace(/^message_/, "msg_");
}

function renderHarnessEvents(s: HudSnapshot, theme: Theme): string {
  const events = s.recentEvents.slice(0, 5);
  if (!events.length) return "";
  const chips = events.map((event, i) => theme.fg(i === 0 ? "accent" : "dim", `${i === 0 ? "◆" : "◇"} `) + theme.fg(i === 0 ? MUTED_WARNING_COLOR : "muted", shortEventName(event)));
  return `${theme.fg("dim", "Events | ")}${chips.join(theme.fg("dim", " "))}`;
}

function compactContextBar(line: string): string {
  const match = stripAnsi(line).match(/([\d.]+[kM]?\/[\d.]+[kM]?)\s+([\d.]+%|--)/);
  return match ? `${match[1]} ${match[2]}` : line;
}

function compactGitStatus(line: string, width: number): string[] {
  const parts = line.split(/\s+\x1b\[[0-9;]*m·\x1b\[[0-9;]*m\s+|\s+·\s+/).filter(Boolean);
  return [
    parts,
    parts.filter((part) => !stripAnsi(part).startsWith("fetched ")),
    parts.filter((part) => !/^(fetched |untracked |unstaged )/.test(stripAnsi(part))),
  ].map((candidate) => candidate.join(" · ")).filter((candidate) => candidate && visibleWidth(candidate) <= width);
}

function fitToolLine(width: number, badges: string, summary: string): string {
  if (!badges) return cleanTruncate(summary, width);
  if (!summary) return cleanTruncate(badges, width);
  if (visibleWidth(badges) + 1 + visibleWidth(summary) <= width) return cleanTruncate(fitLeftRight(width, badges, summary), width);

  const badgeParts = badges.split(/\s+(?=\x1b\[[0-9;]*m?\[|\[)/).filter(Boolean);
  for (let count = badgeParts.length - 1; count > 0; count -= 1) {
    const kept = badgeParts.slice(0, count).join(" ");
    if (visibleWidth(kept) + 1 + visibleWidth(summary) <= width) return fitLeftRight(width, kept, summary);
  }
  return cleanTruncate(summary, width);
}

function renderFooterLines(s: HudSnapshot, theme: Theme, width: number): string[] {
  const modelThinking = [state.components.model ? renderModel(s, theme) : "", state.components.model ? renderThinkingLevel(s, theme) : ""].filter(Boolean).join(theme.fg("dim", " "));
  const context = state.components.context ? renderContextBar(s, theme) : "";
  const lineOne = fitResponsive(width, [
    [modelThinking, context].filter(Boolean).join(theme.fg("dim", "  ")),
    [modelThinking, compactContextBar(context)].filter(Boolean).join(theme.fg("dim", "  ")),
    modelThinking,
  ], [state.components.context ? renderUsageSummary(s, theme) : ""]);

  const gitFull = state.components.git ? renderGitStatus(s, theme) : "";
  const gitCandidates = [gitFull, ...compactGitStatus(gitFull, width)].filter((value, index, all) => value && all.indexOf(value) === index);
  const lineTwo = fitResponsive(width, gitCandidates.length ? gitCandidates : [gitFull], [state.components.agent ? renderAgentStatus(s, theme) : ""]);
  const lineThree = state.components.tools ? fitToolLine(width, renderToolBadges(s, theme), renderToolSummary(s, theme)) : "";
  const eventLine = state.components.events ? cleanTruncate(renderHarnessEvents(s, theme), width) : "";
  return [lineOne, lineTwo, lineThree, eventLine].filter(Boolean);
}

function createHudComponent(s: HudSnapshot) {
  return (_tui: unknown, theme: Theme) => ({
    invalidate() {},
    render(width: number): string[] {
      return renderFooterLines(s, theme, width);
    },
  });
}

function sectionTitle(theme: Theme, title: string, width: number): string[] {
  const label = ` ${title} `;
  const fill = Math.max(0, width - visibleWidth(label));
  return [theme.fg("borderMuted", "─".repeat(Math.floor(fill / 2))) + theme.fg("accent", label) + theme.fg("borderMuted", "─".repeat(fill - Math.floor(fill / 2)))];
}

function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function framed(theme: Theme, width: number, title: string, body: string[]): string[] {
  const innerWidth = Math.max(24, width - 2);
  const titleText = ` ${title} `;
  const fill = Math.max(0, innerWidth - visibleWidth(titleText));
  const lines = [
    theme.fg("border", `╭${"─".repeat(Math.floor(fill / 2))}`) + theme.fg("accent", titleText) + theme.fg("border", `${"─".repeat(fill - Math.floor(fill / 2))}╮`),
  ];
  for (const line of body) {
    for (const wrapped of wrapTextWithAnsi(line, Math.max(8, innerWidth))) {
      lines.push(`${theme.fg("border", "│")}${padAnsi(wrapped, innerWidth)}${theme.fg("border", "│")}`);
    }
  }
  lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

function modalBody(s: HudSnapshot, theme: Theme, width: number): string[] {
  const bodyWidth = Math.max(24, width - 2);
  const modelLine = [renderModel(s, theme), renderThinkingLevel(s, theme), renderContextBar(s, theme)].filter(Boolean).join(theme.fg("dim", "  "));
  const lines = bodyWidth >= 84
    ? [fitLeftRight(bodyWidth, modelLine, renderUsageSummary(s, theme)), fitLeftRight(bodyWidth, renderGitStatus(s, theme), renderAgentStatus(s, theme))]
    : [modelLine, renderUsageSummary(s, theme), renderGitStatus(s, theme), renderAgentStatus(s, theme)];

  const badges = renderToolBadges(s, theme);
  const summary = renderToolSummary(s, theme);
  lines.push(...sectionTitle(theme, "tools", bodyWidth));
  if (badges) lines.push(badges);
  if (summary) lines.push(summary);
  lines.push(...sectionTitle(theme, "session", bodyWidth), `turn ${state.turn} · ${s.worktreeId}`);
  return lines;
}

class PiHudModalComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private scrollOffset = 0;

  constructor(
    private theme: Theme,
    private snapshot: HudSnapshot,
    private requestRender: () => void,
    private close: () => void,
    private getRows: () => number,
  ) {}

  update(snapshot: HudSnapshot): void {
    this.snapshot = snapshot;
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const all = framed(this.theme, Math.max(32, width), "Pi HUD", modalBody(this.snapshot, this.theme, Math.max(32, width)));
    const maxLines = Math.max(8, Math.floor(this.getRows() * 0.82));
    const maxOffset = Math.max(0, all.length - maxLines);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visible = all.length > maxLines
      ? [...all.slice(this.scrollOffset, this.scrollOffset + maxLines - 1), this.theme.fg("dim", `↑↓ scroll · esc close · ${this.scrollOffset + 1}-${Math.min(all.length, this.scrollOffset + maxLines - 1)}/${all.length}`)]
      : all;
    this.cachedWidth = width;
    this.cachedLines = visible;
    return visible;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.close();
    if (matchesKey(data, Key.down)) this.scrollOffset += 1;
    if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

async function openModal(ctx: ExtensionCommandContext): Promise<void> {
  let component: PiHudModalComponent | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      component = new PiHudModalComponent(theme, createSnapshot(ctx), () => tui.requestRender(), () => done(), () => tui.terminal.rows);
      state.modal = component;
      return component;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "82%", minWidth: 54, maxHeight: "86%", margin: 1, visible: (termWidth) => termWidth >= 54 },
    });
  } finally {
    if (state.modal === component) state.modal = undefined;
  }
}

function applyHud(ctx: ExtensionContext): void {
  ctx.ui.setFooter(undefined);
  ctx.ui.setWidget("pi-hud", undefined);
  if (!state.enabled) return;

  const snap = createSnapshot(ctx);
  state.modal?.update(snap);
  if (state.placement === "footer" || state.placement === "both") ctx.ui.setFooter(createHudComponent(snap));
  if (state.placement === "widget" || state.placement === "both") ctx.ui.setWidget("pi-hud", createHudComponent(snap));
}

function recordEvent(ctx: ExtensionContext, name: string): void {
  state.recentEvents = [name, ...state.recentEvents.filter((event) => event !== name)].slice(0, 8);
  if (ctx.hasUI) applyHud(ctx);
}

function setAgentForTool(toolName: string, args: unknown): void {
  const command = typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
  if (toolName === "read") state.agent = "reading";
  else if (toolName === "edit") state.agent = "editing";
  else if (toolName === "write") state.agent = "writing";
  else if (toolName === "bash" && typeof command === "string" && TEST_COMMAND_RE.test(command)) state.agent = "testing";
  else state.agent = "executing";
}

function isComponentId(value: string | undefined): value is HudComponentId {
  return COMPONENT_IDS.includes(value as HudComponentId);
}

function isPlacement(value: string | undefined): value is Placement {
  return PLACEMENTS.includes(value as Placement);
}

function resetConfig(): void {
  state.enabled = true;
  state.placement = "footer";
  for (const id of COMPONENT_IDS) state.components[id] = true;
}

export default function piHud(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => { state.agent = "idle"; recordEvent(ctx, event.type); });
  pi.on("model_select", (event, ctx) => recordEvent(ctx, event.type));
  pi.on("thinking_level_select", (event, ctx) => { state.thinkingLevel = event.level; recordEvent(ctx, event.type); });
  pi.on("agent_start", (event, ctx) => { state.agent = "thinking"; recordEvent(ctx, event.type); });
  pi.on("agent_end", (event, ctx) => { state.agent = "idle"; state.activeTools = []; recordEvent(ctx, event.type); });
  pi.on("turn_start", (event, ctx) => { state.turn = event.turnIndex; state.agent = "thinking"; recordEvent(ctx, event.type); });
  pi.on("tool_execution_start", (event, ctx) => {
    state.activeTools.push({ id: event.toolCallId, toolName: event.toolName, args: event.args as Record<string, unknown> });
    state.toolCounts[event.toolName] = (state.toolCounts[event.toolName] ?? 0) + 1;
    setAgentForTool(event.toolName, event.args);
    recordEvent(ctx, event.type);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    state.activeTools = state.activeTools.filter((tool) => tool.id !== event.toolCallId);
    event.isError ? state.errorCalls += 1 : state.successCalls += 1;
    state.agent = state.activeTools.length ? "executing" : "thinking";
    recordEvent(ctx, event.type);
  });
  pi.on("tool_result", (event, ctx) => {
    if (!event.isError && JSON.stringify(event.content).toLowerCase().includes("warning")) state.warningCalls += 1;
    recordEvent(ctx, event.type);
  });
  pi.on("message_end", (event, ctx) => recordEvent(ctx, event.type));
  pi.on("session_shutdown", (_event, ctx) => { ctx.ui.setFooter(undefined); ctx.ui.setWidget("pi-hud", undefined); });

  pi.registerCommand("pi-hud", {
    description: "Configure and inspect the Visiplane-style Pi HUD",
    handler: async (args, ctx) => {
      const [cmd, target] = args.trim().split(/\s+/);
      if (!cmd || cmd === "open" || cmd === "modal") return openModal(ctx);
      if (cmd === "show") state.enabled = true;
      else if (cmd === "hide") state.enabled = false;
      else if (cmd === "placement" && isPlacement(target)) state.placement = target;
      else if (cmd === "toggle" && isComponentId(target)) state.components[target] = !state.components[target];
      else if (cmd === "only" && isComponentId(target)) for (const id of COMPONENT_IDS) state.components[id] = id === target;
      else if (cmd === "reset") resetConfig();
      else {
        ctx.ui.notify("Usage: /pi-hud [open|show|hide|reset|placement footer|widget|both|toggle <component>|only <component>]", "info");
        return;
      }
      applyHud(ctx);
      ctx.ui.notify(`pi-hud: ${state.enabled ? "enabled" : "hidden"}; placement=${state.placement}; components=${COMPONENT_IDS.filter((id) => state.components[id]).join(",")}`, "info");
    },
  });
}
