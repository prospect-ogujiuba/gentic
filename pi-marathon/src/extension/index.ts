import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveRuntimeModuleUrls } from "../core/agent-runner.js";
import { MarathonClient } from "../core/client.js";
import { executeControl, parseControl, type ParsedControl } from "../core/control.js";
import { compactId, progressLine } from "../core/format.js";
import type { RuntimeModuleUrls } from "../core/types.js";
import { errorMessage, truncate } from "../core/util.js";

const ENTRY="pi-marathon"; const UI="pi-marathon";
export default function piMarathon(pi:ExtensionAPI):void{
  let timer:NodeJS.Timeout|undefined,busy=false,lastStatus=new Map<string,string>(),runtime:RuntimeModuleUrls|undefined;
  const modules=():RuntimeModuleUrls=>runtime??(runtime=resolveRuntimeModuleUrls());
  const options=(cwd:string)=>({projectCwd:cwd,runtimeModules:modules()});
  const append=(text:string,level:"info"|"success"|"warning"|"error"="info"):void=>pi.appendEntry(ENTRY,{text,level,at:new Date().toISOString()});
  const refresh=async(ctx:any):Promise<void>=>{
    if(!ctx?.hasUI||busy)return;busy=true;
    try{
      const client=await MarathonClient.connectExisting(options(ctx.cwd));
      if(!client){ctx.ui.setStatus(UI,undefined);ctx.ui.setWidget(UI,undefined);return;}
      const run=await client.activeRun();
      if(!run){ctx.ui.setStatus(UI,"Marathon idle");ctx.ui.setWidget(UI,undefined);return;}
      const details=await client.getRun(run.id),label=`Marathon ${compactId(run.id)} · ${run.status} · ${details.progress.percent}%`;
      ctx.ui.setStatus(UI,label);
      ctx.ui.setWidget(UI,[label,progressLine(details.progress),truncate(run.summary??run.goal,140)]);
      const previous=lastStatus.get(run.id);lastStatus.set(run.id,run.status);
      if(previous&&previous!==run.status&&["completed","failed","cancelled","waiting_for_human","paused"].includes(run.status)){
        const level=run.status==="completed"?"success":run.status==="failed"?"error":"warning";
        append(`${label}\n${run.summary??run.lastError??""}`,level);
        ctx.ui.notify(label,level==="error"?"error":level==="warning"?"warning":"info");
      }
    }catch{ctx.ui.setStatus(UI,"Marathon unavailable");}finally{busy=false;}
  };
  const startPolling=(ctx:any):void=>{if(timer)clearInterval(timer);if(!ctx?.hasUI)return;void refresh(ctx);timer=setInterval(()=>void refresh(ctx),4000);timer.unref?.();};
  const stopPolling=(ctx:any):void=>{if(timer)clearInterval(timer);timer=undefined;if(ctx?.hasUI){ctx.ui.setStatus(UI,undefined);ctx.ui.setWidget(UI,undefined);}};
  const run=async(parsed:ParsedControl,ctx:any):Promise<string>=>{
    try{const result=await executeControl(options(ctx.cwd),parsed);append(result.text,result.run?.status==="completed"?"success":result.run?.status==="failed"?"error":"info");if(ctx?.hasUI)ctx.ui.notify(parsed.action==="start"?`Started ${result.run?.id??"Marathon run"}`:"Marathon command complete","info");startPolling(ctx);return result.text;}
    catch(error){const message=errorMessage(error);append(message,"error");if(ctx?.hasUI)ctx.ui.notify(truncate(message,500),"error");throw error;}
  };

  pi.registerEntryRenderer(ENTRY,(entry:any,_options:any,theme:any)=>{
    const data=entry.data as {text?:string;level?:string};const color=data.level==="error"?"error":data.level==="success"?"success":data.level==="warning"?"warning":"accent";
    return new Text(theme.fg(color,data.text??"Pi Marathon"),0,0);
  });
  pi.registerCommand("marathon",{description:"Start and control durable, verifier-driven agent runs",handler:async(args:string,ctx:any)=>{await run(parseControl(args),ctx);}});

  const action=Type.Union(["start","status","list","tasks","inspect","failures","events","pause","resume","cancel","steer","budget","doctor","path"].map((value)=>Type.Literal(value)));
  pi.registerTool({
    name:"marathon_control",label:"Marathon",description:"Start or control a durable Pi Marathon run. Use start for substantial multi-step repository objectives; use status/inspect to observe it; use steer to add guidance without replacing durable state.",
    parameters:Type.Object({
      action,goal:Type.Optional(Type.String()),runId:Type.Optional(Type.String()),message:Type.Optional(Type.String()),
      budget:Type.Optional(Type.Object({maxTasks:Type.Optional(Type.Number()),maxAgentCalls:Type.Optional(Type.Number()),maxRunMinutes:Type.Optional(Type.Number()),maxCostUsd:Type.Optional(Type.Union([Type.Number(),Type.Null()])),maxFinalAuditCycles:Type.Optional(Type.Number())})),
    }),
    async execute(_id:string,params:any,_signal:AbortSignal,_update:any,ctx:any){
      const parsed:ParsedControl={action:params.action,...(params.goal?{goal:params.goal}:{}),...(params.runId?{runId:params.runId}:{}),...(params.message?{message:params.message}:{}),...(params.budget?{budget:params.budget}:{})};
      try{const text=await run(parsed,ctx);return {content:[{type:"text",text}],details:{action:params.action,runId:params.runId}};}
      catch(error){return {content:[{type:"text",text:`Pi Marathon error: ${errorMessage(error)}`}],details:{error:errorMessage(error)},isError:true};}
    },
  });
  pi.on("session_start",async(_event:any,ctx:any)=>startPolling(ctx));
  pi.on("session_shutdown",async(_event:any,ctx:any)=>stopPolling(ctx));
}
