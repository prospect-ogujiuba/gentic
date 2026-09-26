// Legacy scaffold helpers only; built-in policies use fixed predicates, not trigger files.
import type { PrimitiveContext } from "./index.ts";
import { flattenTriggerText } from "./prompt-input.ts";
export { flattenTriggerText } from "./prompt-input.ts";

export type PrimitiveTriggers = {
  phrases: readonly string[];
  pathPatterns: readonly RegExp[];
};

export type PrimitivePromptEvent = {
  prompt?: unknown;
  systemPromptOptions?: {
    customPrompt?: unknown;
    appendSystemPrompt?: unknown;
    contextFiles?: unknown;
  };
};

type TriggerFile = { phrases?: unknown; pathPatterns?: unknown };

const MAX_TRIGGER_ENTRIES = 64;
const MAX_TRIGGER_LENGTH = 512;
const MAX_PATH_CANDIDATES = 1024;
const MAX_PATH_CANDIDATE_LENGTH = 512;

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  if (value.length > MAX_TRIGGER_ENTRIES) throw new Error(`${field} must contain at most ${MAX_TRIGGER_ENTRIES} entries`);
  if (value.some((entry) => entry.trim().length === 0)) throw new Error(`${field} must not contain blank entries`);
  if (value.some((entry) => entry.length > MAX_TRIGGER_LENGTH)) throw new Error(`${field} entries must contain at most ${MAX_TRIGGER_LENGTH} characters`);
  return value;
}

export function loadPrimitiveTriggers(ctx: PrimitiveContext, file = "triggers.json"): PrimitiveTriggers {
  return parsePrimitiveTriggers(ctx.readText(file));
}

/** Compatibility parser for the retained scaffold; not used by built-in policies. */
export function parsePrimitiveTriggers(text: string): PrimitiveTriggers {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("triggers must be a JSON object");
  const triggerFile = parsed as TriggerFile;
  const phrases = stringList(triggerFile.phrases, "phrases").map((phrase) => phrase.toLowerCase());
  const pathPatterns = stringList(triggerFile.pathPatterns, "pathPatterns").map((pattern) => {
    try {
      const compiled = new RegExp(pattern, "i");
      if (compiled.test("")) throw new Error("pattern must not match empty input");
      return compiled;
    } catch (error) {
      throw new Error(`Invalid primitive trigger regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { phrases, pathPatterns };
}

function pathCandidates(text: string): string[] | undefined {
  const candidates: string[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const candidate = match[0];
    if (candidate.length > MAX_PATH_CANDIDATE_LENGTH || candidates.length >= MAX_PATH_CANDIDATES) return;
    candidates.push(candidate);
  }
  return candidates;
}

function matchesPattern(pattern: RegExp, candidate: string): boolean {
  pattern.lastIndex = 0;
  try { return pattern.test(candidate); }
  finally { pattern.lastIndex = 0; }
}

export function matchesPrimitiveTrigger(value: unknown, triggers: PrimitiveTriggers): boolean {
  const text = flattenTriggerText(value);
  const haystack = text.toLowerCase();
  if (triggers.phrases.some((phrase) => haystack.includes(phrase))) return true;
  const candidates = pathCandidates(text);
  return candidates !== undefined && triggers.pathPatterns.some((pattern) => candidates.some((candidate) => matchesPattern(pattern, candidate)));
}

export function matchesPrimitivePrompt(event: PrimitivePromptEvent, triggers: PrimitiveTriggers): boolean {
  const matchesField = (read: () => unknown): boolean => {
    try { return matchesPrimitiveTrigger(read(), triggers); }
    catch { return false; }
  };
  if (matchesField(() => event.prompt)) return true;
  let options: PrimitivePromptEvent["systemPromptOptions"];
  try { options = event.systemPromptOptions; }
  catch { return false; }
  if (!options) return false;
  return matchesField(() => options.customPrompt)
    || matchesField(() => options.appendSystemPrompt)
    || matchesField(() => options.contextFiles);
}
