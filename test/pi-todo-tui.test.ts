import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { TodoCoreState } from "../extensions/pi-todo/src/state-core.ts";
import { renderTodoDocketLines, renderTodoProgress } from "../extensions/pi-todo/src/ui/docket.ts";
import { LightweightTodoModal } from "../extensions/pi-todo/src/ui/modal.ts";
import { plainTodoTheme } from "../extensions/pi-todo/src/ui/theme.ts";

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
  assert.match(modal.render(90).join("\n"), /› \[~\] Active task/);
  modal.handleInput("j");
  assert.match(modal.render(90).join("\n"), /› \[ \] Ready task/);
  modal.handleInput(" ");
  assert.match(modal.render(90).join("\n"), /id: ready/);
  modal.handleInput("a");
  assert.match(modal.render(90).join("\n"), /open tasks/);
  assert.doesNotMatch(modal.render(90).join("\n"), /Done task/);
  modal.handleInput("q");
  assert.equal(closed, true);
  assert.ok(renders >= 3);
});
