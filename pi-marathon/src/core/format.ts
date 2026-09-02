import type { DoctorResult, EventRecord, RunDetails, RunProgress, RunRecord, TaskRecord } from "./types.js";
import { truncate } from "./util.js";

const icon:Record<string,string>={queued:"○",planning:"◌",running:"▶",paused:"Ⅱ",waiting_for_human:"?",completed:"✓",passed:"✓",failed:"✗",blocked:"!",cancelled:"×",pending:"○",verifying:"◇"};
export const compactId=(id:string):string=>id.length>16?`${id.slice(0,7)}…${id.slice(-6)}`:id;
export function progressLine(progress:RunProgress):string{return `${progress.percent}% · ${progress.passed}/${progress.total} passed · ${progress.running+progress.verifying} active · ${progress.failed} failed · ${progress.blocked} blocked`;}
export function formatRun(run:RunRecord,progress?:RunProgress):string{
  const lines=[`${icon[run.status]??"•"} ${run.status.toUpperCase()} · ${compactId(run.id)} · phase ${run.phase}`,truncate(run.goal,500)];
  if(progress)lines.push(progressLine(progress));
  lines.push(`Agent calls: ${run.agentCalls}/${run.config.budget.maxAgentCalls} · Cost: $${run.costUsd.toFixed(4)}${run.config.budget.maxCostUsd===null?"":`/$${run.config.budget.maxCostUsd}`}`);
  if(run.workspace)lines.push(`Workspace: ${run.workspace.cwd}${run.workspace.branch?` · branch ${run.workspace.branch}`:""}`);
  if(run.summary)lines.push(`Summary: ${truncate(run.summary,1000)}`);if(run.lastError)lines.push(`Last error: ${truncate(run.lastError,1200)}`);
  return lines.join("\n");
}
export function formatRunList(runs:RunRecord[]):string{return runs.length?runs.map((run)=>`${icon[run.status]??"•"} ${compactId(run.id)}  ${run.status.padEnd(17)}  ${truncate(run.goal.replace(/\s+/g," "),90)}`).join("\n"):"No Marathon runs.";}
export function formatTasks(tasks:TaskRecord[]):string{return tasks.length?tasks.map((task)=>`${icon[task.status]??"•"} ${task.key.padEnd(24).slice(0,24)} ${task.status.padEnd(10)} [${task.type}] ${task.title}${task.attemptCount?` · attempts ${task.attemptCount}/${task.maxAttempts}`:""}${task.lastError?`\n    ${truncate(task.lastError.replace(/\s+/g," "),300)}`:""}`).join("\n"):"No tasks yet.";}
export function formatFailures(tasks:TaskRecord[]):string{const failed=tasks.filter((task)=>task.status==="failed"||task.status==="blocked"||task.lastError);return failed.length?failed.map((task)=>`${icon[task.status]??"!"} ${task.key} · ${task.status}\n${truncate(task.lastError??task.retryGuidance??"No diagnostic recorded",1500)}`).join("\n\n"):"No task failures recorded.";}
export function formatEvents(events:EventRecord[]):string{return events.length?events.map((event)=>`${event.seq} ${event.createdAt} ${event.type}${event.taskId?` (${compactId(event.taskId)})`:""}\n  ${truncate(JSON.stringify(event.payload),600)}`).join("\n"):"No events.";}
export function formatDetails(details:RunDetails):string{return `${formatRun(details.run,details.progress)}\n\nTASKS\n${formatTasks(details.tasks)}\n\nRECENT EVENTS\n${formatEvents(details.recentEvents.slice(-12))}`;}
function supportedNode(version:string):boolean{const [major=0,minor=0]=version.split(".").map(Number);return major>22||(major===22&&minor>=19);}
export function formatDoctor(result:DoctorResult):string{return [`Doctor: ${result.ok?"OK":"ATTENTION REQUIRED"}`,`Node: ${result.node} ${supportedNode(result.node)?"":"(Pi Marathon requires Node 22.19+)"}`,`SQLite: ${result.sqlite?"available":"unavailable"}`,`Git: ${result.git.available?result.git.version??"available":"unavailable"}`,`Models: ${result.models.available}${result.models.error?` · ${truncate(result.models.error,500)}`:""}`,`Project: ${result.projectCwd}`,`State: ${result.stateDir}`].join("\n");}
export const helpText=():string=>`Pi Marathon commands
/marathon <goal>                 Start a durable run
/marathon start <goal>           Start a durable run
/marathon status [run-id]        Show status and progress
/marathon list                   List recent runs
/marathon tasks [run-id]         Show task graph state
/marathon inspect [run-id]       Detailed status and event ledger
/marathon failures [run-id]      Show failure diagnostics
/marathon events [run-id]        Show the recent durable event ledger
/marathon pause [run-id]         Pause and abort active work safely
/marathon resume [run-id]        Resume a paused/blocked run
/marathon cancel [run-id]        Cancel a run (stop is an alias)
/marathon steer [run-id] <text>  Add guidance consumed by the next worker
/marathon budget [run-id] calls=160 minutes=900 cost=25 tasks=80 audits=4
/marathon doctor                 Validate runtime, Git, and model access
/marathon path                   Show durable state directory
/marathon shutdown               Stop this project's daemon`;
