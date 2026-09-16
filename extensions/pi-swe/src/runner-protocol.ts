import type { RunnerRole } from "./workflow.ts";

export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const RUNNER_TOOL_NAMES = ["runner_read", "runner_edit", "runner_write", "runner_shell", "runner_report"] as const;
export type RunnerToolName = typeof RUNNER_TOOL_NAMES[number];

export type ChildRunConfig = {
  version: typeof RUNNER_PROTOCOL_VERSION;
  role: RunnerRole;
  cwd: string;
  agentDir: string;
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readScope: string[];
  writeScope: string[];
  tools: RunnerToolName[];
  packet: {
    contract: { hash: string; payload: unknown };
    snapshot?: { hash: string; payload: unknown };
    clarificationAnswers: Array<{ id: string; question: string; answer: string; answeredBy?: string; answeredAt?: string }>;
  };
};

export type RawRunnerFinding = { id?: string; severity: "blocking" | "warning"; status?: "open" | "resolved"; summary: string; evidence: string; disposition?: string };
export type RawRunnerReport = {
  outcome: "approved" | "changes-requested" | "needs-input" | "completed" | "no-change" | "failed";
  summary: string;
  rationale?: string;
  changedPaths?: string[];
  findings?: RawRunnerFinding[];
  questions?: string[];
};

export function toolsForRole(role: RunnerRole): RunnerToolName[] {
  return role === "implementer"
    ? ["runner_read", "runner_edit", "runner_write", "runner_shell", "runner_report"]
    : ["runner_read", "runner_report"];
}

export function reportKindForRole(role: RunnerRole): "plan-review" | "implementation" | "general-review" | "concern-review" | "final-acceptance" {
  if (role === "plan-reviewer") return "plan-review";
  if (role === "implementer") return "implementation";
  if (role === "general-reviewer") return "general-review";
  if (role === "concern-reviewer") return "concern-review";
  return "final-acceptance";
}
