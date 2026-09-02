#!/usr/bin/env node
import process from "node:process";
import { startDaemon } from "../core/daemon.js";
import { defaultAgentDir, resolveProjectStateDir } from "../core/paths.js";
import type { RuntimeModuleUrls } from "../core/types.js";
import { canonicalPath, errorMessage } from "../core/util.js";

function args(values:string[]):Record<string,string>{const result:Record<string,string>={};for(let i=0;i<values.length;i++){const value=values[i]!;if(value.startsWith("--")){const next=values[i+1];if(next&&!next.startsWith("--")){result[value.slice(2)]=next;i++;}else result[value.slice(2)]="true";}}return result;}
try{
  const input=args(process.argv.slice(2)),cwd=await canonicalPath(input.cwd??process.cwd()),agentDir=input["agent-dir"]??defaultAgentDir(),stateDir=input["state-dir"]??await resolveProjectStateDir(agentDir,cwd);
  const runtimeModules:RuntimeModuleUrls={...(input["coding-agent-module"]?{codingAgent:input["coding-agent-module"]}:{}),...(input["typebox-module"]?{typebox:input["typebox-module"]}:{})};
  const daemon=await startDaemon({projectCwd:cwd,agentDir,stateDir,runtimeModules});
  await new Promise<void>((resolve,reject)=>{
    let shuttingDown=false;
    const shutdown=async():Promise<void>=>{
      if(shuttingDown)return;shuttingDown=true;
      try{await daemon.close();resolve();}catch(error){reject(error);}
    };
    process.once("SIGINT",()=>void shutdown());
    process.once("SIGTERM",()=>void shutdown());
  });
}catch(error){console.error(errorMessage(error));process.exit(1);}
