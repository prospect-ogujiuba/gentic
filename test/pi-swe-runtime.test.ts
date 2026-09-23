import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import piSwe from "../extensions/pi-swe/index.ts";
import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { InitiativeStore, initiativePath } from "../extensions/pi-swe/src/app/store.ts";
import { VerificationCollector } from "../extensions/pi-swe/src/app/verification.ts";
import { getSweCommandCompletions } from "../extensions/pi-swe/src/pi/register.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-runtime-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/bug.ts"), "export const fixed = true;\n");
  const value = structuredClone(bootstrap);
  value.id = "one-task";
  value.status = "draft";
  value.acceptanceCriteria = [value.acceptanceCriteria[5]];
  value.practices = [{ ...value.practices[3], appliesTo: ["W-1"] }];
  value.obligations = [value.obligations[0]];
  value.work = [{ ...value.work[1], parentId: undefined, status: "pending" }];
  value.artifacts = [];
  value.evidence = [];
  value.decisions = [];
  value.risks = [];
  const path = initiativePath(root, "one-task");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const store = new InitiativeStore(root);
  const collector = new VerificationCollector(root);
  return { root, store, collector, service: new SweService(root, store, collector) };
}

test("minimal Pi surface registers one command/tool and never internally executes verification", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let execCalls = 0;
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    appendEntry() {},
    exec() { execCalls += 1; throw new Error("must not bypass ordinary bash permissions"); },
  };
  piSwe(pi as never);
  assert.deepEqual([...commands.keys()], ["swe"]);
  assert.deepEqual([...tools.keys()], ["swe"]);
  assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "context", "session_start", "tool_call", "tool_result"]);
  assert.match(tools.get("swe").promptGuidelines.join(" "), /ordinary bash/i);
  assert.match(tools.get("swe").promptGuidelines.join(" "), /self-review.*not independent/i);
  assert.equal(execCalls, 0);
  assert.deepEqual(getSweCommandCompletions("").map((item) => item.value), ["plan", "open", "list", "status", "next", "start", "implemented", "complete", "resume", "pause"]);
  const notifications: Array<{ message: string; level: string }> = [];
  await commands.get("swe").handler("", {
    cwd: process.cwd(),
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
  });
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /No focused SWE initiative.*Type a space after an action or topic/s);
});

test("command completion discovers initiatives and offers action-aware work", async () => {
  const { root, service } = fixture();
  try {
    const status = getSweCommandCompletions("status ", { cwd: root, focusedInitiativeId: "one-task" });
    assert.equal(status.length, 1);
    assert.deepEqual({ value: status[0].value, label: status[0].label }, { value: "status one-task", label: "one-task" });
    assert.match(status[0].description ?? "", /focused · draft · r\d+ · 0\/1 complete · W-1:/);
    assert.deepEqual(getSweCommandCompletions("resume ", { cwd: root }).map((item) => item.value), ["resume one-task"]);
    assert.deepEqual(getSweCommandCompletions("pause ", { cwd: root }), []);

    const ready = getSweCommandCompletions("start one-task ", { cwd: root });
    assert.deepEqual(ready.map((item) => item.value), ["start one-task W-1"]);
    assert.match(ready[0].description ?? "", /^ready ·/);

    await service.start("one-task", "W-1");
    assert.deepEqual(getSweCommandCompletions("pause ", { cwd: root }).map((item) => item.value), ["pause one-task"]);
    assert.deepEqual(getSweCommandCompletions("implemented one-task ", { cwd: root }).map((item) => item.value), ["implemented one-task W-1"]);

    await service.markImplemented("one-task", "W-1");
    const completable = getSweCommandCompletions("complete one-task ", { cwd: root });
    assert.deepEqual(completable.map((item) => item.value), ["complete one-task W-1"]);
    assert.match(completable[0].description ?? "", /blocked: missing machine-command evidence/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command completion ignores malformed and non-canonical initiative directories", () => {
  const { root } = fixture();
  try {
    const malformed = join(root, ".model-artifacts", "initiatives", "broken-work");
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, "workflow.json"), "{not-json\n");
    const nonCanonical = join(root, ".model-artifacts", "initiatives", "Not-Canonical");
    mkdirSync(nonCanonical, { recursive: true });
    writeFileSync(join(nonCanonical, "workflow.json"), "{}\n");
    assert.deepEqual(getSweCommandCompletions("status ", { cwd: root }).map((item) => item.value), ["status one-task"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one-task flow records RED then GREEN through ordinary bash hooks and completes after restart", async () => {
  const { root, service } = fixture();
  try {
    await service.start("one-task", "W-1");
    const red = service.prepareVerification("one-task", { workId: "W-1", obligationIds: ["O-1"], command: "node --test test/bug.test.ts", relevantPaths: ["src/bug.ts"] });
    assert.equal(service.observeToolCall({ toolCallId: "red", toolName: "bash", input: { command: red.command } }, root), true);
    await service.observeToolResult({ toolCallId: "red", toolName: "bash", input: { command: red.command }, isError: true, content: [{ type: "text", text: "intended assertion failure" }] });

    await service.markImplemented("one-task", "W-1");
    const green = service.prepareVerification("one-task", { workId: "W-1", obligationIds: ["O-1"], command: red.command, relevantPaths: ["src/bug.ts"] });
    service.observeToolCall({ toolCallId: "green", toolName: "bash", input: { command: green.command } }, root);
    await service.observeToolResult({ toolCallId: "green", toolName: "bash", input: { command: green.command }, isError: false, content: [{ type: "text", text: "pass" }] });
    await service.recordReview("one-task", {
      workId: "W-1", obligationIds: ["O-1"], outcome: "passed", relevantPaths: ["src/bug.ts"],
      dimensions: ["correctness", "retirement-boundary"], summary: "The focused flow preserves the intended retirement boundary.", sessionId: "test-session",
    });

    const restarted = new SweService(root, new InitiativeStore(root), new VerificationCollector(root));
    const completed = await restarted.complete("one-task", "W-1");
    assert.equal(completed.initiative.work[0].status, "complete");
    assert.equal(completed.initiative.evidence.map((item) => `${item.kind}:${item.outcome}`).join(","), "machine-command:failed,machine-command:passed,model-review:passed");
    assert.equal(new InitiativeStore(root).read("one-task").initiative.work[0].status, "complete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification evidence remains bound to the prepared initiative when selection changes", async () => {
  const { root, service } = fixture();
  try {
    const firstPath = initiativePath(root, "one-task");
    const otherPath = initiativePath(root, "other-task");
    const other = { ...JSON.parse(readFileSync(firstPath, "utf8")), id: "other-task" };
    mkdirSync(dirname(otherPath), { recursive: true });
    writeFileSync(otherPath, `${JSON.stringify(other, null, 2)}\n`);

    await service.start("one-task", "W-1");
    const prepared = service.prepareVerification("one-task", { workId: "W-1", obligationIds: ["O-1"], command: "npm test", relevantPaths: ["src/bug.ts"] });
    service.status("other-task");
    service.observeToolCall({ toolCallId: "bound", toolName: "bash", input: { command: prepared.command } }, root);
    await service.observeToolResult({ toolCallId: "bound", toolName: "bash", isError: false, content: [{ type: "text", text: "pass" }] });

    assert.equal(service.status("one-task").initiative.evidence.length, 1);
    assert.equal(service.status("other-task").initiative.evidence.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pause/resume is durable and next is dependency-derived", async () => {
  const { root, service } = fixture();
  try {
    assert.equal(service.next("one-task")?.id, "W-1");
    await service.pause("one-task");
    assert.equal(new InitiativeStore(root).read("one-task").initiative.status, "paused");
    await service.resume("one-task");
    assert.equal(new InitiativeStore(root).read("one-task").initiative.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
