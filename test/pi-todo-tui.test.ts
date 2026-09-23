import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { TodoCoreState } from "../extensions/pi-swe/src/todo/state-core.ts";
import { renderTodoDocketLines, renderTodoProgress } from "../extensions/pi-swe/src/todo/ui/docket.ts";
import { LightweightTodoModal } from "../extensions/pi-swe/src/todo/ui/modal.ts";
import { plainTodoTheme } from "../extensions/pi-swe/src/todo/ui/theme.ts";

const state: TodoCoreState = {
  order: ["ready", "active", "blocked", "done"],
  activeTodoId: "active",
  todos: {
    ready: { id: "ready", title: "Ready task", status: "ready" },
    active: { id: "active", title: "Active task", status: "in_progress" },
    blocked: { id: "blocked", title: "Blocked task", status: "external_blocked", blockedReason: "waiting on user" },
    done: { id: "done", title: "Done task", status: "completed" },
  },
};

test("lightweight docket restores counters, focus, progress, indentation, and checkboxes", () => {
  const output = renderTodoDocketLines(state, plainTodoTheme, { width: 100, includeDone: true }).join("\n");
  assert.match(output, /TASKS.*Total 4/);
  assert.match(output, /Open 3.*Active 1.*Blocked 1.*Done 1/);
  assert.equal(renderTodoProgress(state, plainTodoTheme), "[□▶⧗■] 1/4 25%");
  assert.match(output, /Active task.*\[□▶⧗■\] 1\/4 25%/);
  assert.match(output, /  \[~\] Active task/);
  assert.match(output, /  \[ \] Ready task/);
  assert.match(output, /  \[⧗\] Blocked task/);
  assert.match(output, /    └─ waiting on user/);
  assert.match(output, /  \[✓\] Done task/);

  for (const line of renderTodoDocketLines(state, plainTodoTheme, { width: 32, includeDone: true })) {
    assert.ok(visibleWidth(line) <= 32, line);
  }
});

test("docket renders reordered nested subtasks and an active breadcrumb", () => {
  const nested: TodoCoreState = {
    order: ["parent", "child-b", "grandchild", "child-a"],
    activeTodoId: "grandchild",
    todos: {
      parent: { id: "parent", title: "Parent", status: "ready" },
      "child-a": { id: "child-a", title: "Child A", status: "ready", parentTodoId: "parent" },
      "child-b": { id: "child-b", title: "Child B", status: "completed", parentTodoId: "parent" },
      grandchild: { id: "grandchild", title: "Grandchild", status: "in_progress", parentTodoId: "child-a" },
    },
  };
  const output = renderTodoDocketLines(nested, plainTodoTheme, { width: 100, includeDone: true }).join("\n");
  assert.match(output, /Total 4 · 3 subtasks/);
  assert.match(output, /Parent → Child A → Grandchild/);
  assert.ok(output.indexOf("[✓] Child B") < output.indexOf("[ ] Child A"));
  assert.match(output, /└─ \[✓\] Child B/);
  assert.match(output, /  └─ \[~\] Grandchild/);
});

test("nested active breadcrumbs do not interfere with modal selection scrolling", () => {
  const order = ["parent", "active", ...Array.from({ length: 15 }, (_, index) => `root-${index}`)];
  const nestedLong: TodoCoreState = {
    order,
    activeTodoId: "active",
    todos: {
      parent: { id: "parent", title: "Parent", status: "ready" },
      active: { id: "active", title: "Active child", status: "in_progress", parentTodoId: "parent" },
      ...Object.fromEntries(Array.from({ length: 15 }, (_, index) => [
        `root-${index}`,
        { id: `root-${index}`, title: `Root ${index}`, status: "ready" as const },
      ])),
    },
  };
  const modal = new LightweightTodoModal({
    state: nestedLong,
    theme: plainTodoTheme,
    requestRender: () => {},
    close: () => {},
    terminalRows: () => 10,
  });

  assert.match(modal.render(72).join("\n"), /Parent → Active child/);
  for (let index = 0; index < 12; index += 1) modal.handleInput("j");
  const output = modal.render(72).join("\n");
  assert.match(output, /› \[ \] Root 10/);
  assert.match(output, /↑ more/);
});

test("lightweight modal keeps keyboard selection visible while navigating long lists", () => {
  const longState: TodoCoreState = {
    order: Array.from({ length: 12 }, (_, index) => `todo-${index}`),
    todos: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `todo-${index}`,
      { id: `todo-${index}`, title: `Task ${index}`, status: "ready" as const },
    ])),
    activeTodoId: undefined,
  };
  const modal = new LightweightTodoModal({
    state: longState,
    theme: plainTodoTheme,
    requestRender: () => {},
    close: () => {},
    terminalRows: () => 10,
  });

  for (let index = 0; index < 8; index += 1) modal.handleInput("j");
  const output = modal.render(72).join("\n");
  assert.match(output, /› \[ \] Task 8/);
  assert.match(output, /↑ more/);
  assert.match(output, /↓ more/);
  for (const line of modal.render(44)) assert.ok(visibleWidth(line) <= 44, line);
});

test("lightweight modal restores keyboard navigation, expansion, filtering, and framing", () => {
  let renders = 0;
  let closed = false;
  const modal = new LightweightTodoModal({
    state,
    theme: plainTodoTheme,
    requestRender: () => { renders += 1; },
    close: () => { closed = true; },
    terminalRows: () => 40,
  });

  assert.match(modal.render(90).join("\n"), /╭.*TODO DOCKET.*╮/);
  assert.match(modal.render(90).join("\n"), /› \[ \] Ready task/);
  modal.handleInput("j");
  assert.match(modal.render(90).join("\n"), /› \[~\] Active task/);
  modal.handleInput(" ");
  assert.match(modal.render(90).join("\n"), /id: active/);
  modal.handleInput("a");
  assert.match(modal.render(90).join("\n"), /open tasks/);
  assert.doesNotMatch(modal.render(90).join("\n"), /Done task/);
  modal.handleInput("q");
  assert.equal(closed, true);
  assert.ok(renders >= 3);
});
