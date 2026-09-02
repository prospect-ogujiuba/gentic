import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProgram } from "../dist/core/process.js";
import { prepareWorkspace, checkpointWorkspace, cleanupWorkspace } from "../dist/core/workspace.js";
import { DEFAULT_CONFIG } from "../dist/core/config.js";

async function git(args,cwd){const result=await runProgram("git",args,{cwd,timeoutMs:30000});assert.equal(result.code,0,result.stderr);return result.stdout.trim();}
test("uses an isolated Git worktree and checkpoints passed work", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"marathon-worktree-")),repo=path.join(temp,"repo"),state=path.join(temp,"state");
  await import("node:fs/promises").then(({mkdir})=>mkdir(repo,{recursive:true}));
  try{
    await git(["init"],repo);await writeFile(path.join(repo,"file.txt"),"base\n");await git(["add","."],repo);await git(["-c","user.name=Test","-c","user.email=test@example.com","commit","-m","base"],repo);
    const config=structuredClone(DEFAULT_CONFIG);config.workspace.mode="worktree";
    const run={id:"run_test_123",projectCwd:repo,goal:"change",status:"queued",phase:"created",config,workspace:null,summary:null,currentTaskId:null,agentCalls:0,costUsd:0,finalAuditCycles:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:null,completedAt:null,lastError:null};
    const workspace=await prepareWorkspace(run,state,config);assert.notEqual(workspace.root,repo);await writeFile(path.join(workspace.cwd,"file.txt"),"changed\n");
    const checkpoint=await checkpointWorkspace(workspace,null,config);assert.match(checkpoint.ref,/^[0-9a-f]{40,64}$/);assert.equal(await readFile(path.join(repo,"file.txt"),"utf8"),"base\n");
    await cleanupWorkspace(workspace,false);
  }finally{await rm(temp,{recursive:true,force:true});}
});

test("copy mode creates a private snapshot repository and never mutates the source", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"marathon-copy-")),source=path.join(temp,"source"),state=path.join(temp,"state");
  await import("node:fs/promises").then(({mkdir})=>mkdir(source,{recursive:true}));
  try{
    await writeFile(path.join(source,"file.txt"),"source\n");
    const config=structuredClone(DEFAULT_CONFIG);config.workspace.mode="copy";
    const run={id:"run_copy_123",projectCwd:source,goal:"change",status:"queued",phase:"created",config,workspace:null,summary:null,currentTaskId:null,agentCalls:0,costUsd:0,finalAuditCycles:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),startedAt:null,completedAt:null,lastError:null};
    const workspace=await prepareWorkspace(run,state,config);
    assert.equal(workspace.kind,"copy");assert.equal(workspace.repositoryRoot,workspace.root);assert.ok(workspace.baseRef);
    await writeFile(path.join(workspace.cwd,"file.txt"),"copy changed\n");
    const checkpoint=await checkpointWorkspace(workspace,null,config);
    assert.match(checkpoint.ref,/^[0-9a-f]{40,64}$/);
    assert.equal(await readFile(path.join(source,"file.txt"),"utf8"),"source\n");
    await cleanupWorkspace(workspace,false);
  }finally{await rm(temp,{recursive:true,force:true});}
});
