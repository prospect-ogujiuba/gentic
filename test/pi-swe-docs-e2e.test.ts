import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("operator documentation covers the complete managed lifecycle and trust boundary", () => {
  const docs = read("extensions/pi-swe/README.md");
  for (const heading of [
    "Role and concern routing",
    "Fresh context and independent judgment",
    "Clarification",
    "Workflow and task transitions",
    "Dependency setup",
    "Manual validation",
    "Post-integration repair",
    "Native run inspection",
    "Upgrade and migration",
  ]) assert.match(docs, new RegExp(`^#{2,4} ${heading}`, "m"), heading);

  for (const required of [
    /plan review[^]*implementation[^]*independent review[^]*safe integration[^]*protected[^]*final initiative acceptance/i,
    /workflow\.json[^]*sole mutable authority/i,
    /explicitly trusted tool[^]*not an OS sandbox/i,
    /fresh process[^]*does not guarantee independent judgment/i,
    /question ID[^]*durable answer/i,
    /dirty index[^]*untracked[^]*sensitive/i,
    /binary[^]*file mode[^]*symlink/i,
    /manual validation[^]*cannot replace independent final acceptance/i,
    /source-changing verification[^]*remediation/i,
    /non-PTY[^]*\/swe work inspect[^]*\/swe work runs/i,
    /interactive-shell `?\/attach`? does not apply/i,
    /v1[^]*explicit audited migration[^]*no start, resume, or ordinary service call upgrades/i,
    /legacy[^]*layout conflict/i,
    /commit, push, deploy, release[^]*separate authorization/i,
  ]) assert.match(docs, required);
});

test("retired compatibility execution preserves v1 readers and explicit migration support", () => {
  const entrypoint = read("extensions/pi-swe/index.ts");
  assert.match(entrypoint, /registerSweCommand\(pi\)/);
  assert.match(entrypoint, /registerSweWorkflowTool\(pi\)/);
  assert.doesNotMatch(entrypoint, /OrchestrationEngine|registerParentIntegrity|AgentRunner|GitWorkspaceManager/);

  const docs = read("extensions/pi-swe/README.md");
  assert.match(docs, /managed execution is v2-only/i);
  assert.match(docs, /v1 workflows and artifacts remain readable and migratable through Gentic 1\.0/i);
  assert.match(docs, /v1 start, resume, verification, completion, single-parent fallback, and runtime rollback execution are retired/i);
  assert.match(docs, /migration rollback[^]*does not re-enable v1 execution/i);
});

test("slash-command and tool adapters share managed ownership and cannot expose a completion bypass", () => {
  const command = read("extensions/pi-swe/src/command.ts");
  const tool = read("extensions/pi-swe/src/tool.ts");
  for (const source of [command, tool]) {
    assert.match(source, /WorkflowControlService/);
    assert.match(source, /coordinatedActiveTodo/);
    assert.match(source, /start.*resume.*pause.*stop/s);
  }
  assert.doesNotMatch(command, /work complete|transitionAction.*complete/);
  assert.match(tool, /managed multi-agent completion must advance through OrchestrationEngine/);
  assert.match(command, /interactive keyboard-accessible user decision/);
});

test("deterministic behavioral fixtures cover every final-phase adversarial family", () => {
  const fixtures = [
    "test/pi-swe-store.test.ts",
    "test/pi-swe-agent-runner.test.ts",
    "test/pi-swe-workspace.test.ts",
    "test/pi-swe-orchestration.test.ts",
    "test/pi-swe-tool.test.ts",
    "test/pi-swe-command.test.ts",
    "test/pi-swe-closeout.test.ts",
  ].map(read).join("\n");
  for (const behavior of [
    /v1 reads are non-mutating.*implicit service mutation fails closed pending explicit migration/i,
    /canonical and legacy artifact layouts cannot silently shadow/i,
    /dirty bytes.*index untouched/i,
    /untracked inputs are explicit/i,
    /additions, deletions, renames, modes and symlinks/i,
    /unsupported repository features/i,
    /whole-source drift/i,
    /competing parent sessions/i,
    /stale child completion/i,
    /abort cancellation/i,
    /crash/i,
    /expired leases/i,
    /budget reset requires an explicit audited decision/i,
    /plan rejection and clarification/i,
    /concern reviewer/i,
    /verification failure and source-changing verification/i,
    /scoped follow-up work/i,
    /manual validation/i,
    /cannot directly complete the workflow/i,
    /late exit/i,
    /dismissing.*cannot delete durable accepted report metadata/i,
    /todo ownership/i,
  ]) assert.match(fixtures, behavior);
});
