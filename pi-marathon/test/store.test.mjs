import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MarathonStore } from "../dist/core/store.js";
import { DEFAULT_CONFIG } from "../dist/core/config.js";

test("persists a dependency graph and recovers in-flight work", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "marathon-store-"));
  const store = new MarathonStore(path.join(temp, "state.db"));
  try {
    const run = store.createRun(temp, "Build it", structuredClone(DEFAULT_CONFIG));
    store.addPlan(run.id, { summary:"plan", tasks:[
      { key:"a",title:"A",description:"A",type:"implementation",priority:100,dependsOn:[],acceptanceCriteria:["A done"],verification:{commands:[]} },
      { key:"b",title:"B",description:"B",type:"test",priority:90,dependsOn:["a"],acceptanceCriteria:["B done"],verification:{commands:[]} },
    ] }, 3);
    let ready = store.getReadyTasks(run.id, 10);
    assert.deepEqual(ready.map((task)=>task.key), ["a"]);
    const claimed = store.claimTask(ready[0].id, "worker", 60);
    assert.equal(claimed.attemptCount, 1);
    store.markTaskPassed(claimed.id, {status:"completed",summary:"ok",changes:[],commandsRun:[],evidence:[],blockers:[],suggestedTasks:[]}, {verdict:"pass",summary:"ok",acceptance:[{criterion:"A done",passed:true,evidence:"ok"}],issues:[],retryGuidance:"",repairTasks:[]});
    ready = store.getReadyTasks(run.id, 10);
    assert.deepEqual(ready.map((task)=>task.key), ["b"]);
    store.claimTask(ready[0].id, "worker", 60);
    const recovered = store.recoverStaleWork();
    assert.equal(recovered.tasks, 1);
    assert.equal(store.getTask(ready[0].id).status, "pending");
  } finally { store.close(); await rm(temp,{recursive:true,force:true}); }
});

test("reserves agent-call budget when an attempt starts, including failed attempts", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "marathon-calls-"));
  const store = new MarathonStore(path.join(temp, "state.db"));
  try {
    const run = store.createRun(temp, "Count attempted calls", structuredClone(DEFAULT_CONFIG));
    const attempt = store.createAttempt(run.id, null, "planner", 1);
    assert.equal(store.getRun(run.id).agentCalls, 1);
    store.finishAttempt(attempt.id, "failed", null, null, "provider failure");
    assert.equal(store.getRun(run.id).agentCalls, 1);
  } finally { store.close(); await rm(temp,{recursive:true,force:true}); }
});
