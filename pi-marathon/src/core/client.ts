import { closeSync, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonInfoPath, daemonLockPath, daemonLogPath, defaultAgentDir, resolveProjectStateDir } from "./paths.js";
import type { BudgetPatchRequest } from "./protocol.js";
import type { DaemonInfo, DoctorResult, MarathonConfig, RunDetails, RunRecord, RuntimeModuleUrls } from "./types.js";
import { canonicalPath, ensureDir, errorMessage, readJsonFile } from "./util.js";

export interface ClientOptions { projectCwd:string; agentDir?:string; stateDir?:string; runtimeModules?:RuntimeModuleUrls }
export class MarathonHttpError extends Error { constructor(message:string,readonly status:number,readonly code?:string){super(message);this.name="MarathonHttpError";} }
const delay=(ms:number):Promise<void>=>new Promise((resolve)=>setTimeout(resolve,ms));
function pidAlive(pid:number):boolean{try{process.kill(pid,0);return pid>0;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}}
async function lockPid(stateDir:string):Promise<number|null>{try{const value=Number.parseInt((await readFile(daemonLockPath(stateDir),"utf8")).trim(),10);return Number.isInteger(value)&&value>0?value:null;}catch{return null;}}
async function requestJson<T>(url:string,options:RequestInit={},timeoutMs=5000):Promise<T>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const response=await fetch(url,{...options,signal:controller.signal,cache:"no-store"}),text=await response.text();let value:any;try{value=text?JSON.parse(text):null;}catch{throw new MarathonHttpError(`Invalid daemon response (${response.status})`,response.status);}if(!response.ok)throw new MarathonHttpError(value?.error??`Daemon request failed (${response.status})`,response.status,value?.code);return value as T;}finally{clearTimeout(timer);}
}
async function resolveOptions(input:ClientOptions):Promise<{projectCwd:string;agentDir:string;stateDir:string;runtimeModules?:RuntimeModuleUrls}>{const projectCwd=await canonicalPath(input.projectCwd),agentDir=path.resolve(input.agentDir??defaultAgentDir()),stateDir=path.resolve(input.stateDir??await resolveProjectStateDir(agentDir,projectCwd));return {projectCwd,agentDir,stateDir,runtimeModules:input.runtimeModules};}
async function ping(info:DaemonInfo):Promise<boolean>{try{const health=await requestJson<any>(`http://127.0.0.1:${info.port}/health`,{},1500);return health.ok&&health.pid===info.pid&&health.projectCwd===info.projectCwd;}catch{return false;}}
async function cleanDead(stateDir:string):Promise<void>{const info=await readJsonFile<DaemonInfo>(daemonInfoPath(stateDir)),pid=info?.pid??await lockPid(stateDir);if(pid&&pidAlive(pid))return;await Promise.all([rm(daemonInfoPath(stateDir),{force:true}),rm(daemonLockPath(stateDir),{force:true})]);}

export class MarathonClient {
  private constructor(readonly info:DaemonInfo,readonly projectCwd:string,readonly agentDir:string,readonly stateDir:string){}
  static async connectExisting(options:ClientOptions):Promise<MarathonClient|null>{const resolved=await resolveOptions(options),info=await readJsonFile<DaemonInfo>(daemonInfoPath(resolved.stateDir));if(!info||info.projectCwd!==resolved.projectCwd||info.stateDir!==resolved.stateDir||!await ping(info))return null;return new MarathonClient(info,resolved.projectCwd,resolved.agentDir,resolved.stateDir);}
  static async ensure(options:ClientOptions):Promise<MarathonClient>{
    const resolved=await resolveOptions(options);await ensureDir(resolved.stateDir);const existing=await this.connectExisting(resolved);if(existing)return existing;await cleanDead(resolved.stateDir);
    const live=await lockPid(resolved.stateDir);if(live&&pidAlive(live)){for(let i=0;i<30;i++){await delay(100);const client=await this.connectExisting(resolved);if(client)return client;}throw new Error(`Daemon PID ${live} is not responding. See ${daemonLogPath(resolved.stateDir)}`);}
    const entry=fileURLToPath(new URL("../bin/pi-marathond.js",import.meta.url)),args=[entry,"--cwd",resolved.projectCwd,"--agent-dir",resolved.agentDir,"--state-dir",resolved.stateDir];
    if(resolved.runtimeModules?.codingAgent)args.push("--coding-agent-module",resolved.runtimeModules.codingAgent);if(resolved.runtimeModules?.typebox)args.push("--typebox-module",resolved.runtimeModules.typebox);
    const log=daemonLogPath(resolved.stateDir),fd=openSync(log,"a",0o600);try{const child=spawn(process.execPath,args,{cwd:resolved.projectCwd,detached:true,stdio:["ignore",fd,fd],windowsHide:true,env:{...process.env,PI_AGENT_DIR:resolved.agentDir}});child.unref();}finally{closeSync(fd);}
    let reason="no daemon state file";for(let i=0;i<120;i++){await delay(100);const info=await readJsonFile<DaemonInfo>(daemonInfoPath(resolved.stateDir)).catch((error)=>{reason=errorMessage(error);return null;});if(info&&await ping(info))return new MarathonClient(info,resolved.projectCwd,resolved.agentDir,resolved.stateDir);if(info)reason=`health check failed for PID ${info.pid}`;}
    throw new Error(`Daemon failed to start (${reason}). See ${log}`);
  }
  private call<T>(route:string,options:RequestInit={},timeout=10_000):Promise<T>{return requestJson<T>(`http://127.0.0.1:${this.info.port}${route}`,{...options,headers:{authorization:`Bearer ${this.info.token}`,"content-type":"application/json",...(options.headers??{})}},timeout);}
  health():Promise<any>{return requestJson(`http://127.0.0.1:${this.info.port}/health`);}
  async createRun(goal:string,config?:Partial<MarathonConfig>):Promise<RunRecord>{return (await this.call<{run:RunRecord}>("/v1/runs",{method:"POST",body:JSON.stringify({goal,...(config?{config}:{})})})).run;}
  async listRuns(limit=20):Promise<RunRecord[]>{return (await this.call<{runs:RunRecord[]}>(`/v1/runs?limit=${encodeURIComponent(String(limit))}`)).runs;}
  async activeRun():Promise<RunRecord|null>{return (await this.call<{run:RunRecord|null}>("/v1/active")).run;}
  async getRun(id:string):Promise<RunDetails>{return (await this.call<{details:RunDetails}>(`/v1/runs/${encodeURIComponent(id)}`)).details;}
  async events(id:string,after=0,limit=100):Promise<RunDetails["recentEvents"]>{return (await this.call<{events:RunDetails["recentEvents"]}>(`/v1/runs/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`)).events;}
  async pause(id:string):Promise<RunRecord>{return (await this.call<{run:RunRecord}>(`/v1/runs/${encodeURIComponent(id)}/pause`,{method:"POST",body:"{}"})).run;}
  async resume(id:string):Promise<RunRecord>{return (await this.call<{run:RunRecord}>(`/v1/runs/${encodeURIComponent(id)}/resume`,{method:"POST",body:"{}"})).run;}
  async cancel(id:string):Promise<RunRecord>{return (await this.call<{run:RunRecord}>(`/v1/runs/${encodeURIComponent(id)}/cancel`,{method:"POST",body:"{}"})).run;}
  async steer(id:string,message:string):Promise<string>{return (await this.call<{steeringId:string}>(`/v1/runs/${encodeURIComponent(id)}/steer`,{method:"POST",body:JSON.stringify({message})})).steeringId;}
  async updateBudget(id:string,patch:BudgetPatchRequest):Promise<RunRecord>{return (await this.call<{run:RunRecord}>(`/v1/runs/${encodeURIComponent(id)}/budget`,{method:"POST",body:JSON.stringify(patch)})).run;}
  async doctor():Promise<DoctorResult>{return (await this.call<{doctor:DoctorResult}>("/v1/doctor",{},30_000)).doctor;}
  async shutdown():Promise<void>{await this.call("/v1/shutdown",{method:"POST",body:"{}"});}
}
