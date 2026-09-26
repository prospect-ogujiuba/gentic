import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import piSwe from "../extensions/pi-swe/index.ts";
import { initiativePath } from "../extensions/pi-swe/src/app/store.ts";
import { projectSweDocket, renderSweDocketLines } from "../extensions/pi-swe/src/ui/docket.ts";
import { SweDocketModal } from "../extensions/pi-swe/src/ui/modal.ts";
import { plainSweTheme } from "../extensions/pi-swe/src/ui/theme.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-docket-"));
  const initiative = structuredClone(bootstrap);
  initiative.revision = 1;
  initiative.evidence = [];
  initiative.work = initiative.work.map((item: { id: string; kind: string }) => item.kind === "phase" ? item : {
    ...item,
    status: ["W-1", "W-2", "W-3", "W-4"].includes(item.id) ? "complete" : "pending",
  });
  const path = initiativePath(root, initiative.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(initiative, null, 2)}\n`);
  return { root, initiative };
}

function runtime() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    on() {},
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    appendEntry() {},
    sendMessage() {},
  };
  piSwe(pi as never);
  return { commands, tools };
}

test("SWE docket is a bounded canonical graph projection with distinct implemented state", () => {
  const initiative = structuredClone(bootstrap);
  initiative.work = initiative.work.map((item: any) => item.id === "W-5" ? { ...item, status: "implemented" }
    : item.id === "W-6" ? { ...item, status: "pending" }
    : item);
  const docket = projectSweDocket(initiative);
  assert.equal(docket.initiativeId, "pi-swe-foundation");
  assert.equal(docket.items.find((item) => item.id === "W-5")?.status, "implemented");
  assert.equal(docket.items.find((item) => item.id === "W-6")?.ready, false);
  assert.equal(docket.items.find((item) => item.id === "W-5")?.depth, 1);

  const output = renderSweDocketLines(docket, plainSweTheme, { width: 180, includeDone: true, limit: 20 }).join("\n");
  assert.match(output, /SWE WORK.*pi-swe-foundation/);
  assert.match(output, /W-5.*implemented/i);
  assert.match(output, /W-6.*waiting on W-5/i);
  for (const line of renderSweDocketLines(docket, plainSweTheme, { width: 36, includeDone: true, limit: 6 })) {
    assert.ok(visibleWidth(line) <= 36, line);
  }
  assert.ok(renderSweDocketLines(docket, plainSweTheme, { includeDone: true, limit: 6 }).length <= 11);
});

test("SWE docket retains keyboard navigation, expansion, filtering, scrolling, and framing", () => {
  const docket = projectSweDocket(bootstrap);
  let renders = 0;
  let closed = false;
  let terminalRows = 10;
  const modal = new SweDocketModal({
    docket,
    theme: plainSweTheme,
    requestRender: () => { renders += 1; },
    close: () => { closed = true; },
    terminalRows: () => terminalRows,
  });
  modal.handleInput("j");
  assert.match(modal.render(72).join("\n"), /↓ more/);
  terminalRows = 40;
  modal.handleInput(" ");
  assert.match(modal.render(72).join("\n"), /id:/);
  modal.handleInput("a");
  assert.match(modal.render(72).join("\n"), /open work/);
  modal.handleInput("q");
  assert.equal(closed, true);
  assert.ok(renders >= 3);
  for (const line of modal.render(44)) assert.ok(visibleWidth(line) <= 44, line);
});

test("SWE command views and mutations use the canonical service and completion gate", async () => {
  const { root } = fixture();
  try {
    const { commands, tools } = runtime();
    const notices: Array<{ message: string; level: string }> = [];
    let modalOutput = "";
    const ctx = {
      cwd: root,
      hasUI: false,
      mode: "rpc",
      sessionManager: { getSessionId: () => "docket-test" },
      ui: {
        notify(message: string, level: string) { notices.push({ message, level }); },
        async custom(factory: Function) { modalOutput = factory({ requestRender() {}, terminal: { rows: 20 } }, plainSweTheme, {}, () => {}).render(70).join("\n"); },
      },
    };
    const command = commands.get("swe");
    await command.handler("list", ctx);
    const initiativeList = notices.at(-1)?.message ?? "";
    assert.match(initiativeList, /SWE INITIATIVES · 1 total/);
    const initiativeLines = initiativeList.split("\n");
    assert.equal(initiativeLines[2], "pi-swe-foundation");
    assert.match(initiativeLines[3] ?? "", /^  ○ r1 · 4\/7 done · active · next W-5: Adapt TODO presentation and commands to the canonical graph$/);
    assert.equal(initiativeLines.length, 4);
    assert.doesNotMatch(initiativeList, /Objective:|Work:/);
    await command.handler("", ctx);
    assert.match(notices.at(-1)?.message ?? "", /No focused SWE initiative/);

    await command.handler("list pi-swe-foundation", ctx);
    assert.match(notices.at(-1)?.message ?? "", /W-5.*pending/);
    await command.handler("", ctx);
    assert.match(notices.at(-1)?.message ?? "", /Focused: pi-swe-foundation/);
    await command.handler("list", ctx);
    assert.match(notices.at(-1)?.message ?? "", /pi-swe-foundation\n  ● r1 · 4\/7 done · active/);
    await command.handler("open pi-swe-foundation", ctx);
    assert.match(notices.at(-1)?.message ?? "", /SWE WORK/);

    await command.handler("start pi-swe-foundation W-5", ctx);
    assert.match(notices.at(-1)?.message ?? "", /W-5 \[active\]/);
    await command.handler("implemented pi-swe-foundation W-5", ctx);
    assert.match(notices.at(-1)?.message ?? "", /W-5 \[implemented\]/);
    await command.handler("complete pi-swe-foundation W-5", ctx);
    assert.equal(notices.at(-1)?.level, "error");
    assert.match(notices.at(-1)?.message ?? "", /missing machine-command evidence/i);

    const status = await tools.get("swe").execute("status", { action: "status", initiativeId: "pi-swe-foundation" }, new AbortController().signal, () => {}, ctx);
    assert.equal(status.details.initiative.work.find((item: any) => item.id === "W-5").status, "implemented");
    assert.equal(modalOutput, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("responsive initiative list preserves full terminal names in two-line rows", async () => {
  const { root, initiative } = fixture();
  try {
    initiative.status = "complete";
    initiative.work = initiative.work.map((item: { kind: string }) => item.kind === "phase" ? item : { ...item, status: "complete" });
    writeFileSync(initiativePath(root, initiative.id), `${JSON.stringify(initiative, null, 2)}\n`);
    const longInitiative = {
      ...structuredClone(initiative),
      id: "initiative-with-an-extremely-long-canonical-name-for-width-testing",
      artifacts: [],
    };
    const longPath = initiativePath(root, longInitiative.id);
    mkdirSync(dirname(longPath), { recursive: true });
    writeFileSync(longPath, `${JSON.stringify(longInitiative, null, 2)}\n`);
    const { commands } = runtime();
    const notices: string[] = [];
    await commands.get("swe").handler("list", {
      cwd: root,
      ui: { notify(message: string) { notices.push(message); } },
    });
    const output = notices.at(-1) ?? "";
    const lines = output.split("\n");
    const longName = "initiative-with-an-extremely-long-canonical-name-for-width-testing";
    const longNameIndex = lines.indexOf(longName);
    assert.ok(longNameIndex >= 2);
    assert.match(lines[longNameIndex + 1] ?? "", /^  ○ r1 · 7\/7 done · complete$/);
    assert.match(output, /pi-swe-foundation\n  ○ r1 · 7\/7 done · complete/);
    assert.equal(lines.slice(2).length, 4);
    assert.doesNotMatch(output, /…|Objective:|Work:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pi-swe lifecycle core has no pi-todo dependency", () => {
  for (const path of [
    "extensions/pi-swe/src/app/service.ts",
    "extensions/pi-swe/src/app/store.ts",
    "extensions/pi-swe/src/pi/register.ts",
    "extensions/pi-swe/src/domain/completion.ts",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), /pi-todo/);
  }
});
