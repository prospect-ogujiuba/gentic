import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listWorkflowTopics } from "../extensions/pi-swe/src/store.ts";
import { createWorkflow, reduceWorkflow } from "../extensions/pi-swe/src/workflow.ts";
import { hasActiveSweWorkflow } from "../extensions/pi-todo/src/pi/swe-ownership.ts";

test("workflow ownership scans reject symlinked topic ancestry", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "gentic-workflow-outside-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "workflow.json"), JSON.stringify({ version: 1, status: "complete" }));
    symlinkSync(outside, join(root, "redirect"), "dir");
    assert.throws(() => listWorkflowTopics(cwd), /symlink|incomplete/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /symlink|incomplete/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("todo ownership shares pi-swe discovery and releases blocked workflows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-blocked-"));
  try {
    const now = "2026-09-14T00:00:00.000Z";
    let workflow = createWorkflow({
      topic: "blocked-topic",
      goal: "test ownership",
      now,
      tasks: [{ id: "T1", title: "blocked", assessmentStatus: "assessed", approaches: [], approachReasons: {}, verification: [] }],
    });
    workflow = reduceWorkflow(workflow, { type: "start" }, now).workflow;
    workflow = reduceWorkflow(workflow, { type: "block", reason: "external" }, now).workflow;
    const topicDir = join(cwd, ".model-artifacts", "initiatives", "blocked-topic");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "workflow.json"), JSON.stringify(workflow));

    const ignoredDir = join(topicDir, "reports", "example");
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(join(ignoredDir, "workflow.json"), JSON.stringify({ ...workflow, status: "active", activeTask: "T1", tasks: [{ ...workflow.tasks[0], status: "active" }] }));
    assert.deepEqual(listWorkflowTopics(cwd), ["blocked-topic"]);
    assert.equal(hasActiveSweWorkflow(cwd), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow ownership scans bound wide directory materialization", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-wide-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    mkdirSync(root, { recursive: true });
    for (let index = 0; index <= 1_000; index += 1) writeFileSync(join(root, `.entry-${index}`), "");
    assert.throws(() => listWorkflowTopics(cwd), /entry limit|incomplete/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /entry limit|incomplete/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bounded workflow ownership scans fail closed when completeness cannot be proven", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gentic-workflow-bound-"));
  try {
    const root = join(cwd, ".model-artifacts", "initiatives");
    for (let index = 0; index <= 100; index += 1) {
      const directory = join(root, `topic-${String(index).padStart(3, "0")}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "workflow.json"), JSON.stringify({ version: 1, status: "complete" }));
    }
    assert.throws(() => listWorkflowTopics(cwd), /scan.*(?:limit|incomplete)|too many workflows/i);
    assert.throws(() => hasActiveSweWorkflow(cwd), /scan.*(?:limit|incomplete)|too many workflows/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
