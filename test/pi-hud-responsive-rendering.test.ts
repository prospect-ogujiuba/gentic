import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { resetConfig, state } from "../extensions/pi-hud/src/app/state.ts";
import { renderGitStatus } from "../extensions/pi-hud/src/ui/components/git.ts";
import { createHudFooterComponent, renderFooterLines, renderNativeFooterLine } from "../extensions/pi-hud/src/ui/surfaces/footer.ts";
import { openModal } from "../extensions/pi-hud/src/ui/surfaces/modal.ts";
import type { GitStatus, HudSnapshot, Theme } from "../extensions/pi-hud/types.ts";

const plainTheme: Theme = { fg: (_color: unknown, text: string) => text };
const ansiTheme: Theme = { fg: (_color: unknown, text: string) => `\x1b[35m${text}\x1b[0m` };

const dirtyGit: GitStatus = {
  branch: "feature/responsive-footer",
  dirty: true,
  stagedCount: 1,
  unstagedCount: 2,
  untrackedCount: 3,
  upstream: "origin/main",
  remoteName: "origin",
  aheadCount: 2,
  behindCount: 1,
};

function snapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    modelId: "anthropic/claude-sonnet",
    thinkingLevel: "high",
    worktreeId: "/repo/gentic",
    git: dirtyGit,
    activeTools: [{ id: "1", toolName: "bash" }],
    toolCounts: { bash: 2, read: 1 },
    recentEvents: ["tool_execution_start", "message_end"],
    ...overrides,
  };
}

function useGoldenComponents(): void {
  resetConfig();
  for (const id of Object.keys(state.components)) {
    state.components[id as keyof typeof state.components] = ["provider", "model", "git", "tools", "events"].includes(id);
  }
  state.toolCounts = { bash: 2, read: 1 };
  state.activeTools = [{ id: "1", toolName: "bash" }];
  state.successCalls = 3;
  state.errorCalls = 1;
  state.warningCalls = 2;
}

function resetRenderState(): void {
  resetConfig();
  state.toolCounts = {};
  state.activeTools = [];
  state.successCalls = 0;
  state.errorCalls = 0;
  state.warningCalls = 0;
}

test("pi-hud responsive golden renders preserve priority at narrow, medium, and wide widths", () => {
  useGoldenComponents();
  try {
    assert.deepEqual(renderFooterLines(snapshot(), plainTheme, 24), [
      "anthropic/claude-sonnet ",
      "gentic · feature/respons",
      "pending 1 · err 1 · warn",
    ]);
    assert.deepEqual(renderFooterLines(snapshot(), plainTheme, 60), [
      "anthropic/claude-sonnet (high)",
      "gentic · feature/responsive-footer(*) · origin · ↓(1)|↑(2) ·",
      "[bash 2] [read 1]   pending 1 · err 1 · warn 2 · ok/fail 3:1",
      "Events | ◆ tool_start ◇ msg_end",
    ]);
    assert.deepEqual(renderFooterLines(snapshot(), plainTheme, 100), [
      "anthropic/claude-sonnet (high)",
      "gentic · feature/responsive-footer(*) · origin · ↓(1)|↑(2) · staged (1)",
      "[bash 2] [read 1]                                           pending 1 · err 1 · warn 2 · ok/fail 3:1",
      "Events | ◆ tool_start ◇ msg_end",
    ]);
  } finally {
    resetRenderState();
  }
});

test("pi-hud render lines stay ANSI-aware and bounded for empty, clean, dirty, error, long, and Unicode inputs", () => {
  resetConfig();
  for (const id of Object.keys(state.components)) state.components[id as keyof typeof state.components] = id === "git" || id === "model";
  try {
    const clean = { ...dirtyGit, branch: "main", dirty: false, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, aheadCount: 0, behindCount: 0 };
    const cases: Array<{ name: string; value: HudSnapshot; expected: RegExp }> = [
      { name: "empty", value: snapshot({ git: undefined, gitState: { status: "unavailable", generation: 1 } }), expected: /no git repo/ },
      { name: "clean", value: snapshot({ git: clean, gitState: { status: "fresh", generation: 1, snapshot: clean, updatedAt: 1 } }), expected: /main/ },
      { name: "dirty", value: snapshot(), expected: /\(\*\)/ },
      { name: "error", value: snapshot({ git: undefined, gitState: { status: "error", generation: 1, error: { code: "timeout", message: "timed out" } } }), expected: /git error/ },
      { name: "long-branch", value: snapshot({ git: { ...dirtyGit, branch: "feature/" + "x".repeat(100) } }), expected: /feature/ },
      { name: "unicode", value: snapshot({ modelId: "提供商/模型🚀", git: { ...dirtyGit, branch: "修复/分支🚀" } }), expected: /模型|修复/ },
    ];

    for (const { name, value, expected } of cases) {
      const lines = renderFooterLines(value, ansiTheme, 48);
      assert.equal(lines.length > 0, true, name);
      assert.equal(lines.every((line) => visibleWidth(line) <= 48), true, name);
      assert.match(lines.join("\n"), expected, name);
    }
  } finally {
    resetRenderState();
  }
});

test("native footer hides legacy internal todo ids", () => {
  const renderTodoStatus = (status: string) => renderNativeFooterLine({
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map([["todo", status]]),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  }, plainTheme, 120);

  assert.equal(
    renderTodoStatus("todo_mte8xdgi_gqe31y Find bulk container startup workflow · verify"),
    "Find bulk container startup workflow · verify",
  );
  assert.equal(
    renderTodoStatus("todo completed todo_mte8xdgi_gqe31y: Find bulk container startup workflow · verify"),
    "todo completed Find bulk container startup workflow · verify",
  );
  assert.equal(
    renderTodoStatus("todo completed Find bulk container startup workflow · verify"),
    "todo completed Find bulk container startup workflow · verify",
  );
});

test("native footer line deterministically compacts long branches, many statuses, Unicode, and ANSI", () => {
  const statuses = new Map([
    ["build", "\x1b[31m⚠ build failed\x1b[0m"],
    ["todo", "待办 3"],
    ["sync", "syncing remote"],
  ]);
  const footerData = {
    getGitBranch: () => "feature/非常に長いブランチ-name",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };

  const narrow = renderNativeFooterLine(footerData, plainTheme, 16);
  const medium = renderNativeFooterLine(footerData, plainTheme, 48);
  const wide = renderNativeFooterLine(footerData, plainTheme, 120);
  assert.match(narrow, /build failed/);
  assert.match(medium, /branch|build failed/);
  assert.match(wide, /branch feature\/非常に長いブランチ-name.*build failed.*待办 3.*syncing remote/);
  for (const [line, width] of [[narrow, 16], [medium, 48], [wide, 120]] as const) assert.equal(visibleWidth(line) <= width, true);
});

test("footer component subscribes once, renders without side effects, and unsubscribes on disposal", () => {
  resetConfig();
  let timerStarts = 0;
  let timerClears = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  let renders = 0;
  let branchChanged!: () => void;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  (globalThis as any).setInterval = () => { timerStarts += 1; return 123; };
  (globalThis as any).clearInterval = () => { timerClears += 1; };

  const footerData = {
    getGitBranch: () => "native-main",
    getExtensionStatuses: () => new Map([["gate", "gate: ready"]]),
    getAvailableProviderCount: () => 1,
    onBranchChange(callback: () => void) {
      subscriptions += 1;
      branchChanged = callback;
      return () => { unsubscriptions += 1; };
    },
  };

  try {
    const component = createHudFooterComponent(snapshot())({ requestRender: () => { renders += 1; } }, plainTheme, footerData);
    assert.equal(timerStarts, 1);
    assert.equal(subscriptions, 1);
    for (let index = 0; index < 3; index += 1) {
      const lines = component.render(50);
      assert.equal(lines.every((line) => visibleWidth(line) <= 50), true);
      assert.match(lines[0], /native-main.*gate: ready/);
    }
    assert.equal(timerStarts, 1);
    assert.equal(subscriptions, 1);
    branchChanged();
    assert.equal(renders, 1);
    component.dispose();
    component.dispose();
    assert.equal(timerClears, 1);
    assert.equal(unsubscriptions, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    resetRenderState();
  }
});

test("modal opening constructs a fresh TUI component each time", async () => {
  const components: unknown[] = [];
  let attached: unknown;
  const owner = {
    attachModal(handle: unknown) { attached = handle; },
    detachModal(handle: unknown) { if (attached === handle) attached = undefined; },
  };
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: undefined,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    ui: {
      async custom(factory: Function) {
        const component = factory({ requestRender() {}, terminal: { rows: 40 } }, plainTheme, {}, () => {});
        components.push(component);
        component.close();
      },
    },
  };

  await openModal(ctx as never, owner as never);
  await openModal(ctx as never, owner as never);
  assert.equal(components.length, 2);
  assert.notStrictEqual(components[0], components[1]);
  assert.equal(attached, undefined);
});

test("renderGitStatus exposes cached error and stale states without invalid fields", () => {
  assert.match(renderGitStatus(snapshot({ git: undefined, gitState: { status: "error", generation: 1, error: { code: "timeout", message: "timeout" } } }), plainTheme), /git error/);
  assert.match(renderGitStatus(snapshot({ gitState: { status: "stale", generation: 1, snapshot: dirtyGit, updatedAt: 1 } }), plainTheme), /stale/);
});
