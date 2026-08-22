import type { PrimitiveContext } from "./index.ts";

export type PrimitiveTriggers = {
  phrases: readonly string[];
  pathPatterns: readonly RegExp[];
};

type TriggerFile = { phrases?: unknown; pathPatterns?: unknown };

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

export function loadPrimitiveTriggers(ctx: PrimitiveContext, file = "triggers.json"): PrimitiveTriggers {
  const parsed = JSON.parse(ctx.readText(file)) as TriggerFile;
  const phrases = stringList(parsed.phrases, "phrases").map((phrase) => phrase.toLowerCase());
  const pathPatterns = stringList(parsed.pathPatterns, "pathPatterns").map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Invalid primitive trigger regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { phrases, pathPatterns };
}

export function flattenTriggerText(value: unknown): string {
  const parts: string[] = [];
  const visit = (entry: unknown): void => {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      parts.push(String(entry));
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const item of Object.values(entry as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return parts.join("\n");
}

export function matchesPrimitiveTrigger(value: unknown, triggers: PrimitiveTriggers): boolean {
  const text = flattenTriggerText(value);
  const haystack = text.toLowerCase();
  return triggers.phrases.some((phrase) => haystack.includes(phrase)) || triggers.pathPatterns.some((pattern) => pattern.test(text));
}
