import path from "node:path";
import type {
  AgentRunResult, AgentUsage, AttemptRole, CriticOutput, FinalAuditOutput, MarathonConfig,
  PlanOutput, RoleModelConfig, RuntimeModuleUrls, VerifierOutput, WorkerOutput,
} from "./types.js";
import { normalizeCriticOutput, normalizeFinalAuditOutput, normalizePlan, normalizeVerifierOutput, normalizeWorkerOutput } from "./normalize.js";
import { CommandPolicy } from "./policy.js";
import { ensureDir, errorMessage, truncate } from "./util.js";

type RuntimeDeps = { sdk: any; Type: any };

function completionTool(deps: RuntimeDeps, role: AttemptRole, capture: (value: unknown) => void): any {
  const { Type } = deps; const { defineTool } = deps.sdk;
  const taskType = Type.Union(["research","implementation","test","documentation","review"].map((value:string)=>Type.Literal(value)));
  const plannedTask = Type.Object({
    key:Type.String(), title:Type.String(), description:Type.String(), type:taskType,
    priority:Type.Number({minimum:0,maximum:100}), dependsOn:Type.Array(Type.String()),
    acceptanceCriteria:Type.Array(Type.String(),{minItems:1}),
    verification:Type.Object({commands:Type.Array(Type.String()),notes:Type.Optional(Type.Array(Type.String()))}),
    maxAttempts:Type.Optional(Type.Integer({minimum:1,maximum:20})),
  });
  const issue = Type.Object({
    severity:Type.Union([Type.Literal("critical"),Type.Literal("major"),Type.Literal("minor")]),
    description:Type.String(), evidence:Type.String(), recommendedFix:Type.String(),
  });
  const finish = (name:string,label:string,description:string,parameters:any) => defineTool({
    name,label,description,parameters,
    async execute(_id:string,params:unknown){ capture(params); return {content:[{type:"text",text:`${label} captured.`}],details:params,terminate:true}; },
  });
  if(role==="planner") return finish("finish_plan","Finish Plan","Submit the final dependency-aware plan as your last action.",Type.Object({summary:Type.String(),tasks:Type.Array(plannedTask,{minItems:1})}));
  if(role==="worker") return finish("finish_task","Finish Task","Submit the honest final task report as your last action.",Type.Object({
    status:Type.Union([Type.Literal("completed"),Type.Literal("blocked")]),summary:Type.String(),
    changes:Type.Array(Type.Object({path:Type.String(),description:Type.String()})),commandsRun:Type.Array(Type.String()),
    evidence:Type.Array(Type.String()),blockers:Type.Array(Type.String()),suggestedTasks:Type.Array(plannedTask),
  }));
  if(role==="verifier") return finish("finish_verification","Finish Verification","Submit the independent verdict as your last action.",Type.Object({
    verdict:Type.Union([Type.Literal("pass"),Type.Literal("fail"),Type.Literal("blocked")]),summary:Type.String(),
    acceptance:Type.Array(Type.Object({criterion:Type.String(),passed:Type.Boolean(),evidence:Type.String()})),
    issues:Type.Array(issue),retryGuidance:Type.String(),repairTasks:Type.Array(plannedTask),
  }));
  if(role==="critic") return finish("finish_critique","Finish Critique","Submit the failure diagnosis and materially different strategy.",Type.Object({
    diagnosis:Type.String(),failedAssumptions:Type.Array(Type.String()),newStrategy:Type.String(),concreteNextActions:Type.Array(Type.String()),
  }));
  return finish("finish_audit","Finish Audit","Submit the whole-project final audit as your last action.",Type.Object({
    verdict:Type.Union([Type.Literal("pass"),Type.Literal("fail"),Type.Literal("blocked")]),summary:Type.String(),
    goalSatisfied:Type.Boolean(),evidence:Type.Array(Type.String()),issues:Type.Array(issue),repairTasks:Type.Array(plannedTask),
  }));
}

function completionName(role: AttemptRole): string {
  return role === "planner" ? "finish_plan" : role === "worker" ? "finish_task" : role === "verifier" ? "finish_verification" : role === "critic" ? "finish_critique" : "finish_audit";
}
function mutating(command:string):boolean {
  return /(?:^|[;&|\s])(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|truncate|dd|tee|patch|apply_patch)(?:\s|$)|(?:^|[;&|\s])git\s+(?:add|commit|checkout|switch|reset|clean|restore|rebase|merge|cherry-pick)(?:\s|$)|sed\s+-i|perl\s+-pi|(?:>|>>)/i.test(command);
}
function safetyExtension(policy:CommandPolicy,readOnly:boolean):(pi:any)=>void {
  return (pi:any):void => {
    pi.on("tool_call",(event:any)=>{
      const input=event.input??{};
      if(event.toolName==="bash"||event.toolName==="powershell"){
        const command=String(input.command??""); const decision=policy.checkCommand(command);
        if(!decision.allowed)return {block:true,reason:decision.reason,terminate:true};
        if(readOnly&&mutating(command))return {block:true,reason:"This agent role is read-only",terminate:true};
      }
      if(event.toolName==="write"||event.toolName==="edit"){
        if(readOnly)return {block:true,reason:"This agent role is read-only",terminate:true};
        const decision=policy.checkPath(String(input.path??input.filePath??input.file_path??""),"write");
        if(!decision.allowed)return {block:true,reason:decision.reason,terminate:true};
      }
      if(event.toolName==="read"){
        const decision=policy.checkPath(String(input.path??input.filePath??input.file_path??""),"read");
        if(!decision.allowed)return {block:true,reason:decision.reason,terminate:true};
      }
      return undefined;
    });
  };
}
function fallbackJson(value:string):unknown {
  const candidates:string[]=[];
  for(const match of value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))if(match[1])candidates.push(match[1].trim());
  const first=value.indexOf("{"),last=value.lastIndexOf("}"); if(first>=0&&last>first)candidates.push(value.slice(first,last+1));
  for(const item of candidates.reverse())try{return JSON.parse(item);}catch{}
  return null;
}
const number = (value:unknown):number => typeof value==="number"&&Number.isFinite(value)?value:0;
function usage(messages:unknown[]):AgentUsage {
  let inputTokens=0,outputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,totalTokens=0,costUsd=0; const raw:unknown[]=[];
  for(const message of messages){
    if(!message||typeof message!=="object")continue; const row=message as Record<string,unknown>;
    if(row.role!=="assistant"||!row.usage||typeof row.usage!=="object")continue; const item=row.usage as Record<string,unknown>; raw.push(item);
    inputTokens+=number(item.input??item.inputTokens); outputTokens+=number(item.output??item.outputTokens);
    cacheReadTokens+=number(item.cacheRead??item.cacheReadTokens); cacheWriteTokens+=number(item.cacheWrite??item.cacheWriteTokens);
    totalTokens+=number(item.totalTokens);
    if(typeof item.costUsd==="number")costUsd+=item.costUsd;
    else if(typeof item.cost==="number")costUsd+=item.cost;
    else if(item.cost&&typeof item.cost==="object")costUsd+=number((item.cost as Record<string,unknown>).total??(item.cost as Record<string,unknown>).totalCost??(item.cost as Record<string,unknown>).usd);
  }
  if(!totalTokens)totalTokens=inputTokens+outputTokens+cacheReadTokens+cacheWriteTokens;
  return {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costUsd,raw};
}

export interface StructuredAgentRequest {
  role:AttemptRole; cwd:string; runId:string; attemptId:string; systemPrompt:string; prompt:string;
  config:MarathonConfig; model:RoleModelConfig; timeoutMs:number; readOnly:boolean; tools:string[]; signal?:AbortSignal;
}

export class PiAgentRunner {
  private depsPromise:Promise<RuntimeDeps>|null=null;
  private modelRuntimePromise:Promise<any>|null=null;
  constructor(private readonly agentDir:string,private readonly stateDir:string,private readonly modules:RuntimeModuleUrls={}){}
  private getDeps():Promise<RuntimeDeps>{
    if(!this.depsPromise)this.depsPromise=Promise.all([
      import(this.modules.codingAgent??"@earendil-works/pi-coding-agent"),
      import(this.modules.typebox??"typebox"),
    ]).then(([sdk,typebox])=>({sdk,Type:(typebox as any).Type}));
    return this.depsPromise;
  }
  private async modelRuntime(config:MarathonConfig):Promise<any>{
    if(!this.modelRuntimePromise){ const {sdk}=await this.getDeps(); this.modelRuntimePromise=sdk.ModelRuntime.create({
      authPath:path.join(this.agentDir,"auth.json"),modelsPath:path.join(this.agentDir,"models.json"),
      allowModelNetwork:config.safety.allowNetwork,modelRefreshTimeoutMs:15_000,
    }); }
    return this.modelRuntimePromise;
  }
  async doctor(config:MarathonConfig):Promise<{available:number;names:string[];error?:string}>{
    try{ const runtime=await this.modelRuntime(config); const models=await runtime.getAvailable(); return {available:models.length,names:models.map((model:any)=>`${model.provider}/${model.id}`)}; }
    catch(error){return {available:0,names:[],error:errorMessage(error)};}
  }
  async runStructured<T>(request:StructuredAgentRequest):Promise<AgentRunResult<T>>{
    if(request.signal?.aborted)throw request.signal.reason??new Error("Aborted");
    const deps=await this.getDeps(); const {sdk}=deps;
    await ensureDir(path.join(this.stateDir,"sessions",request.runId,request.role));
    const modelRuntime=await this.modelRuntime(request.config);
    const settingsManager=sdk.SettingsManager.create(request.cwd,this.agentDir,{projectTrusted:false});
    const policy=new CommandPolicy(request.cwd,request.config.safety); let captured:unknown=null;
    const outputTool=completionTool(deps,request.role,(value)=>{captured=value;});
    const resourceLoader=new sdk.DefaultResourceLoader({
      cwd:request.cwd,agentDir:this.agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,
      extensionFactories:[safetyExtension(policy,request.readOnly)],systemPromptOverride:()=>request.systemPrompt,
    });
    await resourceLoader.reload();
    let model:any=undefined,thinkingLevel=request.model.thinking;
    if(request.model.model){ const resolved=sdk.resolveCliModel({cliModel:request.model.model,modelRuntime}); if(resolved.error)throw new Error(resolved.error); model=resolved.model; thinkingLevel=request.model.thinking??resolved.thinkingLevel; }
    const sessionDir=path.join(this.stateDir,"sessions",request.runId,request.role);
    const sessionManager=sdk.SessionManager.create(request.cwd,sessionDir,{id:request.attemptId});
    const name=completionName(request.role);
    const created=await sdk.createAgentSession({
      cwd:request.cwd,agentDir:this.agentDir,modelRuntime,model,thinkingLevel,
      tools:[...new Set([...request.tools,name])],customTools:[outputTool],resourceLoader,sessionManager,settingsManager,
    });
    const session=created.session;
    if(created.extensionsResult?.errors?.length){ session.dispose(); throw new Error(`Agent extension setup failed: ${created.extensionsResult.errors.map((item:any)=>item.error??String(item)).join("; ")}`); }
    let assistantText="";
    const unsubscribe=session.subscribe((event:any)=>{
      if(event.type==="message_update"&&event.assistantMessageEvent?.type==="text_delta")assistantText+=event.assistantMessageEvent.delta??"";
    });
    let timer:NodeJS.Timeout|undefined;
    const onAbort=():void=>{void session.abort();}; request.signal?.addEventListener("abort",onAbort,{once:true});
    try{
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void session.abort();reject(new Error(`Agent ${request.role} timed out after ${request.timeoutMs}ms`));},request.timeoutMs);});
      await Promise.race([session.prompt(request.prompt),timeout]); await session.agent.waitForIdle();
      const raw=captured??fallbackJson(assistantText);
      if(!raw)throw new Error(`Agent ended without calling ${name}. Last output: ${truncate(assistantText,4000)}`);
      const output=request.role==="planner"?normalizePlan(raw,request.config.planner.maxTasks):request.role==="worker"?normalizeWorkerOutput(raw):request.role==="verifier"?normalizeVerifierOutput(raw):request.role==="critic"?normalizeCriticOutput(raw):normalizeFinalAuditOutput(raw);
      return {output:output as T,usage:usage(session.messages as unknown[]),sessionFile:session.sessionFile??null,assistantText};
    }catch(error){throw new Error(`Pi ${request.role} run failed: ${errorMessage(error)}`);}
    finally{
      if(timer)clearTimeout(timer); request.signal?.removeEventListener("abort",onAbort); unsubscribe(); session.dispose();
      try{await Promise.resolve(settingsManager.flush());}catch{}
    }
  }
  plan(request:Omit<StructuredAgentRequest,"role">):Promise<AgentRunResult<PlanOutput>>{return this.runStructured({...request,role:"planner"});}
  work(request:Omit<StructuredAgentRequest,"role">):Promise<AgentRunResult<WorkerOutput>>{return this.runStructured({...request,role:"worker"});}
  verify(request:Omit<StructuredAgentRequest,"role">):Promise<AgentRunResult<VerifierOutput>>{return this.runStructured({...request,role:"verifier"});}
  critique(request:Omit<StructuredAgentRequest,"role">):Promise<AgentRunResult<CriticOutput>>{return this.runStructured({...request,role:"critic"});}
  audit(request:Omit<StructuredAgentRequest,"role">):Promise<AgentRunResult<FinalAuditOutput>>{return this.runStructured({...request,role:"auditor"});}
}

export function resolveRuntimeModuleUrls():RuntimeModuleUrls {
  const result:RuntimeModuleUrls={};
  try{result.codingAgent=import.meta.resolve("@earendil-works/pi-coding-agent");}catch{}
  try{result.typebox=import.meta.resolve("typebox");}catch{}
  return result;
}
