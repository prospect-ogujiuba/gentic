import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piSwe, { PI_SWE_ACTIVATION } from "../extensions/pi-swe/index.ts";
import {
  createProductionRuntime,
  qualifyV2Activation,
  registerQualifiedV2Runtime,
  recoverRuntimeWorkflows,
  redactRuntimeText,
} from "../extensions/pi-swe/src/runtime.ts";
import { createWorkflow, reduceWorkflow, type StageReport } from "../extensions/pi-swe/src/workflow.ts";

const parent = (cwd: string) => ({ ownerId: "parent:test", sessionId: "session-test", runtimeId: "runtime-test", cwd, branchLength: 0 });
const runner = { run: async () => ({ ok: false as const, failure: { code: "cancelled" as const, message: "fixture", retryable: false }, attempts: 0 }) };
const inspector = { inspect: () => ({ hash: "snapshot", head: "head", branch: "main", changedPaths: [] as string[] }) };
const closeoutInspector = { inspect: () => ({ snapshot: { hash: "snapshot", head: "head", branch: "main", changedPaths: [] as string[], capturedAt: new Date(0).toISOString() }, cumulativeDelta: "", unresolvedRisks: [] as string[] }), acquireFence: () => () => undefined };

function fakePi(registrations: string[] = []) {
  return {
    registerCommand: (name: string) => { registrations.push(`command:${name}`); },
    registerTool: (tool: { name: string }) => { registrations.push(`tool:${tool.name}`); },
    on: (name: string) => { registrations.push(`hook:${name}`); },
    getAllTools: () => ["read", "grep", "find", "ls", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
  };
}

test("actual production entrypoint remains fail-closed on compatibility registration", () => {
  const registrations: string[] = [];
  piSwe(fakePi(registrations) as never);
  assert.equal(PI_SWE_ACTIVATION, "disabled");
  assert.deepEqual(registrations, ["command:swe", "tool:swe_workflow"]);
});

test("production composition constructs isolated complete runtimes from explicit bounded configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runtime-"));
  try {
    const options = { cwd, pi: fakePi() as never, parent: parent(cwd), provider: "fixture-provider", model: "fixture-model", thinking: "low" as const, qualificationMode: true, overrides: { runner, sourceInspector: inspector, closeoutInspector } };
    const first = createProductionRuntime(options);
    const second = createProductionRuntime(options);
    for (const key of ["engine", "runner", "workspace", "verificationAuthority", "closeoutAuthority", "mutations", "registry", "driver"] as const) assert.ok(first[key], key);
    assert.notEqual(first.registry, second.registry);
    assert.notEqual(first.verificationAuthority, second.verificationAuthority);
    assert.equal(first.config.budgets.maxOutputBytes <= 1_048_576, true);
    assert.equal(first.config.workspace.maxFiles <= 10_000, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("composition fails closed for missing APIs, invalid bounds, and non-qualification fixture providers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runtime-invalid-"));
  try {
    const base = { cwd, parent: parent(cwd), provider: "fixture-provider", model: "fixture-model", thinking: "low" as const, qualificationMode: true, overrides: { runner, sourceInspector: inspector, closeoutInspector } };
    assert.throws(() => createProductionRuntime({ ...base, pi: {} as never }), /required Pi API/i);
    assert.throws(() => createProductionRuntime({ ...base, pi: fakePi() as never, budgets: { maxOutputBytes: Number.MAX_SAFE_INTEGER } }), /bound|budget/i);
    assert.throws(() => createProductionRuntime({ ...base, pi: fakePi() as never, qualificationMode: false }), /fixture provider.*qualification/i);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("activation remains disabled by default and qualification rejects every incomplete prerequisite before registration", () => {
  const base = { requested: false, migrationReady: true, piVersion: "0.84.2", expectedPiVersion: "0.84.2", extensionId: "pi-swe", expectedExtensionId: "pi-swe", repositorySupported: true, requiredTools: ["read", "grep", "find", "ls", "bash"], availableTools: ["read", "grep", "find", "ls", "bash"] };
  assert.deepEqual(qualifyV2Activation(base), { active: false, reason: "v2 activation is disabled; compatibility runtime retained" });
  for (const patch of [{ requested: true, migrationReady: false }, { requested: true, piVersion: "0.0.0" }, { requested: true, extensionId: "other" }, { requested: true, repositorySupported: false }, { requested: true, availableTools: ["read"] }]) {
    const result = qualifyV2Activation({ ...base, ...patch });
    assert.equal(result.active, false);
  }
});

test("two-phase registration performs no side effects unless fully qualified with one complete runtime and aborts on registration failure", () => {
  const registrations: string[] = [];
  const pi = fakePi(registrations);
  const denied = registerQualifiedV2Runtime(pi as never, { active: false, reason: "disabled" });
  assert.equal(denied.active, false);
  assert.deepEqual(registrations, []);
  assert.throws(() => registerQualifiedV2Runtime(pi as never, { active: true, reason: "qualification fixture" }), /complete production runtime/i);
  assert.deepEqual(registrations, []);
  const surface = { registry: { list: () => [], dismiss: () => false, signal: () => false } as never, driver: { start: async () => undefined, resume: async () => undefined, pause: () => false, stop: () => false } as never };
  assert.throws(() => registerQualifiedV2Runtime({ ...pi, registerTool: () => { throw new Error("tool failure"); } } as never, { active: true, reason: "qualification fixture" }, surface), /aborted.*tool failure/i);
});

test("restart recovery fences orphan ownership and leases without deleting durable reports", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-runtime-recovery-"));
  try {
    let workflow = createWorkflow({ topic: "recover-runtime", goal: "recover", now: "2026-01-01T00:00:00.000Z", tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    const report: StageReport = { kind: "plan-review", outcome: "approved", summary: "accepted", findings: [], provenance: { runId: "plan", role: "plan-reviewer", actorId: "reviewer", leaseId: "plan-lease", leaseFence: 1, contractHash: workflow.contract.hash, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" } };
    workflow = { ...workflow, planReview: report };
    workflow = reduceWorkflow(workflow, { type: "start" }, "2026-01-01T00:00:02.000Z").workflow;
    workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "old-parent", sessionId: "old-session", runtimeId: "old-runtime", cwd, claimedAt: "2026-01-01T00:00:03.000Z", valid: true } }, "2026-01-01T00:00:03.000Z").workflow;
    const path = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(workflow)}\n`);
    const outcomes = await recoverRuntimeWorkflows(cwd, { sessionId: "new-session", runtimeId: "new-runtime", now: "2026-01-02T00:00:00.000Z" });
    assert.equal(outcomes.length, 1);
    const recovered = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(recovered.orchestration.parent.valid, false);
    assert.equal(recovered.status, "paused");
    assert.equal(recovered.planReview.summary, "accepted");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("runtime diagnostics redact credential values and common secret assignments", () => {
  const secret = "super-secret-token";
  const output = redactRuntimeText(`token=${secret} Authorization: Bearer ${secret}\n${secret}`, { TOKEN: secret });
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\[REDACTED\]/);
});
