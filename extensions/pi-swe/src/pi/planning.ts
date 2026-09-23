import { existsSync } from "node:fs";

import { initiativePath } from "../app/store.ts";

const MAX_REQUEST_CHARS = 8_192;
const MAX_DERIVED_TOPIC_CHARS = 64;
const LEADING_VERBS = new Set(["add", "build", "create", "design", "fix", "implement", "improve", "make", "plan", "refactor", "update"]);
const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "into", "my", "of", "on", "or", "our", "please", "the", "to", "with"]);

export type SwePlanRequest = {
  initiativeId: string;
  request: string;
  explicitId: boolean;
};

export function prepareSwePlanRequest(cwd: string, input: string): SwePlanRequest {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Usage: /swe plan <request> or /swe plan --id <kebab-topic> <request>");
  if (trimmed.length > MAX_REQUEST_CHARS || trimmed.includes("\0")) throw new Error(`initiative request must be between 1 and ${MAX_REQUEST_CHARS} safe characters`);

  const explicit = parseExplicitId(trimmed);
  const request = (explicit?.request ?? trimmed).trim();
  if (!request) throw new Error("initiative request cannot be empty");
  const initiativeId = explicit?.initiativeId ?? availableDerivedId(cwd, deriveSweInitiativeId(request));
  const path = initiativePath(cwd, initiativeId);
  if (explicit && existsSync(path)) throw new Error(`initiative already exists: ${initiativeId}`);
  return { initiativeId, request, explicitId: Boolean(explicit) };
}

export function deriveSweInitiativeId(request: string): string {
  const words = request.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  while (words.length > 1 && LEADING_VERBS.has(words[0]!)) words.shift();
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  const selected = (meaningful.length ? meaningful : words).slice(0, 10);
  const topic = selected.join("-").slice(0, MAX_DERIVED_TOPIC_CHARS).replace(/-+$/g, "");
  return topic || "swe-initiative";
}

export function buildSwePlanningPrompt(plan: SwePlanRequest): string {
  return [
    "The user invoked /swe plan. Assess and create a proportional durable SWE initiative for the request below.",
    `Use the canonical initiativeId ${JSON.stringify(plan.initiativeId)}.`,
    "Use the structured swe tool with action=create as the sole workflow.json bootstrap path.",
    "Create a complete schema-valid draft proposal with concrete scope, acceptance criteria, justified practices, work, and verification obligations. Keep small work small. Do not ask the user to author workflow.json or provide a specification file unless a genuine product decision is missing.",
    "",
    "Initiative request:",
    plan.request,
  ].join("\n");
}

function parseExplicitId(input: string): { initiativeId: string; request: string } | undefined {
  if (!input.startsWith("--id")) return undefined;
  const equals = input.match(/^--id=([^\s]+)(?:\s+([\s\S]+))?$/);
  if (equals) return { initiativeId: equals[1], request: equals[2] ?? "" };
  const spaced = input.match(/^--id\s+([^\s]+)(?:\s+([\s\S]+))?$/);
  if (spaced) return { initiativeId: spaced[1], request: spaced[2] ?? "" };
  throw new Error("Usage: /swe plan --id <kebab-topic> <request>");
}

function availableDerivedId(cwd: string, base: string): string {
  if (!existsSync(initiativePath(cwd, base))) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, MAX_DERIVED_TOPIC_CHARS - ending.length).replace(/-+$/g, "")}${ending}`;
    if (!existsSync(initiativePath(cwd, candidate))) return candidate;
  }
  throw new Error(`could not derive an available initiative id from: ${base}`);
}
