import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readmePath = "extensions/pi-hud/README.md";
const runtimePath = "extensions/pi-hud/src/pi/runtime.ts";

test("the source-owned minimum HUD surface is bounded and non-disruptive", () => {
  const readme = readFileSync(readmePath, "utf8");
  const runtime = readFileSync(runtimePath, "utf8");
  for (const contract of [
    "compact, optional Pi widget",
    "native footer remains authoritative",
    "active model",
    "bounded context pressure",
    "cached Git summary",
    "current coarse activity",
    "Color is supplementary",
    "Narrow layouts",
    "width-bounded",
    "timer-free",
  ]) assert.match(readme, new RegExp(contract, "i"), contract);
  assert.match(readme, /former footer replacement, modal, component toggle matrix, work timer, event history, usage ledger.*removed/i);
  assert.match(runtime, /setWidget\(HUD_WIDGET_ID/);
  assert.doesNotMatch(runtime, /setFooter|registerFooter|setInterval/);
});
