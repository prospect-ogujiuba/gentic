import process from "node:process";
import type {
  AgentRunResult, AttemptRole, CommandResult, CriticOutput, FinalAuditOutput, MarathonConfig,
  PlanOutput, RunRecord, TaskRecord, VerifierOutput, WorkerOutput,
} from "./types.js";
import { MarathonStore } from "./store.js";
import {
  AUDITOR_SYSTEM_PROMPT, CRITIC_SYSTEM_PROMPT, PLANNER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT,
  auditorPrompt, criticPrompt, plannerPrompt, verifierPrompt, workerPrompt,
} from "./prompts.js";
import { normalizeRepairTasks } from "./normalize.js";
import { checkpointWorkspace, cleanupWorkspace, describeWorkspace, prepareWorkspace } from "./workspace.js";
import { deterministicFailureSummary, deterministicVerificationPassed, runVerificationCommands } from "./verification.js";
import { deepMerge, errorMessage, sleep } from "./util.js";
import { normalizeConfig } from "./config.js";

interface AgentRunnerLike {
  plan(request:any):Promise<AgentRunResult<PlanOutput>>;
  work(request:any):Promise<AgentRunResult<WorkerOutput>>;
  verify(request:any):Promise<AgentRunResult<VerifierOutput>>;
  critique(request:any):Promise<AgentRunResult<CriticOutput>>;
  audit(request:any):Promise<AgentRunResult<FinalAuditOutput>>;
}
interface Job { runId:string; controller:AbortController; promise:Promise<void> }
interface TaskJob extends Job { type:TaskRecord["type"] }
class BudgetExceededError extends Error { constructor(message:string){super(message);this.name="BudgetExceededError";} }
const readTask=(task:TaskRecord):boolean=>task.type==="research"||task.type==="review";
const shellTool=():"bash"|"powershell"=>process.platform==="win32"?"powershell":"bash";
const capabilities=(task:TaskRecord):{tools:string[];readOnly:boolean}=>readTask(task)?{tools:["read",shellTool(),"grep","find","ls"],readOnly:true}:{tools:["read",shellTool(),"edit","write","grep","find","ls"],readOnly:false};
function syntheticVerifier(task:TaskRecord,results:CommandResult[]):VerifierOutput{
  const pass=deterministicVerificationPassed(results);
  return {verdict:pass?"pass":"fail",summary:pass?"Configured verification commands passed.":"A configured verification command failed.",acceptance:task.acceptanceCriteria.map((criterion)=>({criterion,passed:pass,evidence:pass?"Accepted from deterministic checks because agent verdicts are disabled.":deterministicFailureSummary(results)})),issues:pass?[]:[{severity:"major",description:"Deterministic verification failed",evidence:deterministicFailureSummary(results),recommendedFix:"Correct the implementation and rerun the failing command."}],retryGuidance:pass?"":"Fix every failing verification command.",repairTasks:[]};
}
function allCriteriaPassed(task:TaskRecord,verifier:VerifierOutput):boolean{
  const entries=new Map(verifier.acceptance.map((item)=>[item.criterion.trim().toLowerCase(),item]));
  return task.acceptanceCriteria.every((criterion)=>entries.get(criterion.trim().toLowerCase())?.passed===true);
}

export class MarathonEngine {
  private stopped=true; private ticking=false; private loopPromise:Promise<void>|null=null;
  private readonly runJobs=new Map<string,Job>(); private readonly taskJobs=new Map<string,TaskJob>();
  constructor(readonly store:MarathonStore,readonly runner:AgentRunnerLike,readonly stateDir:string){}
  start():void{
    if(!this.stopped)return; this.stopped=false; const recovered=this.store.recoverStaleWork();
    if(recovered.tasks||recovered.attempts)this.store.addEvent(null,null,"daemon_recovered_work",recovered);
    this.loopPromise=this.loop();
  }
  async stop():Promise<void>{
    this.stopped=true; for(const job of [...this.runJobs.values(),...this.taskJobs.values()])job.controller.abort(new Error("Daemon stopping"));
    await Promise.allSettled([...this.runJobs.values(),...this.taskJobs.values()].map((job)=>job.promise)); await this.loopPromise?.catch(()=>undefined);
  }
  wake():void{if(!this.stopped)void this.tick();}
  private run(id:string):RunRecord{const run=this.store.getRun(id);if(!run)throw new Error(`Run not found: ${id}`);return run;}
  pause(id:string):RunRecord{const run=this.run(id);if(["completed","failed","cancelled"].includes(run.status))return run;this.store.setRunStatus(id,"paused",{summary:"Paused by user"});this.abort(id,"Run paused");return this.run(id);}
  resume(id:string):RunRecord{const run=this.run(id);if(!["paused","waiting_for_human"].includes(run.status))return run;this.store.setRunStatus(id,this.store.countTasks(id)?"running":"queued",{summary:"Resumed by user",error:null});this.wake();return this.run(id);}
  cancel(id:string):RunRecord{const run=this.run(id);if(["completed","failed","cancelled"].includes(run.status))return run;this.store.setRunStatus(id,"cancelled",{phase:"complete",summary:"Cancelled by user"});this.store.cancelOpenTasks(id);this.abort(id,"Run cancelled");return this.run(id);}
  steer(id:string,message:string):string{this.run(id);const value=message.trim();if(!value)throw new Error("Steering message cannot be empty");const steering=this.store.queueSteering(id,value);this.wake();return steering;}
  updateBudget(id:string,patch:Partial<MarathonConfig["budget"]>):RunRecord{const run=this.run(id);const config=normalizeConfig(deepMerge(structuredClone(run.config),{budget:patch}));this.store.updateRunConfig(id,config);return this.run(id);}
  private abort(runId:string,reason:string):void{this.runJobs.get(runId)?.controller.abort(new Error(reason));for(const job of this.taskJobs.values())if(job.runId===runId)job.controller.abort(new Error(reason));}
  private pollDelayMs():number{const runs=this.store.listExecutableRuns();return runs.length?Math.min(...runs.map((run)=>run.config.scheduler.pollIntervalMs)):750;}
  private async loop():Promise<void>{while(!this.stopped){await this.tick().catch((error)=>this.store.addEvent(null,null,"scheduler_error",{error:errorMessage(error)}));await sleep(this.pollDelayMs()).catch(()=>undefined);}}
  private async tick():Promise<void>{if(this.ticking||this.stopped)return;this.ticking=true;try{for(const run of this.store.listExecutableRuns())this.processRun(run);}finally{this.ticking=false;}}
  private processRun(snapshot:RunRecord):void{
    const run=this.store.getRun(snapshot.id);if(!run||!["queued","planning","running"].includes(run.status))return;
    const budget=this.budgetReason(run);if(budget){this.pauseForBudget(run,budget);return;}
    if((run.status==="queued"||run.status==="planning")&&!this.store.countTasks(run.id)){this.launchRunJob(run.id,(signal)=>this.initialize(run.id,signal));return;}
    if(run.status!=="running")return;
    if(run.phase==="final_audit"){if(!this.store.hasInFlightTasks(run.id))this.launchRunJob(run.id,(signal)=>this.finalAudit(run.id,signal));return;}
    this.store.markBlockedDependents(run.id);
    if(this.store.hasTerminalTaskFailure(run.id)){if(!this.store.hasInFlightTasks(run.id))this.store.setRunStatus(run.id,"failed",{phase:"complete",summary:"One or more tasks failed or were blocked.",error:"Task graph did not complete"});return;}
    if(this.store.allTasksPassed(run.id)){if(!this.store.hasInFlightTasks(run.id)){this.store.setRunPhase(run.id,"final_audit");this.wake();}return;}
    this.schedule(run);
  }
  private schedule(run:RunRecord):void{
    const allJobs=[...this.taskJobs.values()];const globalSlots=Math.max(0,run.config.scheduler.maxConcurrency-allJobs.length);if(!globalSlots)return;
    const ownJobs=allJobs.filter((job)=>job.runId===run.id);const ready=this.store.getReadyTasks(run.id,Math.max(10,globalSlots*3));if(!ready.length)return;
    const readJobs=ownJobs.filter((job)=>job.type==="research"||job.type==="review");const writerJob=ownJobs.some((job)=>job.type!=="research"&&job.type!=="review");
    const readyReads=ready.filter(readTask);
    if(readyReads.length&&!writerJob){const slots=Math.min(globalSlots,Math.max(0,run.config.scheduler.maxResearchConcurrency-readJobs.length));for(const task of readyReads.slice(0,slots))this.launchTask(run,task);return;}
    if(readJobs.length||writerJob)return;const writer=ready.find((task)=>!readTask(task));if(writer)this.launchTask(run,writer);
  }
  private launchRunJob(runId:string,work:(signal:AbortSignal)=>Promise<void>):void{
    if(this.runJobs.has(runId))return;const controller=new AbortController();
    const promise=work(controller.signal).catch(async(error)=>{
      const run=this.store.getRun(runId);if(!run||["paused","waiting_for_human","cancelled"].includes(run.status))return;
      if(error instanceof BudgetExceededError){this.pauseForBudget(run,error.message);return;}
      this.store.setRunStatus(runId,"failed",{phase:"complete",summary:"Run operation failed",error:errorMessage(error)});
      if(run.workspace)await cleanupWorkspace(run.workspace,run.config.workspace.keepOnComplete).catch(()=>undefined);
    }).finally(()=>{this.runJobs.delete(runId);this.wake();});
    this.runJobs.set(runId,{runId,controller,promise});
  }
  private launchTask(run:RunRecord,task:TaskRecord):void{
    if(this.taskJobs.has(task.id))return;const worker=`daemon-${process.pid}`;const claimed=this.store.claimTask(task.id,worker,run.config.scheduler.leaseSeconds);if(!claimed)return;
    const controller=new AbortController();const promise=this.processTask(run.id,claimed.id,worker,controller.signal).catch((error)=>{this.store.addEvent(run.id,claimed.id,"task_job_error",{error:errorMessage(error)});}).finally(()=>{this.taskJobs.delete(claimed.id);const latest=this.store.getRun(run.id);if(latest?.currentTaskId===claimed.id)this.store.setCurrentTask(run.id,null);this.wake();});
    this.taskJobs.set(claimed.id,{runId:run.id,type:claimed.type,controller,promise});
  }
  private async initialize(runId:string,signal:AbortSignal):Promise<void>{
    let run=this.run(runId);this.store.setRunStatus(runId,"planning",{phase:"workspace",summary:"Preparing isolated workspace"});
    let workspace=run.workspace;if(!workspace){workspace=await prepareWorkspace(run,this.stateDir,run.config);this.store.setRunWorkspace(runId,workspace);}
    run=this.run(runId);this.store.setRunPhase(runId,"planning");const steering=this.store.consumePendingSteering(runId);
    let plan:PlanOutput|null=null,lastError="";
    for(let number=1;number<=2&&!plan;number++){
      try{plan=(await this.invoke<PlanOutput>(run,null,"planner",number,(attempt)=>this.runner.plan({cwd:workspace!.cwd,runId,attemptId:attempt.id,systemPrompt:PLANNER_SYSTEM_PROMPT,prompt:plannerPrompt(run,workspace!,steering),config:run.config,model:run.config.models.planner,timeoutMs:run.config.task.timeoutMinutes*60_000,readOnly:true,tools:["read","grep","find","ls"],signal}))).output;}
      catch(error){lastError=errorMessage(error);if(signal.aborted)throw error;}
    }
    if(!plan)throw new Error(`Planning failed after two attempts: ${lastError}`);
    if(plan.tasks.length>run.config.budget.maxTasks)throw new Error(`Plan has ${plan.tasks.length} tasks but budget allows ${run.config.budget.maxTasks}`);
    this.store.addPlan(runId,plan,run.config.task.maxAttempts);this.store.setRunStatus(runId,"running",{phase:"execution",summary:plan.summary,error:null});
  }
  private async processTask(runId:string,taskId:string,workerId:string,signal:AbortSignal):Promise<void>{
    const run=this.run(runId),task=this.store.getTask(taskId);if(!task||!run.workspace)return;this.store.setCurrentTask(runId,taskId);
    const timer=setInterval(()=>this.store.renewTaskLease(taskId,workerId,run.config.scheduler.leaseSeconds),Math.max(10_000,Math.floor(run.config.scheduler.leaseSeconds*1000/3)));
    try{
      const dependencies=this.store.getDependencyTasks(taskId),attempts=this.store.listTaskAttempts(taskId),steering=this.store.consumePendingSteering(runId),caps=capabilities(task);
      const worker=(await this.invoke<WorkerOutput>(run,task,"worker",task.attemptCount,(attempt)=>this.runner.work({cwd:run.workspace!.cwd,runId,attemptId:attempt.id,systemPrompt:WORKER_SYSTEM_PROMPT,prompt:workerPrompt({run,task,dependencies,attempts,steering,workspace:run.workspace!}),config:run.config,model:run.config.models.worker,timeoutMs:run.config.task.timeoutMinutes*60_000,readOnly:caps.readOnly,tools:caps.tools,signal}))).output;
      if(worker.suggestedTasks.length)this.store.addEvent(runId,taskId,"worker_suggested_tasks",{tasks:worker.suggestedTasks});
      if(worker.status==="blocked"){const reason=worker.blockers.join("; ")||worker.summary;this.store.releaseTask(taskId,reason);this.store.setRunStatus(runId,"waiting_for_human",{phase:"execution",summary:`Waiting for input on ${task.key}: ${reason}`,error:reason});return;}
      this.store.markTaskVerifying(taskId,worker);
      const commands=await runVerificationCommands({workspace:run.workspace,config:run.config,task,signal});
      let verifier:VerifierOutput;
      if(run.config.verification.requireAgentVerdict)verifier=(await this.invoke<VerifierOutput>(run,task,"verifier",task.attemptCount,(attempt)=>this.runner.verify({cwd:run.workspace!.cwd,runId,attemptId:attempt.id,systemPrompt:VERIFIER_SYSTEM_PROMPT,prompt:verifierPrompt({run,task,workerOutput:worker,deterministicResults:commands,workspace:run.workspace!}),config:run.config,model:run.config.models.verifier,timeoutMs:run.config.task.timeoutMinutes*60_000,readOnly:true,tools:["read",shellTool(),"grep","find","ls"],signal}))).output;
      else verifier=syntheticVerifier(task,commands);
      if(verifier.verdict==="blocked"){const reason=verifier.summary||"Verifier is blocked";this.store.releaseTask(taskId,reason);this.store.setRunStatus(runId,"waiting_for_human",{phase:"execution",summary:`Verification blocked for ${task.key}: ${reason}`,error:reason});return;}
      const commandsPass=deterministicVerificationPassed(commands),criteriaPass=allCriteriaPassed(task,verifier);
      if(!commandsPass){verifier={...verifier,verdict:"fail",summary:`${verifier.summary}\nDeterministic verification failed.`,retryGuidance:[verifier.retryGuidance,deterministicFailureSummary(commands)].filter(Boolean).join("\n\n"),issues:[...verifier.issues,{severity:"major",description:"Required verification command failed",evidence:deterministicFailureSummary(commands),recommendedFix:"Fix the root cause and rerun the exact command."}]};}
      if(verifier.verdict==="pass"&&commandsPass&&criteriaPass){const checkpoint=await checkpointWorkspace(run.workspace,task,run.config);this.store.markTaskPassed(taskId,worker,verifier);this.store.addCheckpoint(runId,taskId,checkpoint.ref,verifier.summary,checkpoint.metadata);return;}
      if(!criteriaPass&&verifier.verdict==="pass")verifier={...verifier,verdict:"fail",summary:`${verifier.summary}\nNot every acceptance criterion was proved.`,retryGuidance:verifier.retryGuidance||"Provide evidence for every exact acceptance criterion."};
      await this.retryOrFail(runId,taskId,verifier.summary,verifier.retryGuidance,signal);
    }catch(error){
      const latest=this.store.getRun(runId);if(!latest||latest.status==="cancelled")return;
      if(["paused","waiting_for_human"].includes(latest.status)){this.store.releaseTask(taskId,`Interrupted: ${errorMessage(error)}`);return;}
      if(error instanceof BudgetExceededError){this.store.releaseTask(taskId,error.message);this.pauseForBudget(latest,error.message);return;}
      await this.retryOrFail(runId,taskId,errorMessage(error),"Review the evidence and use a different approach.",signal);
    }finally{clearInterval(timer);}
  }
  private async retryOrFail(runId:string,taskId:string,error:string,guidance:string,signal:AbortSignal):Promise<void>{
    const run=this.run(runId),task=this.store.getTask(taskId);if(!task)return;
    if(task.attemptCount>=task.maxAttempts){this.store.markTaskFailed(taskId,error);return;}
    let next=guidance||"Correct the verified failure before declaring completion.";
    if(task.failureStreak+1>=run.config.task.criticAfterFailures){
      try{const attempts=this.store.listTaskAttempts(taskId);const critic=(await this.invoke<CriticOutput>(run,task,"critic",task.attemptCount,(attempt)=>this.runner.critique({cwd:run.workspace!.cwd,runId,attemptId:attempt.id,systemPrompt:CRITIC_SYSTEM_PROMPT,prompt:criticPrompt({run,task,attempts,latestFailure:error}),config:run.config,model:run.config.models.critic,timeoutMs:Math.min(run.config.task.timeoutMinutes*60_000,20*60_000),readOnly:true,tools:["read","grep","find","ls"],signal}))).output;next=`${next}\n\nCRITIC DIAGNOSIS\n${critic.diagnosis}\n\nNEW STRATEGY\n${critic.newStrategy}\n\nNEXT ACTIONS\n${critic.concreteNextActions.join("\n")}`;}
      catch(criticError){if(criticError instanceof BudgetExceededError)throw criticError;this.store.addEvent(runId,taskId,"critic_failed",{error:errorMessage(criticError)});}
    }
    this.store.markTaskRetry(taskId,error,next);
  }
  private async finalAudit(runId:string,signal:AbortSignal):Promise<void>{
    const run=this.run(runId);if(!run.workspace)throw new Error("Run has no workspace");if(!this.store.allTasksPassed(runId)){this.store.setRunPhase(runId,"execution");return;}
    const cycle=this.store.incrementFinalAuditCycle(runId),tasks=this.store.listTasks(runId);
    const commands=await runVerificationCommands({workspace:run.workspace,config:run.config,finalAudit:true,signal});
    const description=await describeWorkspace(run.workspace);
    const audit=(await this.invoke<FinalAuditOutput>(run,null,"auditor",cycle,(attempt)=>this.runner.audit({cwd:run.workspace!.cwd,runId,attemptId:attempt.id,systemPrompt:AUDITOR_SYSTEM_PROMPT,prompt:auditorPrompt({run,tasks,workspace:run.workspace!,workspaceDescription:description,deterministicResults:commands}),config:run.config,model:run.config.models.auditor,timeoutMs:run.config.task.timeoutMinutes*60_000,readOnly:true,tools:["read",shellTool(),"grep","find","ls"],signal}))).output;
    if(audit.verdict==="blocked"){this.store.setRunStatus(runId,"waiting_for_human",{phase:"final_audit",summary:audit.summary,error:audit.summary});return;}
    const pass=deterministicVerificationPassed(commands)&&audit.verdict==="pass"&&audit.goalSatisfied;
    if(pass){const checkpoint=await checkpointWorkspace(run.workspace,null,run.config);this.store.addCheckpoint(runId,null,checkpoint.ref,audit.summary,checkpoint.metadata);this.store.setRunStatus(runId,"completed",{phase:"complete",summary:audit.summary,error:null});await cleanupWorkspace(run.workspace,run.config.workspace.keepOnComplete);return;}
    const remaining=Math.max(0,run.config.budget.maxTasks-tasks.length);
    if(cycle<run.config.budget.maxFinalAuditCycles&&remaining>0&&audit.repairTasks.length){const normalized=normalizeRepairTasks(audit.repairTasks,new Set(tasks.map((task)=>task.key)),remaining);if(normalized.length){this.store.addRepairTasks(runId,normalized,run.config.task.maxAttempts,cycle);this.store.setRunStatus(runId,"running",{phase:"execution",summary:`Final audit requested ${normalized.length} repair task(s).`,error:audit.summary});return;}}
    const deterministic=deterministicFailureSummary(commands);this.store.setRunStatus(runId,"failed",{phase:"complete",summary:audit.summary,error:[audit.summary,deterministic].filter(Boolean).join("\n\n")});
  }
  private async invoke<T>(run:RunRecord,task:TaskRecord|null,role:AttemptRole,number:number,call:(attempt:{id:string})=>Promise<AgentRunResult<T>>):Promise<AgentRunResult<T>>{
    const latest=this.run(run.id),reason=this.budgetReason(latest);if(reason)throw new BudgetExceededError(reason);
    const attempt=this.store.createAttempt(run.id,task?.id??null,role,number);
    try{const result=await call(attempt);this.store.setAttemptSession(attempt.id,result.sessionFile);this.store.finishAttempt(attempt.id,"completed",result.output,result.usage,null);this.store.recordAgentCost(run.id,result.usage);return result;}
    catch(error){this.store.finishAttempt(attempt.id,"failed",null,null,errorMessage(error));throw error;}
  }
  private budgetReason(run:RunRecord):string|null{
    if(this.store.countTasks(run.id)>run.config.budget.maxTasks)return `Task budget exceeded (${run.config.budget.maxTasks})`;
    if(run.agentCalls>=run.config.budget.maxAgentCalls)return `Agent-call budget reached (${run.config.budget.maxAgentCalls})`;
    if(run.config.budget.maxCostUsd!==null&&run.costUsd>=run.config.budget.maxCostUsd)return `Cost budget reached ($${run.config.budget.maxCostUsd})`;
    const start=run.startedAt??run.createdAt;if(Date.now()-Date.parse(start)>=run.config.budget.maxRunMinutes*60_000)return `Run-time budget reached (${run.config.budget.maxRunMinutes} minutes)`;
    return null;
  }
  private pauseForBudget(run:RunRecord,reason:string):void{if(["completed","failed","cancelled","paused"].includes(run.status))return;this.store.setRunStatus(run.id,"paused",{summary:`Budget pause: ${reason}`,error:reason});this.abort(run.id,reason);}
}
