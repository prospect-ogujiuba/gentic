import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import piSwe, { PI_SWE_ACTIVATION } from "../extensions/pi-swe/index.ts";
import { registerControllerBoundSweCommand } from "../extensions/pi-swe/src/command.ts";
import { readRuntimeSelection, writeRuntimeSelection, REVIEWED_MIGRATION_EVIDENCE_HASH, REVIEWED_READINESS_EVIDENCE_HASH, type Gate2Decision } from "../extensions/pi-swe/src/cutover.ts";
import {
  createProductionRuntime,
  recoverRuntimeWorkflows,
  SharedRuntimeController,
  redactRuntimeText,
  type ControllerRuntimeHandoffOptions,
} from "../extensions/pi-swe/src/runtime.ts";
import { createWorkflow, parseWorkflow, reduceWorkflow, type StageReport } from "../extensions/pi-swe/src/workflow.ts";

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

function resetClonedRolloutAuthority(cwd: string): void {
  const path = join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json");
  const workflow = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
  const reset = {
    ...workflow,
    status: "paused" as const,
    orchestration: {
      ...workflow.orchestration,
      activeRun: undefined,
      parent: undefined,
      runtimeHandoff: undefined,
      history: workflow.orchestration.history.filter((entry) => entry.type !== "runtime-handoff-prepared" && entry.type !== "runtime-handoff-reclaimed" && entry.type !== "runtime-parent-rotated" && entry.type !== "parent-recovered"),
    },
  };
  writeFileSync(path, `${JSON.stringify(reset, null, 2)}\n`);
}

function selectedV2Checkout(rollbackWindowEnd = new Date(Date.now() + 86_400_000).toISOString()): { parent: string; cwd: string; decision: Gate2Decision } {
  const parent = mkdtempSync(join(tmpdir(), "pi-swe-handoff-checkout-"));
  const cwd = join(parent, "checkout");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
  const path = join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json");
  let workflow = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
  workflow = {
    ...workflow,
    status: "paused",
    orchestration: {
      ...workflow.orchestration,
      activeRun: undefined,
      parent: undefined,
      runtimeHandoff: undefined,
      history: workflow.orchestration.history.filter((entry) => entry.type !== "runtime-handoff-prepared" && entry.type !== "runtime-handoff-reclaimed" && entry.type !== "runtime-parent-rotated" && entry.type !== "parent-recovered"),
    },
  };
  const at = new Date().toISOString();
  workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent:session", sessionId: "session", runtimeId: "selected-runtime", cwd, claimedAt: at, valid: true } }, at).workflow;
  workflow = { ...workflow, orchestration: { ...workflow.orchestration, runtimeHandoff: { id: "initial-cutover", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at } } };
  writeFileSync(path, `${JSON.stringify(workflow, null, 2)}\n`);
  const decision: Gate2Decision = { decisionId: "decision", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd, rationale: "reviewed rollback" };
  const empty = readRuntimeSelection(cwd);
  writeRuntimeSelection(cwd, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "initial-cutover", from: "compatibility", to: "v2", preparedWorkflowRevision: workflow.revision, preparedAt: at, selectedAt: at, parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "selected-runtime" } } }, 0, empty.preimageHash!);
  return { parent, cwd, decision };
}

const liveIdentity = { sessionId: "session", runtimeId: "caller-controlled", provider: "openai", model: "test", thinking: "low", branchLength: 0 };
const lifecycleContext = (cwd: string) => ({ cwd, sessionManager: { getBranch: () => [] as readonly unknown[] } });
const GATE2_READINESS_GZIP_BASE64 = "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";
const GATE2_MIGRATION_GZIP_BASE64 = "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";

test("public controller handoff derives wall clock, controlling topic, Pi version, and active ownership preflight internally", () => {
  const noClock: "now" extends keyof ControllerRuntimeHandoffOptions ? true : false = false;
  const noTopic: "topic" extends keyof ControllerRuntimeHandoffOptions ? true : false = false;
  const noPiVersion: "piVersion" extends keyof ControllerRuntimeHandoffOptions ? true : false = false;
  const noTodoCount: "activeTodoCount" extends keyof ControllerRuntimeHandoffOptions ? true : false = false;
  assert.deepEqual([noClock, noTopic, noPiVersion, noTodoCount], [false, false, false, false]);
});

test("production entrypoint registers adapters once behind the shared durable runtime selector", () => {
  const registrations: string[] = [];
  piSwe(fakePi(registrations) as never);
  assert.equal(PI_SWE_ACTIVATION, "runtime-selector");
  assert.deepEqual(registrations, ["hook:session_start", "hook:tool_call", "hook:tool_result", "hook:before_agent_start", "hook:user_bash", "hook:session_shutdown", "command:swe", "tool:swe_workflow"]);
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

test("real shared controller defers action APIs until first live resolve", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-controller-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    let initialized = false;
    let toolReads = 0;
    const pi = { ...fakePi(), getAllTools: () => {
      toolReads += 1;
      if (!initialized) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      return fakePi().getAllTools();
    } };
    const controller = new SharedRuntimeController(pi as never);
    assert.equal(toolReads, 0);
    initialized = true;
    const binding = await controller.resolve(cwd, { sessionId: "session", runtimeId: "context-runtime", provider: "fixture-provider", model: "fixture-model", thinking: "low", branchLength: 0 });
    assert.equal(binding.kind, "compatibility");
    assert.equal(binding.generation, 0);
    assert.equal(toolReads, 1);
    controller.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("SharedRuntimeController restart rotates selector generation and durable parent instead of reusing the selector runtime id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-controller-restart-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const at = "2026-01-01T00:00:00.000Z";
    let workflow = createWorkflow({ topic: "swe-production-rollout", goal: "rollout", now: at, tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent:session", sessionId: "session", runtimeId: "old-runtime", cwd, claimedAt: at, valid: true } }, at).workflow;
    workflow = { ...workflow, orchestration: { ...workflow.orchestration, runtimeHandoff: { id: "cutover", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at } } };
    const path = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(workflow)}\n`);
    const decision: Gate2Decision = { decisionId: "decision", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: "2026-01-20T00:00:00.000Z", rationale: "reviewed" };
    const empty = readRuntimeSelection(cwd);
    assert.equal(empty.status, "selected");
    writeRuntimeSelection(cwd, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "cutover", from: "compatibility", to: "v2", preparedWorkflowRevision: workflow.revision, preparedAt: at, selectedAt: at, parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "old-runtime" } } }, 0, empty.preimageHash!);
    const controller = new SharedRuntimeController(fakePi() as never);
    const binding = await controller.resolve(cwd, { sessionId: "session", runtimeId: "context-runtime", provider: "openai", model: "fixture-model", thinking: "low", branchLength: 0 });
    assert.equal(binding.kind, "v2");
    assert.equal(binding.generation, 2);
    assert.equal(binding.runtime!.engine.options.parent.runtimeId, binding.identity.runtimeId);
    assert.equal(binding.runtime!.engine.options.parent.sessionId, binding.identity.sessionId);
    const selected = readRuntimeSelection(cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.generation, 2);
    assert.notEqual(selected.record!.handoff.parent.runtimeId, "old-runtime");
    const durable = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(durable.orchestration.parent.runtimeId, selected.record!.handoff.parent.runtimeId);
    assert.equal(durable.orchestration.parent.valid, true);
    assert.equal(durable.orchestration.nextFence, workflow.orchestration.nextFence + 1);
    controller.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("explicit same-runtime v2 handoff recovers a fenced cross-session parent from retained selector evidence", async () => {
  const fixture = selectedV2Checkout();
  try {
    const workflowPath = join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json");
    const raw = JSON.parse(readFileSync(workflowPath, "utf8"));
    raw.orchestration.parent.valid = false;
    raw.orchestration.parent.invalidatedAt = new Date().toISOString();
    raw.orchestration.parent.invalidatedReason = "session quit";
    writeFileSync(workflowPath, `${JSON.stringify(raw, null, 2)}\n`);
    const identity = { ...liveIdentity, sessionId: "new-session", runtimeId: "new-session-context" };
    const controller = new SharedRuntimeController(fakePi() as never);
    const receipt = await controller.handoff({ cwd: fixture.cwd, targetRuntime: "v2", identity, lifecycleContext: lifecycleContext(fixture.cwd) });
    assert.equal(receipt.selectedRuntime, "v2");
    assert.equal(receipt.selectorGeneration, 2);
    assert.equal(readRuntimeSelection(fixture.cwd).record?.decision.decisionId, fixture.decision.decisionId);
    const recovered = parseWorkflow(JSON.parse(readFileSync(workflowPath, "utf8")));
    assert.equal(recovered.orchestration.runtimeHandoff?.phase, "reclaimed");
    assert.equal(recovered.orchestration.runtimeHandoff?.selectorGeneration, 2);
    assert.equal(recovered.orchestration.parent?.sessionId, "new-session");
    controller.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("cached slot revalidates exact selector bytes and durable parent authority on every resolve", async () => {
  const fixture = selectedV2Checkout();
  try {
    const controller = new SharedRuntimeController(fakePi() as never);
    const first = await controller.resolve(fixture.cwd, liveIdentity);
    const selectorPath = join(fixture.cwd, ".git", "pi-swe-runtime-selector");
    const rewritten = JSON.parse(readFileSync(selectorPath, "utf8"));
    rewritten.decision.rationale = "valid same-generation rewrite with different exact bytes";
    writeFileSync(selectorPath, `${JSON.stringify(rewritten, null, 2)}\n`, { mode: 0o600 });
    const second = await controller.resolve(fixture.cwd, liveIdentity);
    assert.notEqual(second, first);
    assert.equal(second.generation, first.generation);
    const workflowPath = join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json");
    const raw = JSON.parse(readFileSync(workflowPath, "utf8"));
    raw.orchestration.parent.valid = false;
    raw.orchestration.parent.invalidatedAt = new Date().toISOString();
    raw.orchestration.parent.invalidatedReason = "external authority change";
    writeFileSync(workflowPath, `${JSON.stringify(raw)}\n`);
    const blocked = await controller.resolve(fixture.cwd, liveIdentity);
    assert.equal(blocked.kind, "blocked");
    controller.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("generation-0 compatibility gives every real controller process a fresh nonreused bound parent identity and generation-aware integrity route", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-generation-zero-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const context = { sessionId: "same-session", runtimeId: "session:same-session", provider: "openai", model: "test", thinking: "low", branchLength: 0 };
    const firstController = new SharedRuntimeController(fakePi() as never);
    const first = await firstController.resolve(cwd, context);
    assert.equal(first.kind, "compatibility");
    assert.equal(first.generation, 0);
    assert.notEqual(first.identity.runtimeId, context.runtimeId);
    firstController.shutdown();
    const secondController = new SharedRuntimeController(fakePi() as never);
    const second = await secondController.resolve(cwd, context);
    assert.equal(second.kind, "compatibility");
    assert.notEqual(second.identity.runtimeId, first.identity.runtimeId);
    secondController.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("successful compatibility to v2 cutover uses the real controller and exact reviewed evidence without a validator bypass", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-swe-real-cutover-"));
  const cwd = join(parent, "checkout");
  const readiness = join(parent, "readiness.json");
  const migration = join(parent, "migration.json");
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
    resetClonedRolloutAuthority(cwd);
    writeFileSync(readiness, gunzipSync(Buffer.from(GATE2_READINESS_GZIP_BASE64, "base64")));
    writeFileSync(migration, gunzipSync(Buffer.from(GATE2_MIGRATION_GZIP_BASE64, "base64")));
    chmodSync(readiness, 0o600);
    chmodSync(migration, 0o600);
    const authorizedAt = new Date().toISOString();
    const decision: Gate2Decision = { decisionId: "real-controller-cutover", authorizedBy: "operator", authorizedAt, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "exercise exact reviewed evidence through the real controller" };
    const controller = new SharedRuntimeController(fakePi() as never);
    const receipt = await controller.handoff({ cwd, targetRuntime: "v2", decision, evidence: { readiness, migration }, identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
    assert.equal(receipt.selectedRuntime, "v2");
    assert.equal(receipt.selectorGeneration, 1);
    const selected = readRuntimeSelection(cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.record?.handoff.id, receipt.handoffId);
    const binding = await controller.resolve(cwd, liveIdentity);
    assert.equal(binding.kind, "v2");
    assert.equal(binding.identity.runtimeId, receipt.freshParentRuntimeId);
    assert.equal(binding.runtime!.engine.options.parent.runtimeId, binding.identity.runtimeId);
    controller.shutdown();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

for (const faultStage of ["after-prepare", "after-selector-persist"] as const) {
  test(`initial cutover recovers ${faultStage} from durable attestation after evidence deletion`, async () => {
    const parent = mkdtempSync(join(tmpdir(), `pi-swe-initial-${faultStage}-`));
    const cwd = join(parent, "checkout");
    const readiness = join(parent, "readiness.json");
    const migration = join(parent, "migration.json");
    try {
      execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
      resetClonedRolloutAuthority(cwd);
      writeFileSync(readiness, gunzipSync(Buffer.from(GATE2_READINESS_GZIP_BASE64, "base64")));
      writeFileSync(migration, gunzipSync(Buffer.from(GATE2_MIGRATION_GZIP_BASE64, "base64")));
      chmodSync(readiness, 0o600); chmodSync(migration, 0o600);
      const authorizedAt = new Date().toISOString();
      const decision: Gate2Decision = { decisionId: `initial-${faultStage}`, authorizedBy: "operator", authorizedAt, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "durable recovery attestation" };
      const crashing = new SharedRuntimeController(fakePi() as never, { handoffFault: (stage) => { if (stage === faultStage) throw new Error(`crash ${stage}`); } });
      await assert.rejects(() => crashing.handoff({ cwd, targetRuntime: "v2", decision, evidence: { readiness, migration }, identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) }), new RegExp(`crash ${faultStage}`));
      crashing.shutdown();
      rmSync(readiness); rmSync(migration);
      const recovering = new SharedRuntimeController(fakePi() as never);
      const receipt = await recovering.handoff({ cwd, targetRuntime: "v2", identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
      assert.equal(receipt.decisionId, decision.decisionId);
      assert.equal(readRuntimeSelection(cwd).generation, receipt.selectorGeneration);
      const workflow = parseWorkflow(JSON.parse(readFileSync(join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8")));
      assert.equal(workflow.orchestration.runtimeHandoff?.decision?.decisionId, decision.decisionId);
      assert.equal(workflow.orchestration.runtimeHandoff?.phase, "reclaimed");
      recovering.shutdown();
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}

test("initial cutover recovers after a SIGKILLed controller process at durable prepare", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-swe-killed-prepare-"));
  const cwd = join(parent, "checkout");
  const readiness = join(parent, "readiness.json");
  const migration = join(parent, "migration.json");
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
    resetClonedRolloutAuthority(cwd);
    writeFileSync(readiness, gunzipSync(Buffer.from(GATE2_READINESS_GZIP_BASE64, "base64")));
    writeFileSync(migration, gunzipSync(Buffer.from(GATE2_MIGRATION_GZIP_BASE64, "base64")));
    chmodSync(readiness, 0o600); chmodSync(migration, 0o600);
    const at = new Date().toISOString();
    const decision: Gate2Decision = { decisionId: "killed-initial-prepare", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "kill the initial writer after durable prepare" };
    const moduleUrl = pathToFileURL(resolve(process.cwd(), "extensions/pi-swe/src/runtime.ts")).href;
    const script = `import { writeSync } from "node:fs"; import { SharedRuntimeController } from ${JSON.stringify(moduleUrl)}; const pi={registerCommand(){},registerTool(){},on(){},getAllTools(){return ["read","grep","find","ls","bash"].map(name=>({name,sourceInfo:{source:"builtin",path:"<builtin:"+name+">"}}));}}; const controller=new SharedRuntimeController(pi,{handoffFault(stage){if(stage==="after-prepare"){writeSync(1,"prepared\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}}); await controller.handoff({cwd:process.env.CHECKOUT,targetRuntime:"v2",decision:JSON.parse(process.env.DECISION),evidence:{readiness:process.env.READINESS,migration:process.env.MIGRATION},identity:JSON.parse(process.env.IDENTITY),lifecycleContext:{cwd:process.env.CHECKOUT,sessionManager:{getBranch:()=>[]}}});`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHECKOUT: cwd, READINESS: readiness, MIGRATION: migration, DECISION: JSON.stringify(decision), IDENTITY: JSON.stringify(liveIdentity) } });
    await new Promise<void>((ready, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("prepared")) ready(); });
      child.once("error", reject);
      child.once("exit", (code) => { if (!output.includes("prepared")) reject(new Error(`cutover child exited ${code} before prepare`)); });
    });
    child.kill("SIGKILL");
    await new Promise<void>((done) => child.once("exit", () => done()));
    rmSync(readiness); rmSync(migration);
    const recovering = new SharedRuntimeController(fakePi() as never);
    const receipt = await recovering.handoff({ cwd, targetRuntime: "v2", identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
    assert.equal(receipt.decisionId, decision.decisionId);
    assert.equal(parseWorkflow(JSON.parse(readFileSync(join(cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8"))).orchestration.runtimeHandoff?.phase, "reclaimed");
    recovering.shutdown();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("live runtime command resumes prepared Gate 2 attestation without prompting for deleted evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-command-prepared-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const at = new Date().toISOString();
    const decision: Gate2Decision = { decisionId: "prepared-command", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "resume durable command handoff" };
    let workflow = createWorkflow({ topic: "swe-production-rollout", goal: "rollout", tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    workflow = reduceWorkflow(workflow, { type: "prepare-runtime-handoff", handoff: { id: "prepared", decisionId: decision.decisionId, decision, from: "compatibility", to: "v2", selectorGeneration: 1 } }, at).workflow;
    const path = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
    mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(workflow)}\n`);
    let definition: any;
    let inputCount = 0;
    let handoffOptions: any;
    const resolver = { resolve: async () => { throw new Error("unused"); }, handoff: async (options: any) => { handoffOptions = options; return { handoffId: "prepared", decisionId: decision.decisionId, selectedRuntime: "v2", selectorGeneration: 1, preparedWorkflowRevision: workflow.revision, reclaimedWorkflowRevision: workflow.revision + 1, freshParentRuntimeId: "fresh", rollbackWindowEnd: decision.rollbackWindowEnd }; }, shutdown() {} };
    registerControllerBoundSweCommand({ registerCommand: (_name: string, value: any) => { definition = value; }, sendUserMessage: () => undefined } as never, resolver as never);
    const notifications: string[] = [];
    await definition.handler("runtime cutover", { cwd, hasUI: true, model: { provider: "openai", id: "test" }, thinkingLevel: "low", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => [] }, ui: { input: async () => { inputCount += 1; return undefined; }, confirm: async () => true, notify: (text: string) => notifications.push(text) } });
    assert.equal(inputCount, 0);
    assert.equal(handoffOptions.decision, undefined);
    assert.equal(handoffOptions.evidence, undefined);
    assert.match(notifications.at(-1)!, /runtime cutover complete/i);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("cutover restart rollback restart and re-cutover advance monotonic generations with fresh parents", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-swe-monotonic-cycle-"));
  const cwd = join(parent, "checkout");
  const readiness = join(parent, "readiness.json");
  const migration = join(parent, "migration.json");
  const controllers: SharedRuntimeController[] = [];
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), cwd]);
    resetClonedRolloutAuthority(cwd);
    writeFileSync(readiness, gunzipSync(Buffer.from(GATE2_READINESS_GZIP_BASE64, "base64"))); writeFileSync(migration, gunzipSync(Buffer.from(GATE2_MIGRATION_GZIP_BASE64, "base64")));
    chmodSync(readiness, 0o600); chmodSync(migration, 0o600);
    const at = new Date().toISOString();
    const decision: Gate2Decision = { decisionId: "monotonic-cycle", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: new Date(Date.now() + 86_400_000).toISOString(), rationale: "exercise complete generation cycle" };
    const first = new SharedRuntimeController(fakePi() as never); controllers.push(first);
    const cutover = await first.handoff({ cwd, targetRuntime: "v2", decision, evidence: { readiness, migration }, identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
    first.shutdown();
    const second = new SharedRuntimeController(fakePi() as never); controllers.push(second);
    const restartedV2 = await second.resolve(cwd, liveIdentity);
    const rollback = await second.handoff({ cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
    second.shutdown();
    const third = new SharedRuntimeController(fakePi() as never); controllers.push(third);
    const restartedCompatibility = await third.resolve(cwd, liveIdentity);
    const recutover = await third.handoff({ cwd, targetRuntime: "v2", identity: liveIdentity, lifecycleContext: lifecycleContext(cwd) });
    assert.deepEqual([cutover.selectorGeneration, restartedV2.generation, rollback.selectorGeneration, restartedCompatibility.generation, recutover.selectorGeneration], [1, 2, 3, 4, 5]);
    assert.equal(new Set([cutover.freshParentRuntimeId, restartedV2.identity.runtimeId, rollback.freshParentRuntimeId, restartedCompatibility.identity.runtimeId, recutover.freshParentRuntimeId]).size, 5);
    assert.equal(readRuntimeSelection(cwd).generation, 5);
  } finally {
    for (const controller of controllers) controller.shutdown();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("competing session cannot rotate or fence the selected live parent", async () => {
  const fixture = selectedV2Checkout();
  try {
    const controller = new SharedRuntimeController(fakePi() as never);
    const binding = await controller.resolve(fixture.cwd, { ...liveIdentity, sessionId: "competing" });
    assert.equal(binding.kind, "blocked");
    const workflow = parseWorkflow(JSON.parse(readFileSync(join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8")));
    assert.equal(workflow.orchestration.parent?.valid, true);
    assert.equal(workflow.orchestration.parent?.runtimeId, "selected-runtime");
    assert.equal(readRuntimeSelection(fixture.cwd).generation, 1);
    controller.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("real controller rejects rollback after rollback-window expiry using its wall clock", async () => {
  const fixture = selectedV2Checkout(new Date(Date.now() - 60_000).toISOString());
  try {
    const controller = new SharedRuntimeController(fakePi() as never);
    await assert.rejects(() => controller.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) }), /rollback window has closed/i);
    const selected = readRuntimeSelection(fixture.cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.runtime, "v2");
    controller.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("real controller rollback cutover is atomic and protected verification remains fenced under the fresh compatibility generation", async () => {
  const fixture = selectedV2Checkout();
  try {
    const controller = new SharedRuntimeController(fakePi() as never);
    const receipt = await controller.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) });
    assert.equal(receipt.selectedRuntime, "compatibility");
    const selected = readRuntimeSelection(fixture.cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.record?.selectedRuntime, "compatibility");
    assert.equal(selected.record?.handoff.parent.runtimeId, receipt.freshParentRuntimeId);
    const binding = await controller.resolve(fixture.cwd, liveIdentity);
    assert.equal(binding.identity.runtimeId, receipt.freshParentRuntimeId);
    assert.equal(binding.generation, receipt.selectorGeneration);
    controller.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

for (const faultStage of ["after-prepare", "after-selector-persist"] as const) {
  test(`real controller recovers crash ${faultStage.replaceAll("-", " ")} with one durable selector winner`, async () => {
    const fixture = selectedV2Checkout();
    try {
      const crashing = new SharedRuntimeController(fakePi() as never, { handoffFault: (stage) => { if (stage === faultStage) throw new Error(`crash ${stage}`); } });
      await assert.rejects(() => crashing.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) }), new RegExp(`crash ${faultStage}`));
      crashing.shutdown();
      const recovering = new SharedRuntimeController(fakePi() as never);
      const receipt = await recovering.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) });
      const selected = readRuntimeSelection(fixture.cwd);
      assert.equal(selected.status, "selected");
      assert.equal(selected.generation, receipt.selectorGeneration);
      assert.equal(selected.record?.handoff.id, receipt.handoffId);
      assert.equal(parseWorkflow(JSON.parse(readFileSync(join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8"))).orchestration.runtimeHandoff?.phase, "reclaimed");
      recovering.shutdown();
    } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
  });
}

test("independent real controllers contend through durable CAS and admit one rollback winner", async () => {
  const fixture = selectedV2Checkout();
  const left = new SharedRuntimeController(fakePi() as never);
  const right = new SharedRuntimeController(fakePi() as never);
  try {
    const outcomes = await Promise.allSettled([
      left.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) }),
      right.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    const selected = readRuntimeSelection(fixture.cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.runtime, "compatibility");
    const durable = parseWorkflow(JSON.parse(readFileSync(join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8")));
    assert.equal(durable.orchestration.runtimeHandoff?.selectorGeneration, selected.generation);
    assert.equal(durable.orchestration.parent?.runtimeId, selected.record?.handoff.parent.runtimeId);
  } finally {
    left.shutdown(); right.shutdown();
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("independent controller subprocesses contend through durable workflow and selector CAS", async () => {
  const fixture = selectedV2Checkout();
  try {
    const moduleUrl = pathToFileURL(resolve(process.cwd(), "extensions/pi-swe/src/runtime.ts")).href;
    const script = `import { SharedRuntimeController } from ${JSON.stringify(moduleUrl)}; const pi={registerCommand(){},registerTool(){},on(){},getAllTools(){return ["read","grep","find","ls","bash"].map(name=>({name,sourceInfo:{source:"builtin",path:"<builtin:"+name+">"}}));}}; const controller=new SharedRuntimeController(pi); try { await controller.handoff({cwd:process.env.CHECKOUT,targetRuntime:"compatibility",identity:JSON.parse(process.env.IDENTITY),lifecycleContext:{cwd:process.env.CHECKOUT,sessionManager:{getBranch:()=>[]}}}); controller.shutdown(); } catch(error) { controller.shutdown(); console.error(error instanceof Error?error.message:String(error)); process.exitCode=1; }`;
    const run = () => new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "ignore", env: { ...process.env, CHECKOUT: fixture.cwd, IDENTITY: JSON.stringify(liveIdentity) } });
      child.once("error", reject); child.once("exit", done);
    });
    const codes = await Promise.all([run(), run()]);
    assert.equal(codes.filter((code) => code === 0).length, 1);
    const selected = readRuntimeSelection(fixture.cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.runtime, "compatibility");
    const durable = parseWorkflow(JSON.parse(readFileSync(join(fixture.cwd, ".model-artifacts", "initiatives", "swe-production-rollout", "workflow.json"), "utf8")));
    assert.equal(durable.orchestration.runtimeHandoff?.selectorGeneration, selected.generation);
    assert.equal(durable.orchestration.parent?.runtimeId, selected.record?.handoff.parent.runtimeId);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("reclaim failure publishes neither a provisional runtime slot nor integrity route", async () => {
  const fixture = selectedV2Checkout();
  try {
    const controller = new SharedRuntimeController(fakePi() as never, { handoffFault: (stage) => { if (stage === "before-reclaim") throw new Error("reclaim failed"); } });
    await assert.rejects(() => controller.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) }), /reclaim failed/);
    const blocked = await controller.resolve(fixture.cwd, liveIdentity);
    assert.equal(blocked.kind, "blocked");
    assert.match(blocked.reason!, /matching reclaimed durable parent authority/i);
    controller.shutdown();
    const recovering = new SharedRuntimeController(fakePi() as never);
    const receipt = await recovering.handoff({ cwd: fixture.cwd, targetRuntime: "compatibility", identity: liveIdentity, lifecycleContext: lifecycleContext(fixture.cwd) });
    assert.equal((await recovering.resolve(fixture.cwd, liveIdentity)).identity.runtimeId, receipt.freshParentRuntimeId);
    recovering.shutdown();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
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

test("atomic restart rotation fences leases, clears stale checkpoints, and installs one fresh parser-valid parent", () => {
  const cwd = "/repo";
  const at = "2026-01-01T00:00:00.000Z";
  let workflow = createWorkflow({ topic: "restart-atomic", goal: "rotate", now: at, tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
  workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "owner", sessionId: "session", runtimeId: "runtime-1", cwd, claimedAt: at, valid: true } }, at).workflow;
  workflow = {
    ...workflow,
    orchestration: {
      ...workflow.orchestration,
      nextFence: 8,
      activeRun: { id: "lease", runId: "child", ownerId: "owner", stage: "implementation", taskId: "T1", fence: 7, acquiredAt: at, expiresAt: "2026-01-01T01:00:00.000Z" },
      runtimeHandoff: { id: "first", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at, previousParent: { ownerId: "owner", sessionId: "session", runtimeId: "runtime-0", cwd, claimedAt: at, valid: true } },
    },
    tasks: workflow.tasks.map((task) => ({ ...task, phase: "verification" as const, evidence: [{ command: "node", args: ["--version"], exitCode: 0, at }], verificationCheckpoint: { revision: workflow.revision, at } })),
  };
  const rotated = reduceWorkflow(workflow, { type: "rotate-runtime-parent", handoffId: "restart", decisionId: "decision", from: "v2", to: "v2", selectorGeneration: 2, authority: { ownerId: "owner", sessionId: "session", runtimeId: "runtime-2", cwd, claimedAt: "2026-01-01T00:00:01.000Z", valid: true } }, "2026-01-01T00:00:01.000Z").workflow;
  const parsed = parseWorkflow(JSON.parse(JSON.stringify(rotated)));
  assert.equal(parsed.orchestration.parent?.runtimeId, "runtime-2");
  assert.equal(parsed.orchestration.nextFence, 9);
  assert.equal(parsed.orchestration.activeRun, undefined);
  assert.equal(parsed.tasks[0]!.verificationCheckpoint, undefined);
  assert.deepEqual(parsed.tasks[0]!.evidence, []);
  assert.equal(parsed.orchestration.runtimeHandoff?.selectorGeneration, 2);
  assert.throws(() => reduceWorkflow(parsed, { type: "rotate-runtime-parent", handoffId: "reuse", decisionId: "decision", from: "v2", to: "v2", selectorGeneration: 3, authority: { ...parsed.orchestration.parent!, runtimeId: "runtime-2" } }), /fresh runtime id/i);
});

test("real controller restarts from a parser-valid session shutdown fence with atomic same-session cwd owner rotation and rejects competing session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-fenced-restart-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const at = "2026-01-01T00:00:00.000Z";
    let workflow = createWorkflow({ topic: "swe-production-rollout", goal: "rollout", now: at, tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
    workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "parent:session", sessionId: "session", runtimeId: "old-runtime", cwd, claimedAt: at, valid: true } }, at).workflow;
    workflow = { ...workflow, orchestration: { ...workflow.orchestration, runtimeHandoff: { id: "cutover", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at } } };
    workflow = reduceWorkflow(workflow, { type: "fence-parent", ownerId: "parent:session", sessionId: "session", runtimeId: "old-runtime", reason: "session shutdown" }, at).workflow;
    const path = join(cwd, ".model-artifacts", "initiatives", workflow.topic, "workflow.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(workflow)}\n`);
    const decision: Gate2Decision = { decisionId: "decision", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: "2026-01-20T00:00:00.000Z", rationale: "reviewed" };
    const empty = readRuntimeSelection(cwd);
    writeRuntimeSelection(cwd, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "cutover", from: "compatibility", to: "v2", preparedWorkflowRevision: workflow.revision - 1, preparedAt: at, selectedAt: at, parent: { ownerId: "parent:session", sessionId: "session", runtimeId: "old-runtime" } } }, 0, empty.preimageHash!);
    const competing = new SharedRuntimeController(fakePi() as never);
    const blocked = await competing.resolve(cwd, { sessionId: "other", runtimeId: "ignored", provider: "openai", model: "test", thinking: "low", branchLength: 0 });
    assert.equal(blocked.kind, "blocked");
    competing.shutdown();
    const controller = new SharedRuntimeController(fakePi() as never);
    const binding = await controller.resolve(cwd, { sessionId: "session", runtimeId: "ignored", provider: "openai", model: "test", thinking: "low", branchLength: 0 });
    assert.equal(binding.kind, "v2");
    assert.equal(binding.generation, 2);
    const durable = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(durable.orchestration.parent?.valid, true);
    assert.equal(durable.orchestration.parent?.runtimeId, binding.identity.runtimeId);
    controller.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("selector restart record from equals to is schema-valid and parser-valid", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "extensions/pi-swe/runtime.schema.json"), "utf8"));
  assert.deepEqual(schema.$defs.handoff.properties.from.enum, ["compatibility", "v2"]);
  assert.deepEqual(schema.$defs.handoff.properties.to.enum, ["compatibility", "v2"]);
  const cwd = mkdtempSync(join(tmpdir(), "pi-swe-selector-restart-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const at = "2026-01-01T00:00:00.000Z";
    const decision: Gate2Decision = { decisionId: "decision", authorizedBy: "operator", authorizedAt: at, readinessEvidenceHash: REVIEWED_READINESS_EVIDENCE_HASH, migrationEvidenceHash: REVIEWED_MIGRATION_EVIDENCE_HASH, targetRuntime: "v2", rollbackSelector: "compatibility", rollbackWindowEnd: "2026-01-20T00:00:00.000Z", rationale: "reviewed" };
    const empty = readRuntimeSelection(cwd);
    writeRuntimeSelection(cwd, { schemaVersion: 1, generation: 1, selectedRuntime: "v2", controllingTopic: "swe-production-rollout", decision, handoff: { id: "restart", from: "v2", to: "v2", preparedWorkflowRevision: 1, preparedAt: at, selectedAt: at, parent: { ownerId: "owner", sessionId: "session", runtimeId: "fresh" } } }, 0, empty.preimageHash!);
    const selected = readRuntimeSelection(cwd);
    assert.equal(selected.status, "selected");
    assert.equal(selected.record?.handoff.from, selected.record?.handoff.to);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("reclaimed shutdown fence remains parser-valid and cannot retain a live lease or checkpoint", () => {
  const cwd = "/repo";
  const at = "2026-01-01T00:00:00.000Z";
  let workflow = createWorkflow({ topic: "shutdown-fence", goal: "fence", now: at, tasks: [{ id: "T1", title: "work", writeScope: ["src/**"], nonGoals: [], verification: [{ command: "node", args: ["--version"] }] }] });
  workflow = reduceWorkflow(workflow, { type: "claim-parent", authority: { ownerId: "owner", sessionId: "session", runtimeId: "runtime-1", cwd, claimedAt: at, valid: true } }, at).workflow;
  workflow = { ...workflow, orchestration: { ...workflow.orchestration, runtimeHandoff: { id: "handoff", decisionId: "decision", from: "compatibility", to: "v2", phase: "reclaimed", selectorGeneration: 1, preparedAt: at, reclaimedAt: at } } };
  const fenced = reduceWorkflow(workflow, { type: "fence-parent", ownerId: "owner", sessionId: "session", runtimeId: "runtime-1", reason: "session shutdown" }, "2026-01-01T00:00:01.000Z").workflow;
  assert.equal(parseWorkflow(JSON.parse(JSON.stringify(fenced))).orchestration.parent?.valid, false);
  assert.throws(() => reduceWorkflow(workflow, { type: "invalidate-parent", ownerId: "owner", sessionId: "session", runtimeId: "runtime-1", reason: "unsafe split transition" }), /atomic parent fence/i);
});

test("runtime diagnostics redact credential values and common secret assignments", () => {
  const secret = "super-secret-token";
  const output = redactRuntimeText(`token=${secret} Authorization: Bearer ${secret}\n${secret}`, { TOKEN: secret });
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\[REDACTED\]/);
});
