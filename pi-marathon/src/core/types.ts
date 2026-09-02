export type RunStatus = "queued" | "planning" | "running" | "paused" | "waiting_for_human" | "completed" | "failed" | "cancelled";
export type RunPhase = "created" | "workspace" | "planning" | "execution" | "final_audit" | "complete";
export type TaskStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "blocked" | "cancelled";
export type TaskType = "research" | "implementation" | "test" | "documentation" | "review";
export type AttemptRole = "planner" | "worker" | "verifier" | "critic" | "auditor";
export type WorkspaceMode = "auto" | "worktree" | "copy" | "direct";
export type WorkspaceKind = Exclude<WorkspaceMode, "auto">;

export interface RoleModelConfig {
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface MarathonConfig {
  scheduler: { pollIntervalMs: number; maxConcurrency: number; maxResearchConcurrency: number; leaseSeconds: number };
  budget: { maxTasks: number; maxAgentCalls: number; maxRunMinutes: number; maxCostUsd: number | null; maxFinalAuditCycles: number };
  task: { maxAttempts: number; timeoutMinutes: number; criticAfterFailures: number };
  planner: { maxTasks: number };
  verification: { commands: string[]; commandTimeoutMs: number; requireAgentVerdict: boolean };
  workspace: { mode: WorkspaceMode; requireCleanGit: boolean; keepOnComplete: boolean };
  git: { commitPassedTasks: boolean; branchPrefix: string };
  models: Record<AttemptRole, RoleModelConfig>;
  safety: { allowNetwork: boolean; blockedCommandPatterns: string[]; allowedExternalPaths: string[] };
}

export interface WorkspaceRecord {
  kind: WorkspaceKind;
  root: string;
  cwd: string;
  branch?: string;
  baseRef?: string;
  repositoryRoot?: string;
}

export interface RunRecord {
  id: string;
  projectCwd: string;
  goal: string;
  status: RunStatus;
  phase: RunPhase;
  config: MarathonConfig;
  workspace: WorkspaceRecord | null;
  summary: string | null;
  currentTaskId: string | null;
  agentCalls: number;
  costUsd: number;
  finalAuditCycles: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  type: TaskType;
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: string[];
  verification: { commands: string[]; notes?: string[] };
  maxAttempts?: number;
}

export interface PlanOutput { summary: string; tasks: PlannedTask[] }

export interface TaskRecord extends Omit<PlannedTask, "dependsOn" | "maxAttempts"> {
  id: string;
  runId: string;
  parentId: string | null;
  ordinal: number;
  status: TaskStatus;
  dependencies: string[];
  maxAttempts: number;
  attemptCount: number;
  failureStreak: number;
  result: unknown;
  lastError: string | null;
  retryGuidance: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ChangeDescription { path: string; description: string }
export interface WorkerOutput {
  status: "completed" | "blocked";
  summary: string;
  changes: ChangeDescription[];
  commandsRun: string[];
  evidence: string[];
  blockers: string[];
  suggestedTasks: PlannedTask[];
}
export interface AcceptanceResult { criterion: string; passed: boolean; evidence: string }
export interface VerificationIssue { severity: "critical" | "major" | "minor"; description: string; evidence: string; recommendedFix: string }
export interface VerifierOutput {
  verdict: "pass" | "fail" | "blocked";
  summary: string;
  acceptance: AcceptanceResult[];
  issues: VerificationIssue[];
  retryGuidance: string;
  repairTasks: PlannedTask[];
}
export interface CriticOutput { diagnosis: string; failedAssumptions: string[]; newStrategy: string; concreteNextActions: string[] }
export interface FinalAuditOutput {
  verdict: "pass" | "fail" | "blocked";
  summary: string;
  goalSatisfied: boolean;
  evidence: string[];
  issues: VerificationIssue[];
  repairTasks: PlannedTask[];
}
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd: number;
  raw?: unknown;
}
export interface AgentRunResult<T> { output: T; usage: AgentUsage; sessionFile: string | null; assistantText: string }
export interface AttemptRecord {
  id: string; runId: string; taskId: string | null; role: AttemptRole; number: number;
  status: "running" | "completed" | "failed" | "aborted"; sessionFile: string | null;
  result: unknown; usage: AgentUsage | null; error: string | null; startedAt: string; completedAt: string | null;
}
export interface CommandResult {
  command: string; code: number | null; stdout: string; stderr: string; durationMs: number;
  timedOut: boolean; blocked: boolean; blockReason?: string;
}
export interface EventRecord { seq: number; runId: string | null; taskId: string | null; type: string; payload: unknown; createdAt: string }
export interface RunProgress { total: number; pending: number; running: number; verifying: number; passed: number; failed: number; blocked: number; cancelled: number; percent: number }
export interface RunDetails { run: RunRecord; tasks: TaskRecord[]; progress: RunProgress; recentEvents: EventRecord[] }
export interface DaemonInfo { pid: number; port: number; token: string; stateDir: string; projectCwd: string; startedAt: string; heartbeatAt: string; version: string }
export interface DoctorResult {
  ok: boolean; node: string; sqlite: boolean;
  git: { available: boolean; version?: string; repository?: string };
  models: { available: number; names: string[]; error?: string };
  stateDir: string; projectCwd: string;
}
export interface RuntimeModuleUrls { codingAgent?: string; typebox?: string }
