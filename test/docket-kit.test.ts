import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DocketModal, docketIntent, frame, type DocketIntent } from "../src/ui/docket-kit/modal.ts";
import { padAnsi, leftRight } from "../src/ui/docket-kit/format.ts";

const theme = { fg: (_color: string, text: string) => text };

test("docket-kit clips ANSI and wide characters and frames even narrow widths", () => {
  const styled = "\x1b[31m界界 hello\x1b[0m";
  for (const width of [0, 1, 2, 3, 8, 20, 80]) {
    assert.equal(visibleWidth(padAnsi(styled, width)), width);
    for (const line of [...leftRight(width, styled, "right"), ...frame(theme, width, "界 docket", [styled])]) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }
});

test("docket-kit emits keyboard intents and preserves selection through filtering", () => {
  const intents: DocketIntent[] = [];
  let selected: string | undefined;
  let closes = 0;
  let renders = 0;
  const modal = new DocketModal({
    rows: (all) => (all ? ["done", "open", "later"] : ["open", "later"]).map((id) => ({ id })),
    renderContent: (state) => { selected = state.selectedId; return ["› " + state.selectedId]; },
    theme, title: "test", noun: "items", terminalRows: () => 24,
    close: () => { closes++; }, requestRender: () => { renders++; },
    onIntent: (intent) => { intents.push(intent); },
  });
  modal.handleInput("j"); modal.render(40);
  assert.equal(selected, "open");
  modal.handleInput("a"); modal.render(40);
  assert.equal(selected, "open");
  modal.handleInput(" "); modal.handleInput("x"); modal.handleInput("q");
  assert.deepEqual(intents, ["next", "filter", "expand", "expand-all", "close"]);
  assert.equal(closes, 1); assert.equal(renders, 4);
  assert.equal(docketIntent("\x1b[6~"), "page-next");
  assert.equal(docketIntent("\x1b[5~"), "page-previous");
  assert.equal(docketIntent("z"), undefined);
});

test("docket-kit keeps selected rows visible and handles empty data", () => {
  for (const count of [0, 40]) {
    const modal = new DocketModal({
      rows: () => Array.from({ length: count }, (_, i) => ({ id: String(i) })),
      renderContent: ({ selectedId }) => Array.from({ length: count }, (_, i) => `${String(i) === selectedId ? "›" : " "} row ${i}`),
      theme, title: "test", noun: "items", terminalRows: () => 16, close() {}, requestRender() {},
    });
    for (let i = 0; i < 30; i++) modal.handleInput("j");
    const lines = modal.render(40);
    assert.ok(lines.length <= 12);
    if (count) assert.ok(lines.some((line) => line.includes("› row 30")));
    for (const width of [0, 1, 8, 20]) assert.ok(modal.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("docket-kit imports only presentation dependencies and has no external effects", () => {
  const root = new URL("../src/ui/docket-kit/", import.meta.url);
  for (const file of readdirSync(root).filter((file) => file.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.ok(match[1] === "@earendil-works/pi-tui" || match[1].startsWith("./"), `${file}: ${match[1]}`);
    }
    assert.doesNotMatch(source, /node:|pi-coding-agent|pi-swe|pi-todo|sessionManager|registerTool|registerCommand|setTimeout|setInterval|process\.|readFile|writeFile/);
  }
});
