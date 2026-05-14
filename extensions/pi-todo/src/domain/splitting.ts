import { emptyScope, type SplitCheckResult, type SplitPolicy, type SplitSuggestedChild, type Todo, type TodoIntakeAssessment, type TodoIntakeInput } from "./types.ts";

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
const TITLE_STOP_WORDS = new Set(["a", "an", "and", "as", "for", "in", "into", "of", "on", "the", "to", "with", "add", "build", "change", "define", "enforce", "expose", "fix", "implement", "improve", "make", "migrate", "refactor", "redesign", "rewrite", "ship", "task", "tasks", "todo", "todos", "work", "changes", "support"]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function titleToken(value: string): string {
  const token = value.toLowerCase();
  if (token === "splitting") return "split";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

export function normalizedSplitTitleTokens(title: string): string[] {
  return unique(title.toLowerCase().replace(/pi-todo/g, "pitodo").split(/[^a-z0-9]+/).map(titleToken).filter((token) => token.length > 1 && !TITLE_STOP_WORDS.has(token)));
}

export function splitTitlesAreTooSimilar(left: string, right: string): boolean {
  const leftTokens = normalizedSplitTitleTokens(left);
  const rightTokens = normalizedSplitTitleTokens(right);
  if (left.trim().toLowerCase() === right.trim().toLowerCase()) return true;
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const smaller = Math.min(leftSet.size, rightSet.size);
  const larger = Math.max(leftSet.size, rightSet.size);
  return overlap >= 2 && (overlap / smaller >= 0.8 || overlap / larger >= 0.7);
}

export function splitTitleSimilarityProblems(parentTitle: string, childTitles: string[]): string[] {
  const problems: string[] = [];
  childTitles.forEach((title, index) => {
    if (splitTitlesAreTooSimilar(parentTitle, title)) problems.push(`child title is too similar to parent: ${title}`);
    for (let prior = 0; prior < index; prior += 1) {
      if (splitTitlesAreTooSimilar(childTitles[prior], title)) problems.push(`child titles are too similar: ${childTitles[prior]} / ${title}`);
    }
  });
  return problems;
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

function childSuggestions(todo: Todo, count: number): SplitSuggestedChild[] {
  const scopedFiles = todo.scope.files.length ? todo.scope.files : todo.scope.paths;
  const inheritedScope = scopedFiles.length ? { files: todo.scope.files, paths: todo.scope.paths } : undefined;
  const candidates: SplitSuggestedChild[] = [
    { title: "Define split contract", description: "Describe the domain-level split decision and result shape.", acceptanceCriteria: ["The child has clear acceptance criteria and validation path"], scope: inheritedScope },
    { title: "Add data model fields", description: "Represent the metadata needed by the split decision.", acceptanceCriteria: ["The task model can represent the required metadata"], scope: inheritedScope },
    { title: "Enforce lifecycle guard", description: "Prevent direct work on container-style parent tasks.", acceptanceCriteria: ["The lifecycle enforces the child task's done condition"], scope: inheritedScope },
    { title: "Expose command path", description: "Surface split assessment behavior through the todo tool.", acceptanceCriteria: ["Users can invoke and inspect the behavior through the todo tool"], scope: inheritedScope },
    { title: "Verify regression cases", description: "Cover the expected atomic, split-required, too-vague, and epic paths.", acceptanceCriteria: ["Atomic, split-required, too-vague, and epic paths are covered"], scope: inheritedScope },
    { title: "Document rollout notes", description: "Capture review notes and follow-up behavior.", acceptanceCriteria: ["Reviewers can understand the split rationale and next action"], scope: inheritedScope },
  ].filter((candidate) => !splitTitlesAreTooSimilar(todo.title, candidate.title));
  return candidates.slice(0, Math.max(1, Math.min(count, candidates.length)));
}

function todoFromIntake(input: TodoIntakeInput): Todo {
  return {
    id: "__intake__",
    title: input.title.trim(),
    description: input.description,
    type: "task",
    status: "ready",
    priority: "normal",
    owner: null,
    activeClaimId: null,
    leaseExpiresAt: null,
    parentId: null,
    children: [],
    dependsOn: input.dependsOn ?? [],
    blocks: [],
    scope: emptyScope(input.scope),
    inputs: { goal: input.inputs?.goal, context: input.inputs?.context, environment: input.inputs?.environment, constraints: input.inputs?.constraints ?? [] },
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    definitionOfDone: input.definitionOfDone ?? [],
    requiredCapabilities: input.requiredCapabilities ?? [],
    createdAt: "",
    updatedAt: "",
    blockers: [],
    tags: input.tags ?? [],
    evidence: [],
    notes: [],
    revision: 0,
  };
}

function clarificationQuestions(input: TodoIntakeInput): string[] {
  const subject = input.title.trim() || "this todo";
  return [
    `What concrete outcome should ${subject} produce?`,
    "What acceptance criteria would make the work directly verifiable?",
    "Which files, component, or command path should the work touch?",
  ];
}

export function assessTodoIntake(input: TodoIntakeInput, policy: SplitPolicy = defaultSplitPolicy): TodoIntakeAssessment {
  const result = assessSplitPolicy(todoFromIntake(input), policy);
  if (result.assessment === "atomic") {
    return { ...result, organization: "todo", todo: { ...input, title: input.title.trim() }, clarificationQuestions: [] };
  }
  if (result.assessment === "too_vague") {
    return { ...result, organization: "clarify", suggestedChildren: [], clarificationQuestions: clarificationQuestions(input) };
  }
  return {
    ...result,
    organization: "container",
    parent: { ...input, title: input.title.trim(), workDirectlyAllowed: false },
    suggestedChildren: result.suggestedChildren,
    clarificationQuestions: [],
  };
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
