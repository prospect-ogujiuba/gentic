import type { AttemptRecord, CommandResult, RunRecord, TaskRecord, WorkspaceRecord, WorkerOutput } from "./types.js";
import { truncate } from "./util.js";

const COMMON = `
You are one role inside Pi Marathon, a durable software-delivery system. The database, not chat history, is the source of truth.
Work only inside the supplied workspace. Never seek credentials, secret files, personal data, or unrelated host data. Do not weaken tests, delete evidence, fabricate command output, or declare success without proof. Use the designated finish tool exactly once as your final action. Keep the report factual and compact.
`;
export const PLANNER_SYSTEM_PROMPT = `${COMMON}\nYou are the planner. Inspect the repository, turn the objective into a finite dependency-aware task graph, and define independently testable acceptance criteria. Do not edit files.`;
export const WORKER_SYSTEM_PROMPT = `${COMMON}\nYou are an implementation worker. Complete only the assigned task, inspect before editing, run relevant checks, and report blockers honestly. You may edit only for implementation/test/documentation tasks; research and review tasks are read-only.`;
export const VERIFIER_SYSTEM_PROMPT = `${COMMON}\nYou are an independent verifier. Do not trust the worker report. Inspect the actual workspace, execute focused checks, map evidence to every acceptance criterion, and fail on missing proof or regressions. Do not edit files.`;
export const CRITIC_SYSTEM_PROMPT = `${COMMON}\nYou diagnose repeated failures. Identify the root cause and propose a materially different, concrete strategy. Do not edit files.`;
export const AUDITOR_SYSTEM_PROMPT = `${COMMON}\nYou are the final whole-project auditor. Verify the original objective end-to-end, inspect all changes and test evidence, identify regressions or missing integration, and create narrowly scoped repair tasks when needed. Do not edit files.`;

const json = (value: unknown): string => truncate(JSON.stringify(value, null, 2), 60_000);
const taskView = (task: TaskRecord): unknown => ({ key:task.key,title:task.title,description:task.description,type:task.type,dependencies:task.dependencies,acceptanceCriteria:task.acceptanceCriteria,verification:task.verification,attemptCount:task.attemptCount,maxAttempts:task.maxAttempts,lastError:task.lastError,retryGuidance:task.retryGuidance });

export function plannerPrompt(run: RunRecord, workspace: WorkspaceRecord, steering: string[]): string {
  return `ORIGINAL OBJECTIVE\n${run.goal}\n\nWORKSPACE\n${json(workspace)}\n\nCURRENT STEERING\n${json(steering)}\n\nCreate the smallest complete DAG that can demonstrably satisfy the objective. Include explicit integration and end-to-end verification. Respect the maximum of ${run.config.planner.maxTasks} tasks. Use finish_plan.`;
}
export function workerPrompt(input: { run: RunRecord; task: TaskRecord; dependencies: TaskRecord[]; attempts: AttemptRecord[]; steering: string[]; workspace: WorkspaceRecord }): string {
  return `ORIGINAL OBJECTIVE\n${input.run.goal}\n\nASSIGNED TASK\n${json(taskView(input.task))}\n\nDEPENDENCY RESULTS\n${json(input.dependencies.map((task)=>({key:task.key,title:task.title,result:task.result})))}\n\nPRIOR ATTEMPTS\n${json(input.attempts.map((attempt)=>({role:attempt.role,status:attempt.status,result:attempt.result,error:attempt.error})))}\n\nSTEERING\n${json(input.steering)}\n\nWORKSPACE\n${json(input.workspace)}\n\nComplete only this task. Run its required verification commands when feasible. If a genuine external decision or credential is required, return blocked. Otherwise fix the work before calling finish_task.`;
}
export function verifierPrompt(input: { run: RunRecord; task: TaskRecord; workerOutput: WorkerOutput; deterministicResults: CommandResult[]; workspace: WorkspaceRecord }): string {
  return `ORIGINAL OBJECTIVE\n${input.run.goal}\n\nTASK TO VERIFY\n${json(taskView(input.task))}\n\nWORKER CLAIMS\n${json(input.workerOutput)}\n\nDETERMINISTIC COMMAND RESULTS\n${json(input.deterministicResults)}\n\nWORKSPACE\n${json(input.workspace)}\n\nIndependently verify every acceptance criterion. A pass requires concrete evidence for all criteria and no critical/major unresolved issue. Use finish_verification.`;
}
export function criticPrompt(input: { run: RunRecord; task: TaskRecord; attempts: AttemptRecord[]; latestFailure: string }): string {
  return `OBJECTIVE\n${input.run.goal}\n\nFAILED TASK\n${json(taskView(input.task))}\n\nATTEMPT LEDGER\n${json(input.attempts)}\n\nLATEST FAILURE\n${input.latestFailure}\n\nExplain why the strategy failed and provide a meaningfully different next strategy. Use finish_critique.`;
}
export function auditorPrompt(input: { run: RunRecord; tasks: TaskRecord[]; workspace: WorkspaceRecord; workspaceDescription: string; deterministicResults: CommandResult[] }): string {
  return `ORIGINAL OBJECTIVE\n${input.run.goal}\n\nTASK LEDGER\n${json(input.tasks.map((task)=>({key:task.key,title:task.title,status:task.status,result:task.result})))}\n\nWORKSPACE\n${json(input.workspace)}\n\nCHANGE SUMMARY\n${input.workspaceDescription}\n\nFINAL DETERMINISTIC RESULTS\n${json(input.deterministicResults)}\n\nAudit the complete integrated result against the original objective. Use finish_audit. Pass only when goalSatisfied=true and evidence is sufficient. Otherwise provide executable repair tasks.`;
}
