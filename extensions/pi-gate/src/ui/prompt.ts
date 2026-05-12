import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { Action, Decision, PermissionChoice, Request } from "../domain/policy.ts";
import { normalizeCommand } from "../domain/policy.ts";
import { persistGlobalRule, persistProjectRule, rememberSessionDecision } from "../app/remember.ts";

const MIN_PROMPT_LINES = 12;
const PROMPT_SCREEN_RATIO = 0.78;
const MIN_COMMAND_LINES = 3;
const MAX_COMMAND_LINES = 10;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function visibleSlice(lines: string[], offset: number, maxLines: number, marker: (text: string) => string): string[] {
  if (lines.length <= maxLines) return lines;
  const end = Math.min(lines.length, offset + maxLines - 1);
  return [...lines.slice(offset, end), marker(`↑↓ command scroll ${offset + 1}-${end}/${lines.length}`)];
}

export async function promptPermission(ctx: ExtensionContext, req: Request, d: Decision): Promise<Action> {
  if (!ctx.hasUI) return d.defaultOnTimeout || "deny";
  const result = await ctx.ui.custom<PermissionChoice>((tui, theme, _kb, done) => {
    const opts: PermissionChoice[] = [
      { k: "y", label: "yes, run once", action: "allow", remember: false },
      { k: "s", label: "yes, remember this session", action: "allow", remember: "session" },
      { k: "g", label: "yes, remember globally", action: "allow", remember: "global" },
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
        c.addChild(new Text(theme.fg("dim", "y/n/s/g/p or ↑/↓ then enter • esc blocks"), 1, 0));
        c.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
        return c.render(width).slice(0, maxPromptLines).map((l) => truncateToWidth(l, width));
      },
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 50, margin: 1 } });
  if (result.remember === "session") rememberSessionDecision(normalizeCommand(req.command), result.action);
  if (result.remember === "global") persistGlobalRule(ctx, req.command, result.action);
  if (result.remember === "project") persistProjectRule(ctx, req.command, result.action);
  return result.action;
}
