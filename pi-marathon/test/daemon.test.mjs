import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../dist/core/daemon.js";

test("daemon binds locally and protects its API with a bearer token", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"marathon-daemon-")),project=path.join(temp,"project"),agent=path.join(temp,"agent"),state=path.join(temp,"state");await mkdir(project,{recursive:true});
  const daemon=await startDaemon({projectCwd:project,agentDir:agent,stateDir:state});
  try{
    const health=await fetch(`http://127.0.0.1:${daemon.info.port}/health`).then((r)=>r.json());assert.equal(health.ok,true);
    const denied=await fetch(`http://127.0.0.1:${daemon.info.port}/v1/runs`);assert.equal(denied.status,401);
    const allowed=await fetch(`http://127.0.0.1:${daemon.info.port}/v1/runs`,{headers:{authorization:`Bearer ${daemon.info.token}`}});assert.equal(allowed.status,200);assert.deepEqual((await allowed.json()).runs,[]);
  }finally{await daemon.close();await rm(temp,{recursive:true,force:true});}
});
