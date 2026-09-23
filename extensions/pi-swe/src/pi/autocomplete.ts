import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  prefixedCompletions,
  renderActionHelp,
  rootActionCompletions,
  type CommandActionSpec,
  type CommandCompletion,
} from "../../../../src/command-guidance.ts";
import { InitiativeStore } from "../app/store.ts";
import { completionBlockers } from "../domain/completion.ts";
import { readyWork, type Initiative, type WorkItem } from "../domain/initiative.ts";

export const SWE_COMMAND_ACTIONS = [
  { action: "plan", syntax: "/swe plan [--id topic] <request>", description: "Plan from natural language", help: "Assess and create an initiative" },
  { action: "open", syntax: "/swe open <topic>", description: "Open the canonical work docket" },
  { action: "list", syntax: "/swe list <topic>", description: "List canonical work" },
  { action: "status", syntax: "/swe status <topic>", description: "Inspect durable initiative state" },
  { action: "next", syntax: "/swe next <topic>", description: "Show the next dependency-ready leaf" },
  { action: "start", syntax: "/swe start <topic> <work-id>", description: "Start dependency-ready work", help: "Start ready work" },
  { action: "implemented", syntax: "/swe implemented <topic> <work-id>", description: "Mark active work implemented", help: "Mark work implemented" },
  { action: "complete", syntax: "/swe complete <topic> [work-id]", description: "Complete work through evidence gates" },
  { action: "resume", syntax: "/swe resume <topic>", description: "Resume a paused or draft initiative" },
  { action: "pause", syntax: "/swe pause <topic>", description: "Pause an active initiative" },
] as const satisfies readonly CommandActionSpec[];

export type SweCommandAction = typeof SWE_COMMAND_ACTIONS[number]["action"];
const KNOWN_ACTIONS = new Set<string>(SWE_COMMAND_ACTIONS.map((item) => item.action));
const WORK_ACTIONS = new Set(["start", "implemented", "complete"]);
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_INITIATIVES = 250;

type CompletionOptions = { cwd?: string; focusedInitiativeId?: string };
type DiscoveredInitiative = { initiative: Initiative };

export function getSweCommandCompletions(prefix: string, options: CompletionOptions = {}): AutocompleteItem[] {
  const normalized = prefix.trimStart();
  if (!/\s/.test(normalized)) return rootActionCompletions(normalized, SWE_COMMAND_ACTIONS);

  const actionMatch = normalized.match(/^(\S+)\s+(.*)$/s);
  if (!actionMatch || !KNOWN_ACTIONS.has(actionMatch[1]!) || actionMatch[1] === "plan" || !options.cwd) return [];
  const action = actionMatch[1];
  const remainder = actionMatch[2];
  const workMatch = remainder.match(/^(\S+)\s+(.*)$/s);
  const initiatives = discoverInitiatives(options.cwd)
    .filter(({ initiative }) => supportsAction(action, initiative))
    .sort((left, right) => initiativeRank(left.initiative, options.focusedInitiativeId) - initiativeRank(right.initiative, options.focusedInitiativeId)
      || left.initiative.id.localeCompare(right.initiative.id));

  if (!workMatch || !WORK_ACTIONS.has(action)) {
    if (/\s/.test(remainder)) return [];
    return prefixedCompletions(`${action} `, initiatives
      .filter(({ initiative }) => initiative.id.startsWith(remainder))
      .map(({ initiative }) => ({
        value: initiative.id,
        label: initiative.id,
        description: describeInitiative(initiative, options.focusedInitiativeId === initiative.id),
      })));
  }

  const initiativeId = workMatch[1];
  const workPrefix = workMatch[2];
  if (/\s/.test(workPrefix)) return [];
  const found = initiatives.find(({ initiative }) => initiative.id === initiativeId);
  if (!found) return [];
  return prefixedCompletions(`${action} ${initiativeId} `, workCompletions(action, found.initiative, options.cwd, workPrefix));
}

export function renderSweQuickHelp(initiative?: Initiative): string {
  const lines = initiative
    ? [`Focused: ${initiative.id} · ${describeInitiative(initiative, false)}`]
    : ["No focused SWE initiative."];
  if (initiative) {
    const next = readyWork(initiative)[0];
    if (next) lines.push(`Next: ${next.id} — ${clip(next.title, 72)}`);
  }
  lines.push(
    "",
    ...renderActionHelp(SWE_COMMAND_ACTIONS, ["plan", "status", "open", "start", "implemented", "complete", "pause", "resume"]),
    "Type a space after an action or topic to see contextual completions.",
  );
  return lines.join("\n");
}

function discoverInitiatives(cwd: string): DiscoveredInitiative[] {
  const root = join(resolve(cwd), ".model-artifacts", "initiatives");
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && TOPIC.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_INITIATIVES);
  } catch {
    return [];
  }
  const store = new InitiativeStore(cwd);
  return names.flatMap((initiativeId) => {
    try {
      return [{ initiative: store.read(initiativeId).initiative }];
    } catch {
      return [];
    }
  });
}

function supportsAction(action: string, initiative: Initiative): boolean {
  if (action === "pause") return initiative.status === "active";
  if (action === "resume") return initiative.status === "paused" || initiative.status === "draft";
  if (action === "start") return (initiative.status === "active" || initiative.status === "draft") && readyWork(initiative).length > 0;
  if (action === "implemented") return initiative.status === "active"
    && initiative.work.some((item) => item.kind !== "phase" && item.status === "active" && !item.disposition);
  if (action === "complete") return initiative.status === "active"
    && initiative.work.some((item) => item.kind !== "phase" && item.status === "implemented" && !item.disposition);
  return true;
}

function initiativeRank(initiative: Initiative, focusedInitiativeId?: string): number {
  if (initiative.id === focusedInitiativeId) return 0;
  return initiative.status === "active" ? 1 : initiative.status === "paused" ? 2 : initiative.status === "draft" ? 3 : 4;
}

function describeInitiative(initiative: Initiative, focused: boolean): string {
  const executable = initiative.work.filter((item) => item.kind !== "phase");
  const complete = executable.filter((item) => item.status === "complete").length;
  const next = readyWork(initiative)[0];
  const current = executable.find((item) => item.status === "active") ?? executable.find((item) => item.status === "implemented") ?? next;
  const detail = current ? `${current.id}: ${clip(current.title, 44)}` : "no ready work";
  return `${focused ? "focused · " : ""}${initiative.status} · r${initiative.revision} · ${complete}/${executable.length} complete · ${detail}`;
}

function workCompletions(action: string, initiative: Initiative, cwd: string, prefix: string): CommandCompletion[] {
  let work: WorkItem[] = [];
  if (action === "start") work = readyWork(initiative);
  else if (action === "implemented") work = initiative.work.filter((item) => item.kind !== "phase" && item.status === "active" && !item.disposition);
  else if (action === "complete") work = initiative.work.filter((item) => item.kind !== "phase" && item.status === "implemented" && !item.disposition);

  const items = work
    .filter((item) => item.id.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((item): CommandCompletion => {
      let state = item.status ?? "unknown";
      if (action === "start") state = "ready";
      if (action === "complete") {
        const blockers = completionBlockers(initiative, item.id, cwd);
        state = blockers.length ? `blocked: ${clip(blockers[0], 70)}` : "ready to complete";
      }
      return {
        value: item.id,
        label: item.id,
        description: `${state} · ${clip(item.title, 72)}`,
      };
    });

  return items;
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
