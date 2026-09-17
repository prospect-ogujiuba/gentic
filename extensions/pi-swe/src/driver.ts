import type { OrchestrationAdvanceInput, OrchestrationEngine, OrchestrationHandoff } from "./orchestration.ts";

export type DriverOutcome = "completed" | "handoff" | "cancelled" | "interrupted" | "timed-out" | "budget-exhausted" | "infrastructure-failure";
export type DriverResult = { topic: string; advances: number; outcome: DriverOutcome; handoff: OrchestrationHandoff };

type DriverEngine = Pick<OrchestrationEngine, "advance">;
type WorkflowRevision = { revision: number };
type ActiveRun = { controller: AbortController; outcome?: "cancelled" | "interrupted" | "timed-out" };

export type AutonomousWorkflowDriverOptions = {
  engine: DriverEngine;
  readWorkflow(topic: string): WorkflowRevision;
  maxAdvances?: number;
  deadlineMs?: number;
  paceMs?: number;
  now?: () => number;
  abortActive?: (topic: string, outcome: "cancelled" | "interrupted" | "timed-out") => void;
};

/**
 * Drives finite OrchestrationEngine transitions. Durable state is always reread;
 * this process-local object owns only cancellation and concurrency handles.
 */
export class AutonomousWorkflowDriver {
  readonly options: Required<Omit<AutonomousWorkflowDriverOptions, "engine" | "readWorkflow" | "abortActive">> & Pick<AutonomousWorkflowDriverOptions, "engine" | "readWorkflow">;
  private readonly abortActive: NonNullable<AutonomousWorkflowDriverOptions["abortActive"]>;
  private readonly active = new Map<string, ActiveRun>();
  private closed = false;

  constructor(options: AutonomousWorkflowDriverOptions) {
    if (!options.engine || typeof options.engine.advance !== "function" || typeof options.readWorkflow !== "function") throw new Error("driver requires an engine and durable workflow reader");
    const maxAdvances = options.maxAdvances ?? 64;
    const deadlineMs = options.deadlineMs ?? 30 * 60_000;
    const paceMs = options.paceMs ?? 0;
    if (!Number.isSafeInteger(maxAdvances) || maxAdvances < 1 || maxAdvances > 256) throw new Error("driver stage budget must be between 1 and 256");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 24 * 60 * 60_000) throw new Error("driver deadline is outside production bounds");
    if (!Number.isSafeInteger(paceMs) || paceMs < 0 || paceMs > 10_000) throw new Error("driver pacing is outside production bounds");
    this.options = { ...options, maxAdvances, deadlineMs, paceMs, now: options.now ?? Date.now };
    this.abortActive = options.abortActive ?? (() => undefined);
  }

  start(topic: string): Promise<DriverResult> { return this.drive(topic); }
  resume(topic: string): Promise<DriverResult> { return this.drive(topic); }

  pause(topic: string): boolean { return this.abort(topic, "interrupted"); }
  stop(topic: string): boolean { return this.abort(topic, "cancelled"); }

  shutdown(): void {
    this.closed = true;
    for (const topic of this.active.keys()) this.abort(topic, "interrupted");
  }

  private async drive(topic: string): Promise<DriverResult> {
    if (this.closed) throw new Error("workflow driver is shut down");
    if (!topic.trim()) throw new Error("workflow topic is required");
    if (this.active.has(topic)) throw new Error(`workflow ${topic} already has an active driver`);
    const run: ActiveRun = { controller: new AbortController() };
    this.active.set(topic, run);
    const deadline = this.options.now() + this.options.deadlineMs;
    const deadlineTimer = setTimeout(() => {
      if (this.active.get(topic) !== run || run.controller.signal.aborted) return;
      run.outcome = "timed-out";
      this.abortActive(topic, "timed-out");
      run.controller.abort(new Error("workflow driver deadline expired"));
    }, this.options.deadlineMs);
    let advances = 0;
    let last = terminalHandoff(this.options.readWorkflow(topic), "blocked", "driver has not advanced");
    try {
      while (advances < this.options.maxAdvances) {
        if (run.controller.signal.aborted) return cancelled(topic, advances, run, last);
        if (this.options.now() >= deadline) {
          run.outcome = "timed-out";
          run.controller.abort(new Error("workflow driver deadline expired"));
          return cancelled(topic, advances, run, last);
        }
        const state = this.options.readWorkflow(topic);
        const advanced = this.options.engine.advance(topic, state.revision, {} as OrchestrationAdvanceInput);
        const handoff = await Promise.race([advanced, aborted(run.controller.signal, state)]);
        advances += 1;
        if (run.controller.signal.aborted) return cancelled(topic, advances, run, handoff);
        last = handoff;
        if (handoff.kind !== "advanced") return { topic, advances, outcome: handoff.kind === "complete" ? "completed" : "handoff", handoff };
        if (this.options.paceMs) await delay(this.options.paceMs, run.controller.signal);
      }
      return { topic, advances, outcome: "budget-exhausted", handoff: terminalHandoff(this.options.readWorkflow(topic), "blocked", `driver stage budget exhausted after ${advances} advances`) };
    } catch (error) {
      if (run.controller.signal.aborted) return cancelled(topic, advances, run, last);
      return { topic, advances, outcome: "infrastructure-failure", handoff: terminalHandoff(this.options.readWorkflow(topic), "blocked", error instanceof Error ? error.message : String(error)) };
    } finally {
      clearTimeout(deadlineTimer);
      if (this.active.get(topic) === run) this.active.delete(topic);
    }
  }

  private abort(topic: string, outcome: NonNullable<ActiveRun["outcome"]>): boolean {
    const run = this.active.get(topic);
    if (!run) return false;
    run.outcome = outcome;
    this.abortActive(topic, outcome);
    run.controller.abort(new Error(`workflow driver ${outcome}`));
    return true;
  }
}

function terminalHandoff(workflow: WorkflowRevision, kind: "blocked" | "stale", message: string): OrchestrationHandoff {
  return { kind, stage: "pending", message, workflow: workflow as OrchestrationHandoff["workflow"] };
}
function cancelled(topic: string, advances: number, run: ActiveRun, prior: OrchestrationHandoff): DriverResult {
  const outcome = run.outcome ?? "interrupted";
  return { topic, advances, outcome, handoff: { ...prior, kind: "blocked", message: `driver ${outcome}; late child results are ignored` } };
}
function aborted(signal: AbortSignal, workflow: WorkflowRevision): Promise<OrchestrationHandoff> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(terminalHandoff(workflow, "blocked", "driver interrupted")), { once: true }));
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
