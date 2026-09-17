import assert from "node:assert/strict";
import test from "node:test";

import { AutonomousWorkflowDriver } from "../extensions/pi-swe/src/driver.ts";

type State = { revision: number };

function harness(kinds: Array<"advanced" | "blocked" | "needs-input" | "verification-required" | "stale" | "complete">) {
  let revision = 1;
  let concurrent = 0;
  let maxConcurrent = 0;
  const calls: number[] = [];
  const engine = {
    async advance(_topic: string, expectedRevision: number) {
      concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); calls.push(expectedRevision);
      await Promise.resolve();
      const kind = kinds.shift() ?? "complete";
      if (kind === "advanced") revision += 1;
      concurrent -= 1;
      return { kind, stage: kind === "complete" ? "complete" as const : "implementation" as const, message: kind, workflow: { revision } as never };
    },
  };
  return { engine, read: () => ({ revision } as State), calls, maxConcurrent: () => maxConcurrent };
}

test("one start drives legal stages until the first genuine terminal handoff", async () => {
  const fixture = harness(["advanced", "advanced", "needs-input"]);
  const driver = new AutonomousWorkflowDriver({ engine: fixture.engine, readWorkflow: fixture.read, maxAdvances: 8 });
  const result = await driver.start("topic");
  assert.equal(result.handoff.kind, "needs-input");
  assert.deepEqual(fixture.calls, [1, 2, 3]);
  assert.equal(result.advances, 3);
});

test("driver serializes a workflow, stops on stale ownership, and never busy-loops", async () => {
  const fixture = harness(["advanced", "stale"]);
  const driver = new AutonomousWorkflowDriver({ engine: fixture.engine, readWorkflow: fixture.read, maxAdvances: 8 });
  const [first, second] = await Promise.allSettled([driver.start("topic"), driver.resume("topic")]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(fixture.maxConcurrent(), 1);
  assert.equal(fixture.calls.length, 2);
});

test("pause, stop, shutdown, and deadlines abort active work and late completion cannot become success", async () => {
  let resolve!: (value: any) => void;
  const engine = { advance: async () => new Promise((done) => { resolve = done; }) };
  const driver = new AutonomousWorkflowDriver({ engine, readWorkflow: () => ({ revision: 1 }), maxAdvances: 2, deadlineMs: 5_000 });
  const active = driver.start("topic");
  await Promise.resolve();
  assert.equal(driver.stop("topic"), true);
  resolve({ kind: "complete", stage: "complete", message: "late", workflow: { revision: 2 } });
  const result = await active;
  assert.equal(result.outcome, "cancelled");
  assert.notEqual(result.handoff.kind, "complete");
  driver.shutdown();
  await assert.rejects(() => driver.start("other"), /shut down/i);
});

test("deadline aborts active engine work and fences its late result", async () => {
  let cancelled = 0;
  const engine = { advance: async () => new Promise<any>(() => undefined) };
  const driver = new AutonomousWorkflowDriver({
    engine,
    readWorkflow: () => ({ revision: 1 }),
    deadlineMs: 10,
    abortActive: () => { cancelled += 1; },
  });
  const result = await Promise.race([
    driver.start("topic"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("driver deadline did not interrupt active work")), 250)),
  ]);
  assert.equal(result.outcome, "timed-out");
  assert.equal(cancelled, 1);
  assert.notEqual(result.handoff.kind, "complete");
});

test("bounded stage budget yields a terminal budget handoff", async () => {
  const fixture = harness(["advanced", "advanced", "advanced"]);
  const driver = new AutonomousWorkflowDriver({ engine: fixture.engine, readWorkflow: fixture.read, maxAdvances: 2 });
  const result = await driver.start("topic");
  assert.equal(result.outcome, "budget-exhausted");
  assert.equal(result.advances, 2);
});
