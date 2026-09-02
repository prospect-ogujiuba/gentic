import { MarathonClient, type ClientOptions } from "./client.js";
import { daemonLogPath, defaultAgentDir, resolveProjectStateDir } from "./paths.js";
import type { BudgetPatchRequest } from "./protocol.js";
import type { RunDetails, RunRecord, RuntimeModuleUrls } from "./types.js";
import { canonicalPath } from "./util.js";
import { formatDetails, formatDoctor, formatEvents, formatFailures, formatRun, formatRunList, formatTasks, helpText } from "./format.js";

export interface ControlOptions { projectCwd:string; agentDir?:string; runtimeModules?:RuntimeModuleUrls }
export interface ControlResult { text:string; run?:RunRecord; details?:RunDetails; data?:unknown }
export type ControlAction="help"|"start"|"status"|"list"|"tasks"|"inspect"|"failures"|"events"|"pause"|"resume"|"cancel"|"steer"|"budget"|"doctor"|"path"|"shutdown";
export interface ParsedControl { action:ControlAction; goal?:string; runId?:string; message?:string; budget?:BudgetPatchRequest }
const runLike=(value:string|undefined):boolean=>Boolean(value?.startsWith("run_"));
function split(input:string):string[]{return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item)=>item.replace(/^(["'])|(["'])$/g,""))??[];}
function budget(tokens:string[]):BudgetPatchRequest{
  const result:BudgetPatchRequest={};
  for(const token of tokens){const [rawKey,rawValue]=token.split("=",2);if(!rawKey||rawValue===undefined)continue;const key=rawKey.toLowerCase(),value=rawValue.toLowerCase()==="none"||rawValue.toLowerCase()==="null"?null:Number(rawValue);if(value!==null&&!Number.isFinite(value))throw new Error(`Invalid budget value: ${token}`);if(key==="calls")result.maxAgentCalls=value as number;else if(key==="minutes")result.maxRunMinutes=value as number;else if(key==="cost")result.maxCostUsd=value;else if(key==="tasks")result.maxTasks=value as number;else if(key==="audits")result.maxFinalAuditCycles=value as number;else throw new Error(`Unknown budget key: ${rawKey}`);}
  if(!Object.keys(result).length)throw new Error("Provide at least one budget value, such as calls=160");return result;
}
export function parseControl(input:string):ParsedControl{
  const value=input.trim();if(!value)return {action:"help"};const tokens=split(value),first=tokens[0]!.toLowerCase();
  const known=new Set(["help","start","status","list","tasks","inspect","failures","events","pause","resume","cancel","stop","steer","budget","doctor","path","shutdown"]);
  if(!known.has(first))return {action:"start",goal:value};if(first==="help")return {action:"help"};if(first==="start")return {action:"start",goal:value.slice(tokens[0]!.length).trim()};
  if(first==="list"||first==="doctor"||first==="path"||first==="shutdown")return {action:first as ControlAction};
  if(first==="steer"){
    const rest=tokens.slice(1);const runId=runLike(rest[0])?rest.shift():undefined;const message=rest.join(" ").replace(/^--\s*/,"");return {action:"steer",runId,message};
  }
  if(first==="budget"){
    const rest=tokens.slice(1);const runId=runLike(rest[0])?rest.shift():undefined;return {action:"budget",runId,budget:budget(rest)};
  }
  return {action:first==="stop"?"cancel":first as ControlAction,runId:tokens[1]};
}
async function existing(options:ControlOptions):Promise<MarathonClient>{return MarathonClient.ensure(options);}
async function id(client:MarathonClient,explicit?:string):Promise<string>{if(explicit)return explicit;const active=await client.activeRun();if(active)return active.id;const recent=await client.listRuns(1);if(recent[0])return recent[0].id;throw new Error("No Marathon run exists for this project.");}
export async function executeControl(options:ControlOptions,parsed:ParsedControl):Promise<ControlResult>{
  if(parsed.action==="help")return {text:helpText()};
  if(parsed.action==="path"){const cwd=await canonicalPath(options.projectCwd),agentDir=options.agentDir??defaultAgentDir(),state=await resolveProjectStateDir(agentDir,cwd);return {text:`State: ${state}\nLog: ${daemonLogPath(state)}`,data:{stateDir:state,log:daemonLogPath(state)}};}
  if(parsed.action==="start"){const goal=parsed.goal?.trim();if(!goal)throw new Error("A goal is required");const client=await MarathonClient.ensure(options),run=await client.createRun(goal);return {text:`Started ${run.id}\n${formatRun(run)}`,run};}
  if(parsed.action==="doctor"){const client=await MarathonClient.ensure(options),doctor=await client.doctor();return {text:formatDoctor(doctor),data:doctor};}
  const client=await existing(options);
  if(parsed.action==="list"){const runs=await client.listRuns();return {text:formatRunList(runs),data:runs};}
  if(parsed.action==="shutdown"){await client.shutdown();return {text:"Pi Marathon daemon shutdown requested."};}
  const runId=await id(client,parsed.runId);
  if(parsed.action==="status"){const details=await client.getRun(runId);return {text:formatRun(details.run,details.progress),run:details.run,details};}
  if(parsed.action==="tasks"){const details=await client.getRun(runId);return {text:formatTasks(details.tasks),run:details.run,details};}
  if(parsed.action==="inspect"){const details=await client.getRun(runId);return {text:formatDetails(details),run:details.run,details};}
  if(parsed.action==="failures"){const details=await client.getRun(runId);return {text:formatFailures(details.tasks),run:details.run,details};}
  if(parsed.action==="events"){const events=await client.events(runId);return {text:formatEvents(events),data:events};}
  if(parsed.action==="pause"){const run=await client.pause(runId);return {text:formatRun(run),run};}
  if(parsed.action==="resume"){const run=await client.resume(runId);return {text:formatRun(run),run};}
  if(parsed.action==="cancel"){const run=await client.cancel(runId);return {text:formatRun(run),run};}
  if(parsed.action==="steer"){if(!parsed.message?.trim())throw new Error("Steering text is required");const steeringId=await client.steer(runId,parsed.message);return {text:`Steering queued for ${runId}: ${steeringId}`,data:{steeringId}};}
  if(parsed.action==="budget"){const run=await client.updateBudget(runId,parsed.budget??{});return {text:`Budget updated.\n${formatRun(run)}`,run};}
  throw new Error(`Unsupported action: ${parsed.action}`);
}
export const clientOptions=(projectCwd:string,agentDir:string|undefined,runtimeModules:RuntimeModuleUrls|undefined):ClientOptions=>({projectCwd,...(agentDir?{agentDir}:{}),...(runtimeModules?{runtimeModules}:{})});
