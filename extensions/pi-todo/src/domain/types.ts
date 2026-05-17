export type TodoStatus = "ready" | "claimed" | "in_progress" | "external_blocked" | "completed" | "verified" | "failed" | "cancelled" | "superseded";
export type CompatTodoStatus = "proposed" | "pending" | "done" | "needs_review" | "blocked" | "abandoned";
export type TodoStatusInput = TodoStatus | CompatTodoStatus;
export type TodoPriority = "low" | "normal" | "medium" | "high" | "critical" | "urgent";
export type ClaimStatus = "active" | "released";
export type SplitAssessment = "atomic" | "split_required" | "too_vague" | "epic";
export type SplitConfidence = "low" | "medium" | "high";
export type SplitPolicyMode = "advisory" | "required" | "strict" | "autonomous";
export type SplitPolicyDecision = "allow" | "warn" | "suggest_split" | "block_external";
export type TodoIntakeOrganization = "todo" | "container" | "clarify";

export type SplitPolicy = {
  mode: SplitPolicyMode;
  idealChildMin: number;
  idealChildMax: number;
  warnChildCount: number;
  maxChildCount: number;
  maxAcceptanceCriteria: number;
  maxTouchedAreas: number;
  maxEstimatedMinutes: number;
  requireChildrenForEpics: boolean;
  allowOverride: boolean;
};

export type SplitSuggestedChild = {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  scope?: Partial<TodoScope>;
  tags?: string[];
};

export type SplitCheckResult = {
  assessment: SplitAssessment;
  confidence: SplitConfidence;
  reasons: string[];
  recommendedChildCount: number;
  splitPolicySatisfied: boolean;
  policyDecision: SplitPolicyDecision;
  suggestedChildren: SplitSuggestedChild[];
};

export type TodoScope = {
  repo?: string;
  branch?: string;
  worktree?: string;
  paths: string[];
  files: string[];
  component?: string;
  service?: string;
  domain?: string;
  tools: string[];
  commands: string[];
  policyTags: string[];
};

export type TodoInputs = { goal?: string; context?: string; environment?: string; constraints: string[] };
export type TodoIntakeInput = {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  dependsOn?: string[];
  tags?: string[];
  scope?: Partial<TodoScope>;
  inputs?: { goal?: string; context?: string; environment?: string; constraints?: string[] };
  constraints?: string[];
  requiredCapabilities?: string[];
};
export type TodoIntakeContainerInput = TodoIntakeInput & { workDirectlyAllowed: false };
export type TodoIntakeAssessment = {
  assessment: SplitAssessment;
  confidence: SplitConfidence;
  organization: TodoIntakeOrganization;
  reasons: string[];
  recommendedChildCount: number;
  splitPolicySatisfied: boolean;
  todo?: TodoIntakeInput;
  parent?: TodoIntakeContainerInput;
  suggestedChildren: SplitSuggestedChild[];
  clarificationQuestions: string[];
};

export type EvidenceRef =
  | { type: "file_changed"; path: string; summary?: string }
  | { type: "test_result"; command: string; exitCode: number; outputSummary?: string }
  | { type: "user_confirmation"; message: string }
  | { type: "manual_note"; note: string }
  | { type: "generated_artifact"; path: string; summary: string; createdByTodoId: string; recordedAt?: string; detail?: string }
  | { type: "command_output" | "review" | "screenshot" | "log" | "artifact" | "note" | "file_change"; summary: string; detail?: string; files?: string[]; command?: string; output?: string; url?: string; recordedAt?: string; recordedBy?: string };

export type TodoClaim = {
  id: string;
  todoId: string;
  capabilities: string[];
  scope: TodoScope;
  status: ClaimStatus;
  claimedAt: string;
  lastHeartbeatAt?: string;
  leaseMs?: number;
  leaseExpiresAt?: string;
  owner?: string | null;
  releasedAt?: string;
  releaseReason?: string;
};

export type Todo = {
  id: string;
  title: string;
  description?: string;
  type?: string;
  status: TodoStatus;
  priority: TodoPriority;
  owner?: string | null;
  activeClaimId?: string | null;
  leaseExpiresAt?: string | null;
  parentId?: string | null;
  children: string[];
  dependsOn: string[];
  blocks: string[];
  scope: TodoScope;
  inputs: TodoInputs;
  constraints: string[];
  acceptanceCriteria: string[];
  definitionOfDone: string[];
  requiredCapabilities: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  externalBlocker?: string;
  blockers: string[];
  supersededBy?: string;
  splitAssessment?: SplitAssessment;
  splitAssessmentConfidence?: SplitConfidence;
  splitAssessmentReasons?: string[];
  splitPolicySatisfied?: boolean;
  splitCheckedAt?: string;
  splitOverrideReason?: string;
  workDirectlyAllowed?: boolean;
  tags: string[];
  evidence: EvidenceRef[];
  notes: string[];
  revision: number;
};

export type TodoState = { todos: Record<string, Todo>; order: string[]; claims: Record<string, TodoClaim>; events: TodoEvent[]; lastEventId?: string };

export type TodoEvent =
  | { id: string; type: "todo.created"; at: string; commandId?: string; todo: Todo }
  | { id: string; type: "todo.updated"; at: string; commandId?: string; todoId: string; patch: Partial<Todo> }
  | { id: string; type: "todo.split"; at: string; commandId?: string; todoId: string; children: Todo[]; reason: string }
  | { id: string; type: "todo.dependency_linked"; at: string; commandId?: string; todoId: string; dependencyTodoId: string }
  | { id: string; type: "todo.claimed"; at: string; commandId?: string; todoId: string; claim: TodoClaim }
  | { id: string; type: "todo.lease_renewed"; at: string; commandId?: string; todoId: string; claimId: string; leaseExpiresAt?: string }
  | { id: string; type: "todo.released"; at: string; commandId?: string; todoId: string; claimId?: string; reason?: string }
  | { id: string; type: "todo.claim_expired"; at: string; commandId?: string; todoId: string; claimId: string; reason?: string }
  | { id: string; type: "todo.started"; at: string; commandId?: string; todoId: string }
  | { id: string; type: "todo.external_blocked"; at: string; commandId?: string; todoId: string; reason: string }
  | { id: string; type: "todo.blocked"; at: string; commandId?: string; todoId: string; reason: string }
  | { id: string; type: "todo.unblocked"; at: string; commandId?: string; todoId: string }
  | { id: string; type: "todo.evidence_attached"; at: string; commandId?: string; todoId: string; evidence: EvidenceRef[] }
  | { id: string; type: "todo.completed"; at: string; commandId?: string; todoId: string; summary?: string; evidence: EvidenceRef[] }
  | { id: string; type: "todo.failed"; at: string; commandId?: string; todoId: string; reason?: string; evidence?: EvidenceRef[] }
  | { id: string; type: "todo.verified"; at: string; commandId?: string; todoId: string; evidence?: EvidenceRef[]; summary?: string }
  | { id: string; type: "todo.reopened"; at: string; commandId?: string; todoId: string; reason?: string; targetStatus?: TodoStatus }
  | { id: string; type: "todo.cancelled"; at: string; commandId?: string; todoId: string; reason?: string }
  | { id: string; type: "todo.superseded"; at: string; commandId?: string; todoId: string; supersededBy?: string; reason?: string }
  | { id: string; type: "todo.abandoned"; at: string; commandId?: string; todoId: string; reason?: string }
  | { id: string; type: "todo.note_added"; at: string; commandId?: string; todoId: string; note: string };

export type TodoPolicy = { requireEvidenceForDone: boolean; maxInProgress: number; globalMaxInProgress?: number; splitting?: SplitPolicy };

export function emptyScope(input: Partial<TodoScope> = {}): TodoScope {
  return { paths: input.paths ?? [], files: input.files ?? [], tools: input.tools ?? [], commands: input.commands ?? [], policyTags: input.policyTags ?? [], repo: input.repo, branch: input.branch, worktree: input.worktree, component: input.component, service: input.service, domain: input.domain };
}
