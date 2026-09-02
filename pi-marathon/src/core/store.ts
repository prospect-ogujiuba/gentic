import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentUsage, AttemptRecord, AttemptRole, EventRecord, MarathonConfig, PlanOutput, PlannedTask,
  RunDetails, RunPhase, RunProgress, RunRecord, RunStatus, TaskRecord, TaskStatus,
  VerifierOutput, WorkerOutput, WorkspaceRecord,
} from "./types.js";
import { makeId, nowIso, parseJson } from "./util.js";

type Row = Record<string, any>;

export class MarathonStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  close(): void { this.db.close(); }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, project_cwd TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        phase TEXT NOT NULL, config_json TEXT NOT NULL, workspace_json TEXT, summary TEXT,
        current_task_id TEXT, agent_calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        final_audit_cycles INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, last_error TEXT, version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, task_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, task_type TEXT NOT NULL, status TEXT NOT NULL,
        priority REAL NOT NULL, acceptance_json TEXT NOT NULL, verification_json TEXT NOT NULL,
        max_attempts INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, failure_streak INTEGER NOT NULL DEFAULT 0,
        result_json TEXT, last_error TEXT, retry_guidance TEXT, lease_owner TEXT, lease_expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        UNIQUE(run_id, task_key)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_ready ON tasks(run_id,status,priority DESC,ordinal ASC);
      CREATE TABLE IF NOT EXISTS task_dependencies(
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id,depends_on_task_id), CHECK(task_id<>depends_on_task_id)
      );
      CREATE TABLE IF NOT EXISTS attempts(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, role TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL, session_file TEXT, result_json TEXT, usage_json TEXT, error TEXT,
        started_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id,started_at DESC);
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, event_type TEXT NOT NULL,
        payload_json TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id,seq);
      CREATE TABLE IF NOT EXISTS steering(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        message TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, git_ref TEXT, summary TEXT NOT NULL,
        metadata_json TEXT, created_at TEXT NOT NULL
      );
    `);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private mapRun(row: Row): RunRecord {
    return {
      id: row.id, projectCwd: row.project_cwd, goal: row.goal, status: row.status, phase: row.phase,
      config: parseJson(row.config_json, {} as MarathonConfig), workspace: parseJson(row.workspace_json, null),
      summary: row.summary, currentTaskId: row.current_task_id, agentCalls: row.agent_calls,
      costUsd: row.cost_usd, finalAuditCycles: row.final_audit_cycles, createdAt: row.created_at,
      updatedAt: row.updated_at, startedAt: row.started_at, completedAt: row.completed_at, lastError: row.last_error,
    };
  }
  private dependencies(taskId: string): string[] {
    return (this.db.prepare(`SELECT d.task_key FROM task_dependencies x JOIN tasks d ON d.id=x.depends_on_task_id WHERE x.task_id=? ORDER BY d.ordinal`).all(taskId) as Row[]).map((row) => row.task_key);
  }
  private mapTask(row: Row): TaskRecord {
    return {
      id: row.id, runId: row.run_id, parentId: row.parent_id, key: row.task_key, ordinal: row.ordinal,
      title: row.title, description: row.description, type: row.task_type, status: row.status,
      priority: row.priority, dependencies: this.dependencies(row.id),
      acceptanceCriteria: parseJson(row.acceptance_json, []), verification: parseJson(row.verification_json, { commands: [] }),
      maxAttempts: row.max_attempts, attemptCount: row.attempt_count, failureStreak: row.failure_streak,
      result: parseJson(row.result_json, null), lastError: row.last_error, retryGuidance: row.retry_guidance,
      leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, createdAt: row.created_at,
      updatedAt: row.updated_at, startedAt: row.started_at, completedAt: row.completed_at,
    };
  }
  private mapAttempt(row: Row): AttemptRecord {
    return {
      id: row.id, runId: row.run_id, taskId: row.task_id, role: row.role, number: row.attempt_number,
      status: row.status, sessionFile: row.session_file, result: parseJson(row.result_json, null),
      usage: parseJson(row.usage_json, null), error: row.error, startedAt: row.started_at, completedAt: row.completed_at,
    };
  }
  private mapEvent(row: Row): EventRecord {
    return { seq: row.seq, runId: row.run_id, taskId: row.task_id, type: row.event_type, payload: parseJson(row.payload_json, null), createdAt: row.created_at };
  }
  private patchRun(runId: string, fields: Record<string, unknown>): void {
    const entries = Object.entries(fields); if (!entries.length) return;
    const now = nowIso();
    const sql = entries.map(([key]) => `${key}=?`).join(",");
    this.db.prepare(`UPDATE runs SET ${sql},updated_at=?,version=version+1 WHERE id=?`).run(...(entries.map(([,value]) => value) as any[]), now, runId);
  }

  createRun(projectCwd: string, goal: string, config: MarathonConfig): RunRecord {
    const id = makeId("run"), now = nowIso();
    this.db.prepare(`INSERT INTO runs(id,project_cwd,goal,status,phase,config_json,created_at,updated_at) VALUES(?,?,?,'queued','created',?,?,?)`).run(id, projectCwd, goal, JSON.stringify(config), now, now);
    this.addEvent(id, null, "run_created", { goal }); return this.getRun(id)!;
  }
  getRun(id: string): RunRecord | null { const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Row | undefined; return row ? this.mapRun(row) : null; }
  listRuns(limit = 20): RunRecord[] { return (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(1,Math.min(200,limit))) as Row[]).map((row) => this.mapRun(row)); }
  listExecutableRuns(): RunRecord[] { return (this.db.prepare("SELECT * FROM runs WHERE status IN ('queued','planning','running') ORDER BY created_at").all() as Row[]).map((row) => this.mapRun(row)); }
  getActiveRun(): RunRecord | null { const row = this.db.prepare("SELECT * FROM runs WHERE status IN ('queued','planning','running','paused','waiting_for_human') ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined; return row ? this.mapRun(row) : null; }
  setRunWorkspace(id: string, workspace: WorkspaceRecord): void { this.patchRun(id, { workspace_json: JSON.stringify(workspace), phase: "workspace" }); this.addEvent(id,null,"workspace_prepared",workspace); }
  setRunPhase(id: string, phase: RunPhase): void { this.patchRun(id,{phase}); this.addEvent(id,null,"run_phase_changed",{phase}); }
  setRunSummary(id: string, summary: string | null): void { this.patchRun(id,{summary}); }
  setCurrentTask(id: string, taskId: string | null): void { this.patchRun(id,{current_task_id:taskId}); }
  updateRunConfig(id: string, config: MarathonConfig): void { this.patchRun(id,{config_json:JSON.stringify(config)}); this.addEvent(id,null,"run_config_updated",{budget:config.budget}); }
  incrementFinalAuditCycle(id: string): number { this.db.prepare("UPDATE runs SET final_audit_cycles=final_audit_cycles+1,updated_at=?,version=version+1 WHERE id=?").run(nowIso(),id); return this.getRun(id)?.finalAuditCycles ?? 0; }
  recordAgentCost(id: string, usage: AgentUsage | null): void { this.db.prepare("UPDATE runs SET cost_usd=cost_usd+?,updated_at=?,version=version+1 WHERE id=?").run(usage?.costUsd ?? 0,nowIso(),id); }
  setRunStatus(id: string, status: RunStatus, options: { phase?: RunPhase; summary?: string | null; error?: string | null } = {}): void {
    const now = nowIso(); const assignments = ["status=?","updated_at=?","version=version+1"]; const values: unknown[] = [status,now];
    if (options.phase) { assignments.push("phase=?"); values.push(options.phase); }
    if (options.summary !== undefined) { assignments.push("summary=?"); values.push(options.summary); }
    if (options.error !== undefined) { assignments.push("last_error=?"); values.push(options.error); }
    if (status === "planning" || status === "running") { assignments.push("started_at=COALESCE(started_at,?)"); values.push(now); }
    if (["completed","failed","cancelled"].includes(status)) { assignments.push("completed_at=?"); values.push(now); } else assignments.push("completed_at=NULL");
    this.db.prepare(`UPDATE runs SET ${assignments.join(",")} WHERE id=?`).run(...(values as any[]),id);
    this.addEvent(id,null,"run_status_changed",{status,phase:options.phase,error:options.error});
  }

  addPlan(runId: string, plan: PlanOutput, defaultAttempts: number): TaskRecord[] {
    return this.tx(() => {
      if (this.countTasks(runId)) throw new Error("Run already has a task graph");
      this.insertTasks(runId, plan.tasks, defaultAttempts, 0);
      this.patchRun(runId,{summary:plan.summary,phase:"execution"}); this.addEvent(runId,null,"plan_created",{summary:plan.summary,taskCount:plan.tasks.length});
      return this.listTasks(runId);
    });
  }
  addRepairTasks(runId: string, tasks: PlannedTask[], defaultAttempts: number, cycle: number): TaskRecord[] {
    return this.tx(() => {
      const offset = this.countTasks(runId); this.insertTasks(runId,tasks,defaultAttempts,offset);
      this.patchRun(runId,{phase:"execution",status:"running",last_error:null}); this.addEvent(runId,null,"repair_plan_created",{cycle,taskCount:tasks.length});
      return this.listTasks(runId).slice(offset);
    });
  }
  private insertTasks(runId: string, tasks: PlannedTask[], defaultAttempts: number, ordinalOffset: number): void {
    const existing = this.listTasks(runId); const keyToId = new Map(existing.map((task) => [task.key,task.id]));
    for (const task of tasks) keyToId.set(task.key,makeId("task"));
    const now = nowIso(); const insert = this.db.prepare(`INSERT INTO tasks(id,run_id,parent_id,task_key,ordinal,title,description,task_type,status,priority,acceptance_json,verification_json,max_attempts,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?,'pending',?,?,?,?,?,?)`);
    tasks.forEach((task,index) => insert.run(keyToId.get(task.key)!,runId,task.key,ordinalOffset+index,task.title,task.description,task.type,task.priority,JSON.stringify(task.acceptanceCriteria),JSON.stringify(task.verification),task.maxAttempts ?? defaultAttempts,now,now));
    const dep = this.db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)");
    for (const task of tasks) for (const key of task.dependsOn) { const dependency = keyToId.get(key); if (!dependency) throw new Error(`Unknown dependency ${key}`); dep.run(keyToId.get(task.key)!,dependency); }
  }

  countTasks(runId: string): number { return Number((this.db.prepare("SELECT COUNT(*) count FROM tasks WHERE run_id=?").get(runId) as Row).count); }
  getTask(id: string): TaskRecord | null { const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Row | undefined; return row ? this.mapTask(row) : null; }
  listTasks(runId: string): TaskRecord[] { return (this.db.prepare("SELECT * FROM tasks WHERE run_id=? ORDER BY ordinal").all(runId) as Row[]).map((row) => this.mapTask(row)); }
  getDependencyTasks(taskId: string): TaskRecord[] { return (this.db.prepare("SELECT d.* FROM task_dependencies x JOIN tasks d ON d.id=x.depends_on_task_id WHERE x.task_id=? ORDER BY d.ordinal").all(taskId) as Row[]).map((row) => this.mapTask(row)); }
  getReadyTasks(runId: string, limit: number): TaskRecord[] {
    return (this.db.prepare(`SELECT t.* FROM tasks t WHERE t.run_id=? AND t.status='pending' AND NOT EXISTS(SELECT 1 FROM task_dependencies x JOIN tasks d ON d.id=x.depends_on_task_id WHERE x.task_id=t.id AND d.status<>'passed') ORDER BY t.priority DESC,t.ordinal LIMIT ?`).all(runId,Math.max(1,limit)) as Row[]).map((row) => this.mapTask(row));
  }
  claimTask(id: string, worker: string, leaseSeconds: number): TaskRecord | null {
    const now = nowIso(), expiry = new Date(Date.now()+leaseSeconds*1000).toISOString();
    const result = this.db.prepare(`UPDATE tasks SET status='running',attempt_count=attempt_count+1,lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='pending'`).run(worker,expiry,now,now,id);
    if (!result.changes) return null; const task = this.getTask(id)!; this.addEvent(task.runId,id,"task_started",{attempt:task.attemptCount,worker}); return task;
  }
  renewTaskLease(id: string, worker: string, seconds: number): void { this.db.prepare("UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_owner=? AND status IN ('running','verifying')").run(new Date(Date.now()+seconds*1000).toISOString(),nowIso(),id,worker); }
  releaseTask(id: string, reason: string): void { const task=this.getTask(id); if(!task)return; this.db.prepare("UPDATE tasks SET status='pending',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND status IN ('running','verifying')").run(reason,nowIso(),id); this.addEvent(task.runId,id,"task_released",{reason}); }
  markTaskVerifying(id: string, worker: WorkerOutput): void { const task=this.getTask(id); if(!task)return; this.db.prepare("UPDATE tasks SET status='verifying',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({worker}),nowIso(),id); this.addEvent(task.runId,id,"task_verifying",{summary:worker.summary}); }
  markTaskPassed(id: string, worker: WorkerOutput, verifier: VerifierOutput): void { const task=this.getTask(id); if(!task)return; const now=nowIso(); this.db.prepare("UPDATE tasks SET status='passed',result_json=?,failure_streak=0,last_error=NULL,retry_guidance=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE id=?").run(JSON.stringify({worker,verifier}),now,now,id); this.addEvent(task.runId,id,"task_passed",{summary:verifier.summary}); }
  markTaskRetry(id: string, error: string, guidance: string): void { const task=this.getTask(id); if(!task)return; this.db.prepare("UPDATE tasks SET status='pending',failure_streak=failure_streak+1,last_error=?,retry_guidance=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(error,guidance,nowIso(),id); this.addEvent(task.runId,id,"task_retry",{error,guidance}); }
  markTaskFailed(id: string, error: string, verifier?: VerifierOutput): void { const task=this.getTask(id); if(!task)return; const now=nowIso(); this.db.prepare("UPDATE tasks SET status='failed',last_error=?,result_json=COALESCE(?,result_json),lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE id=?").run(error,verifier?JSON.stringify({verifier}):null,now,now,id); this.addEvent(task.runId,id,"task_failed",{error}); }
  markBlockedDependents(runId: string): number {
    let total=0;
    while(true){ const result=this.db.prepare(`UPDATE tasks SET status='blocked',last_error='A dependency failed or was blocked',updated_at=?,completed_at=? WHERE run_id=? AND status='pending' AND EXISTS(SELECT 1 FROM task_dependencies x JOIN tasks d ON d.id=x.depends_on_task_id WHERE x.task_id=tasks.id AND d.status IN ('failed','blocked','cancelled'))`).run(nowIso(),nowIso(),runId); total+=Number(result.changes); if(!result.changes)break; }
    if(total)this.addEvent(runId,null,"dependent_tasks_blocked",{count:total}); return total;
  }
  cancelOpenTasks(runId: string): void { const now=nowIso(); this.db.prepare("UPDATE tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE run_id=? AND status IN ('pending','running','verifying')").run(now,now,runId); }

  createAttempt(runId: string, taskId: string | null, role: AttemptRole, number: number): AttemptRecord {
    return this.tx(()=>{
      const id=makeId("attempt"), now=nowIso();
      this.db.prepare("INSERT INTO attempts(id,run_id,task_id,role,attempt_number,status,started_at) VALUES(?,?,?,?,?,'running',?)").run(id,runId,taskId,role,number,now);
      this.db.prepare("UPDATE runs SET agent_calls=agent_calls+1,updated_at=?,version=version+1 WHERE id=?").run(now,runId);
      this.addEvent(runId,taskId,"attempt_started",{id,role,number});
      return this.getAttempt(id)!;
    });
  }
  getAttempt(id: string): AttemptRecord | null { const row=this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as Row|undefined; return row?this.mapAttempt(row):null; }
  setAttemptSession(id: string, sessionFile: string | null): void { this.db.prepare("UPDATE attempts SET session_file=? WHERE id=?").run(sessionFile,id); }
  finishAttempt(id: string, status: AttemptRecord["status"], result: unknown, usage: AgentUsage | null, error: string | null): void { const attempt=this.getAttempt(id); if(!attempt)return; this.db.prepare("UPDATE attempts SET status=?,result_json=?,usage_json=?,error=?,completed_at=? WHERE id=?").run(status,result===undefined?null:JSON.stringify(result),usage?JSON.stringify(usage):null,error,nowIso(),id); this.addEvent(attempt.runId,attempt.taskId,"attempt_finished",{id,status,role:attempt.role,error}); }
  listTaskAttempts(taskId: string): AttemptRecord[] { return (this.db.prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY started_at").all(taskId) as Row[]).map((row)=>this.mapAttempt(row)); }

  addEvent(runId: string | null, taskId: string | null, type: string, payload: unknown = null): number { const result=this.db.prepare("INSERT INTO events(run_id,task_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)").run(runId,taskId,type,payload===undefined?null:JSON.stringify(payload),nowIso()); return Number(result.lastInsertRowid); }
  listEvents(runId: string, after=0, limit=100): EventRecord[] { return (this.db.prepare("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?").all(runId,after,Math.max(1,Math.min(1000,limit))) as Row[]).map((row)=>this.mapEvent(row)); }
  listRecentEvents(runId: string, limit=50): EventRecord[] { return (this.db.prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq DESC LIMIT ?").all(runId,Math.max(1,Math.min(1000,limit))) as Row[]).reverse().map((row)=>this.mapEvent(row)); }
  queueSteering(runId: string, message: string): string { const id=makeId("steer"); this.db.prepare("INSERT INTO steering(id,run_id,message,status,created_at) VALUES(?,?,?,'pending',?)").run(id,runId,message,nowIso()); this.addEvent(runId,null,"steering_queued",{id,message}); return id; }
  consumePendingSteering(runId: string): string[] { return this.tx(()=>{ const rows=this.db.prepare("SELECT id,message FROM steering WHERE run_id=? AND status='pending' ORDER BY created_at").all(runId) as Row[]; const now=nowIso(); for(const row of rows)this.db.prepare("UPDATE steering SET status='applied',applied_at=? WHERE id=?").run(now,row.id); return rows.map((row)=>row.message); }); }
  addCheckpoint(runId: string, taskId: string | null, ref: string | null, summary: string, metadata: unknown): void { const id=makeId("checkpoint"); this.db.prepare("INSERT INTO checkpoints(id,run_id,task_id,git_ref,summary,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id,runId,taskId,ref,summary,JSON.stringify(metadata),nowIso()); this.addEvent(runId,taskId,"checkpoint_created",{id,ref,summary}); }

  getProgress(runId: string): RunProgress {
    const base: RunProgress={total:0,pending:0,running:0,verifying:0,passed:0,failed:0,blocked:0,cancelled:0,percent:0};
    const rows=this.db.prepare("SELECT status,COUNT(*) count FROM tasks WHERE run_id=? GROUP BY status").all(runId) as Row[];
    for(const row of rows){ const key=row.status as keyof RunProgress; if(key in base)(base as any)[key]=Number(row.count); base.total+=Number(row.count); }
    base.percent=base.total?Math.round((base.passed/base.total)*100):0; return base;
  }
  getRunDetails(runId: string): RunDetails | null { const run=this.getRun(runId); return run?{run,tasks:this.listTasks(runId),progress:this.getProgress(runId),recentEvents:this.listRecentEvents(runId,50)}:null; }
  allTasksPassed(runId: string): boolean { const row=this.db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='passed' THEN 1 ELSE 0 END) passed FROM tasks WHERE run_id=?").get(runId) as Row; return Number(row.total)>0&&Number(row.total)===Number(row.passed); }
  hasTerminalTaskFailure(runId: string): boolean { return Number((this.db.prepare("SELECT COUNT(*) count FROM tasks WHERE run_id=? AND status IN ('failed','blocked')").get(runId) as Row).count)>0; }
  hasInFlightTasks(runId: string): boolean { return Number((this.db.prepare("SELECT COUNT(*) count FROM tasks WHERE run_id=? AND status IN ('running','verifying')").get(runId) as Row).count)>0; }
  recoverStaleWork(): { tasks: number; attempts: number } {
    const now=nowIso(); const tasks=this.db.prepare("UPDATE tasks SET status='pending',lease_owner=NULL,lease_expires_at=NULL,last_error='Recovered after daemon restart',updated_at=? WHERE status IN ('running','verifying')").run(now);
    const attempts=this.db.prepare("UPDATE attempts SET status='aborted',error='Daemon restarted',completed_at=? WHERE status='running'").run(now);
    return {tasks:Number(tasks.changes),attempts:Number(attempts.changes)};
  }
}
