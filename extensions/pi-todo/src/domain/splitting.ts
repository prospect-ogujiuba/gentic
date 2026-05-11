import type { SplitCheckResult, SplitPolicy, Todo } from "./types.ts";

export const defaultSplitPolicy: SplitPolicy = {
  mode: "required",
  idealChildMin: 3,
  idealChildMax: 6,
  warnChildCount: 7,
  maxChildCount: 10,
  maxAcceptanceCriteria: 3,
  maxTouchedAreas: 1,
  maxEstimatedMinutes: 90,
  requireChildrenForEpics: true,
  allowOverride: true,
};

const BROAD_VERBS = /\b(implement|refactor|redesign|migrate|integrate|overhaul|rewrite|build|ship)\b/i;
const EPIC_VERBS = /\b(redesign|overhaul|rewrite|migration|initiative|project|system-wide)\b/i;
const VAGUE_VERBS = /\b(improve|clean\s*up|make\s+better|fix|polish|tidy)\b/i;
const DISCOVERY = /\b(investigate|discover|research|design|plan|decide|explore)\b/i;
const IMPLEMENTATION = /\b(implement|build|add|change|wire|persist|validate|enforce)\b/i;
const VALIDATION = /\b(test|verify|validate|check|lint|compile|review)\b/i;
const AREA_WORDS = /\b(cli|ui|api|service|domain|model|schema|persistence|store|renderer|tests?|docs?|frontend|backend|lifecycle|validation|policy|command)\b/gi;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function textFor(todo: Todo): string {
  return [todo.title, todo.description, ...todo.acceptanceCriteria, ...todo.definitionOfDone, ...todo.constraints, ...(todo.scope?.paths ?? []), ...(todo.scope?.files ?? []), ...(todo.scope?.commands ?? [])].filter(Boolean).join("\n");
}

function touchedAreas(todo: Todo, text: string): string[] {
  const fromText = Array.from(text.matchAll(AREA_WORDS), (match) => match[0].toLowerCase().replace(/s$/, ""));
  const scopedLocations = [...(todo.scope?.paths ?? []), ...(todo.scope?.files ?? [])];
  const scopedAreas = scopedLocations.length > 1 ? scopedLocations.map((path) => path.split("/").slice(0, 2).join("/")) : [];
  const fromScope = [todo.scope?.component, todo.scope?.service, todo.scope?.domain, ...scopedAreas].filter(Boolean) as string[];
  return unique([...fromText, ...fromScope]);
}

function objectName(title: string): string {
  return title.replace(/^\s*(implement|refactor|redesign|migrate|integrate|overhaul|rewrite|build|ship|add|update|fix|improve)\s+/i, "").trim() || title.trim() || "task";
}

function childSuggestions(todo: Todo, count: number): { title: string; acceptanceCriteria?: string[] }[] {
  const object = objectName(todo.title);
  const candidates = [
    { title: `Define ${object} split contract`, acceptanceCriteria: ["The child has clear acceptance criteria and validation path"] },
    { title: `Add ${object} task metadata support`, acceptanceCriteria: ["The task model can represent the required metadata"] },
    { title: `Implement ${object} lifecycle behavior`, acceptanceCriteria: ["The lifecycle enforces the child task's done condition"] },
    { title: `Expose ${object} command behavior`, acceptanceCriteria: ["Users can invoke and inspect the behavior through the todo tool"] },
    { title: `Verify ${object} cases`, acceptanceCriteria: ["Atomic, split-required, too-vague, and epic paths are covered"] },
    { title: `Document ${object} rollout notes`, acceptanceCriteria: ["Reviewers can understand the split rationale and next action"] },
  ];
  return candidates.slice(0, Math.max(1, Math.min(count, candidates.length)));
}

export function assessSplitPolicy(todo: Todo, policy: SplitPolicy = defaultSplitPolicy): SplitCheckResult {
  const text = textFor(todo);
  const title = todo.title.trim();
  const reasons: string[] = [];
  const areas = touchedAreas(todo, text);
  const hasDescription = Boolean(todo.description?.trim());
  const wordCount = title.split(/\s+/).filter(Boolean).length;
  const acceptanceCount = todo.acceptanceCriteria.length;
  const validationSignals = unique([...(text.match(VALIDATION) ?? [])]).length;
  const broadTitle = BROAD_VERBS.test(title);
  const epicTitle = EPIC_VERBS.test(title);
  const vagueTitle = VAGUE_VERBS.test(title);
  const mixesDiscoveryAndImplementation = DISCOVERY.test(text) && IMPLEMENTATION.test(text);

  if (todo.workDirectlyAllowed === false || (todo.children ?? []).length > 0) {
    reasons.push(todo.workDirectlyAllowed === false ? "parent container is not directly workable" : "task already has child tasks");
    return { assessment: "epic", confidence: "high", reasons, recommendedChildCount: Math.max(policy.idealChildMin, Math.min(policy.idealChildMax, todo.children.length || policy.idealChildMin)), splitPolicySatisfied: false, suggestedChildren: [] };
  }

  if (epicTitle && (areas.length > policy.maxTouchedAreas || hasDescription || acceptanceCount > 1)) reasons.push("title describes a broad initiative");
  if (areas.length > policy.maxTouchedAreas) reasons.push(`touches multiple areas: ${areas.slice(0, 4).join(", ")}`);
  if (acceptanceCount > policy.maxAcceptanceCriteria) reasons.push(`has more than ${policy.maxAcceptanceCriteria} acceptance criteria`);
  if (validationSignals > 1) reasons.push("mentions more than one validation path");
  if (mixesDiscoveryAndImplementation) reasons.push("mixes discovery/design and implementation work");
  if (broadTitle && (hasDescription || areas.length > 0 || acceptanceCount > 1 || wordCount > 4)) reasons.push("title uses a broad implementation verb");

  if (vagueTitle && !hasDescription && acceptanceCount === 0 && areas.length === 0 && wordCount <= 4) {
    return { assessment: "too_vague", confidence: "high", reasons: ["no concrete deliverable or validation path"], recommendedChildCount: 0, splitPolicySatisfied: false, suggestedChildren: [] };
  }

  if (epicTitle && reasons.length > 0) {
    const recommendedChildCount = Math.min(policy.maxChildCount, Math.max(policy.idealChildMin, reasons.length + 2));
    return { assessment: "epic", confidence: "medium", reasons, recommendedChildCount, splitPolicySatisfied: false, suggestedChildren: childSuggestions(todo, Math.min(policy.idealChildMax, recommendedChildCount)) };
  }

  if (reasons.length > 0) {
    const recommendedChildCount = Math.min(policy.maxChildCount, Math.max(policy.idealChildMin, Math.min(policy.idealChildMax, reasons.length + 2)));
    return { assessment: "split_required", confidence: reasons.length > 1 ? "high" : "medium", reasons, recommendedChildCount, splitPolicySatisfied: false, suggestedChildren: childSuggestions(todo, recommendedChildCount) };
  }

  return { assessment: "atomic", confidence: "medium", reasons: ["one concern with no split-pressure signals"], recommendedChildCount: 1, splitPolicySatisfied: true, suggestedChildren: [] };
}

export function shouldBlockForSplit(result: SplitCheckResult, policy: SplitPolicy = defaultSplitPolicy, overrideReason?: string): boolean {
  if (result.splitPolicySatisfied) return false;
  if (policy.mode === "advisory") return false;
  if (overrideReason?.trim() && policy.allowOverride && policy.mode !== "autonomous") return false;
  return true;
}
