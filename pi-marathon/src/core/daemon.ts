import { timingSafeEqual } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { PiAgentRunner } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import { MarathonEngine } from "./engine.js";
import { daemonInfoPath, daemonLockPath, databasePath } from "./paths.js";
import type { BudgetPatchRequest, CreateRunRequest, SteeringRequest } from "./protocol.js";
import { MarathonStore } from "./store.js";
import type { DaemonInfo, DoctorResult, MarathonConfig, RuntimeModuleUrls } from "./types.js";
import { canonicalPath, ensureDir, errorMessage, nowIso, randomToken, writeJsonAtomic } from "./util.js";
import { VERSION } from "./version.js";
import { inspectGit } from "./workspace.js";

export interface DaemonOptions { projectCwd:string; agentDir:string; stateDir:string; host?:string; port?:number; runtimeModules?:RuntimeModuleUrls }
export interface RunningDaemon { info:DaemonInfo; server:http.Server; engine:MarathonEngine; store:MarathonStore; close():Promise<void> }
const MAX_BODY=1_048_576;
function pidAlive(pid:number):boolean{try{process.kill(pid,0);return pid>0;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}}
async function lockPid(file:string):Promise<number|null>{try{const value=Number.parseInt((await readFile(file,"utf8")).trim(),10);return Number.isInteger(value)&&value>0?value:null;}catch{return null;}}
async function lock(stateDir:string):Promise<string>{
  await ensureDir(stateDir);const file=daemonLockPath(stateDir);
  for(let attempt=0;attempt<2;attempt++){
    try{const fd=openSync(file,"wx",0o600);writeSync(fd,`${process.pid}\n`);closeSync(fd);return file;}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const pid=await lockPid(file);if(pid&&pidAlive(pid))throw new Error(`Daemon already running for this project (PID ${pid})`);await Promise.all([rm(file,{force:true}),rm(daemonInfoPath(stateDir),{force:true})]);}
  }
  throw new Error("Unable to acquire daemon lock");
}
function json(response:ServerResponse,status:number,value:unknown):void{const body=`${JSON.stringify(value)}\n`;response.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store","x-content-type-options":"nosniff"});response.end(body);}
function failure(response:ServerResponse,status:number,message:string,code="request_failed"):void{json(response,status,{error:message,code});}
async function body<T>(request:IncomingMessage):Promise<T>{const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const item=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=item.length;if(size>MAX_BODY)throw new Error("Request body is too large");chunks.push(item);}if(!chunks.length)return {} as T;try{return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;}catch{throw new Error("Request body must be valid JSON");}}
function auth(request:IncomingMessage,token:string):boolean{const header=request.headers.authorization;if(!header?.startsWith("Bearer "))return false;const a=Buffer.from(header.slice(7)),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);}
function budgetPatch(input:BudgetPatchRequest):Partial<MarathonConfig["budget"]>{
  const output:Partial<MarathonConfig["budget"]>={};
  for(const key of ["maxTasks","maxAgentCalls","maxRunMinutes","maxFinalAuditCycles"] as const){const value=input[key];if(value!==undefined){if(typeof value!=="number"||!Number.isFinite(value))throw new Error(`${key} must be finite`);output[key]=value;}}
  if(input.maxCostUsd!==undefined){if(input.maxCostUsd!==null&&(typeof input.maxCostUsd!=="number"||!Number.isFinite(input.maxCostUsd)))throw new Error("maxCostUsd must be finite or null");output.maxCostUsd=input.maxCostUsd;}
  return output;
}
const nodeOk=():boolean=>{const [major=0,minor=0]=process.versions.node.split(".").map(Number);return major>22||(major===22&&minor>=19);};

export async function startDaemon(options:DaemonOptions):Promise<RunningDaemon>{
  const projectCwd=await canonicalPath(options.projectCwd),agentDir=path.resolve(options.agentDir),stateDir=path.resolve(options.stateDir);
  const lockFile=await lock(stateDir),infoFile=daemonInfoPath(stateDir),startedAt=nowIso(),token=randomToken();let heartbeatAt=startedAt,closing=false,timer:NodeJS.Timeout|undefined;
  const store=new MarathonStore(databasePath(stateDir)),runner=new PiAgentRunner(agentDir,stateDir,options.runtimeModules),engine=new MarathonEngine(store,runner,stateDir),server=http.createServer();
  const close=async():Promise<void>=>{if(closing)return;closing=true;if(timer)clearInterval(timer);await engine.stop().catch(()=>undefined);await new Promise<void>((resolve)=>{if(!server.listening)return resolve();server.close(()=>resolve());server.closeIdleConnections?.();server.closeAllConnections?.();});store.close();await Promise.all([unlink(infoFile).catch(()=>undefined),unlink(lockFile).catch(()=>undefined)]);};
  server.on("request",async(request,response)=>{
    try{
      const url=new URL(request.url??"/",`http://${request.headers.host??"127.0.0.1"}`),method=request.method??"GET";
      if(method==="GET"&&url.pathname==="/health"){json(response,200,{ok:true,pid:process.pid,version:VERSION,projectCwd,startedAt,heartbeatAt});return;}
      if(!auth(request,token)){failure(response,401,"Unauthorized","unauthorized");return;}
      if(method==="GET"&&url.pathname==="/v1/runs"){const limit=Number.parseInt(url.searchParams.get("limit")??"20",10);json(response,200,{runs:store.listRuns(Number.isFinite(limit)?limit:20)});return;}
      if(method==="GET"&&url.pathname==="/v1/active"){json(response,200,{run:store.getActiveRun()});return;}
      if(method==="POST"&&url.pathname==="/v1/runs"){
        const input=await body<CreateRunRequest>(request),goal=typeof input.goal==="string"?input.goal.trim():"";if(!goal)throw new Error("goal is required");if(goal.length>50_000)throw new Error("goal is too long");
        const config=await loadConfig(projectCwd,agentDir,input.config);const run=store.createRun(projectCwd,goal,config);engine.wake();json(response,201,{run});return;
      }
      if(method==="GET"&&url.pathname==="/v1/doctor"){
        const config=await loadConfig(projectCwd,agentDir);const [git,models]=await Promise.all([inspectGit(projectCwd),runner.doctor(config)]);
        const doctor:DoctorResult={ok:nodeOk()&&models.available>0,node:process.versions.node,sqlite:true,git,models,stateDir,projectCwd};json(response,200,{doctor});return;
      }
      if(method==="POST"&&url.pathname==="/v1/shutdown"){json(response,202,{ok:true});setImmediate(()=>void close());return;}
      const match=/^\/v1\/runs\/([^/]+)(?:\/(events|pause|resume|cancel|steer|budget))?$/.exec(url.pathname);
      if(match){const id=decodeURIComponent(match[1]!),action=match[2];
        if(method==="GET"&&!action){const details=store.getRunDetails(id);if(!details){failure(response,404,`Run not found: ${id}`,"not_found");return;}json(response,200,{details});return;}
        if(method==="GET"&&action==="events"){if(!store.getRun(id)){failure(response,404,`Run not found: ${id}`,"not_found");return;}const after=Number.parseInt(url.searchParams.get("after")??"0",10),limit=Number.parseInt(url.searchParams.get("limit")??"100",10);json(response,200,{events:store.listEvents(id,Number.isFinite(after)?after:0,Number.isFinite(limit)?limit:100)});return;}
        if(method==="POST"&&action==="pause"){json(response,200,{run:engine.pause(id)});return;}
        if(method==="POST"&&action==="resume"){json(response,200,{run:engine.resume(id)});return;}
        if(method==="POST"&&action==="cancel"){json(response,200,{run:engine.cancel(id)});return;}
        if(method==="POST"&&action==="steer"){const input=await body<SteeringRequest>(request);json(response,202,{ok:true,steeringId:engine.steer(id,typeof input.message==="string"?input.message:"")});return;}
        if(method==="POST"&&action==="budget"){json(response,200,{run:engine.updateBudget(id,budgetPatch(await body<BudgetPatchRequest>(request)))});return;}
      }
      failure(response,404,"Not found","not_found");
    }catch(error){const message=error instanceof Error?error.message:String(error);failure(response,/not found/i.test(message)?404:400,message);}
  });
  server.on("clientError",(_error,socket)=>socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  try{
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??0,options.host??"127.0.0.1",()=>{server.off("error",reject);resolve();});});
    const address=server.address();if(!address||typeof address==="string")throw new Error("Daemon failed to bind a TCP port");
    const info:DaemonInfo={pid:process.pid,port:address.port,token,stateDir,projectCwd,startedAt,heartbeatAt,version:VERSION};await writeJsonAtomic(infoFile,info);
    timer=setInterval(()=>{heartbeatAt=nowIso();info.heartbeatAt=heartbeatAt;void writeJsonAtomic(infoFile,info).catch(()=>undefined);},10_000);engine.start();return {info,server,engine,store,close};
  }catch(error){store.close();await Promise.all([rm(infoFile,{force:true}),rm(lockFile,{force:true})]);throw error;}
}
