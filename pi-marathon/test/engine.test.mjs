import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MarathonStore } from "../dist/core/store.js";
import { MarathonEngine } from "../dist/core/engine.js";
import { DEFAULT_CONFIG } from "../dist/core/config.js";

const result=(output)=>({output,usage:{costUsd:0,inputTokens:10,outputTokens:10,totalTokens:20},sessionFile:null,assistantText:""});
class FakeRunner {
  async plan(){return result({summary:"one task",tasks:[{key:"deliver",title:"Deliver",description:"Create result.txt",type:"implementation",priority:100,dependsOn:[],acceptanceCriteria:["result.txt contains complete"],verification:{commands:[]}}]});}
  async work(request){await writeFile(path.join(request.cwd,"result.txt"),"complete\n");return result({status:"completed",summary:"created",changes:[{path:"result.txt",description:"output"}],commandsRun:[],evidence:["file written"],blockers:[],suggestedTasks:[]});}
  async verify(){return result({verdict:"pass",summary:"verified",acceptance:[{criterion:"result.txt contains complete",passed:true,evidence:"read file"}],issues:[],retryGuidance:"",repairTasks:[]});}
  async critique(){return result({diagnosis:"n/a",failedAssumptions:[],newStrategy:"n/a",concreteNextActions:[]});}
  async audit(){return result({verdict:"pass",summary:"goal satisfied",goalSatisfied:true,evidence:["task passed"],issues:[],repairTasks:[]});}
}
async function waitFor(fn,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await new Promise((resolve)=>setTimeout(resolve,50));}throw new Error("timeout");}
test("engine plans, executes, verifies, checkpoints, audits, and completes", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"marathon-engine-")),project=path.join(temp,"project"),state=path.join(temp,"state");await mkdir(project,{recursive:true});await writeFile(path.join(project,"README.md"),"test\n");
  const store=new MarathonStore(path.join(state,"db.sqlite"));const config=structuredClone(DEFAULT_CONFIG);config.workspace.mode="copy";config.workspace.keepOnComplete=true;config.scheduler.pollIntervalMs=25;
  const run=store.createRun(project,"Create a verified result",config),engine=new MarathonEngine(store,new FakeRunner(),state);engine.start();
  try{
    const completed=await waitFor(()=>{const current=store.getRun(run.id);return current&&["completed","failed"].includes(current.status)?current:null;});
    assert.equal(completed.status,"completed",completed.lastError);const details=store.getRunDetails(run.id);assert.equal(details.progress.passed,1);assert.equal(await readFile(path.join(completed.workspace.cwd,"result.txt"),"utf8"),"complete\n");assert.equal(completed.agentCalls,4);
  }finally{await engine.stop();store.close();await rm(temp,{recursive:true,force:true});}
});
