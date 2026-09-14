import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dependencyPath = ".model-artifacts/initiatives/lighten-pi-context/workflow.json";
const specPath = ".model-artifacts/initiatives/lighten-pi-hud/specs/2026-09-14_0526-minimum-widget-surface.md";

test("the minimum HUD surface is gated, bounded, and non-disruptive", () => {
  const dependency = JSON.parse(readFileSync(dependencyPath, "utf8")) as {
    status: string;
    tasks: Array<{ status: string }>;
  };
  const spec = readFileSync(specPath, "utf8");
  const lower = spec.toLowerCase();

  assert.equal(dependency.status, "complete");
  assert.ok(dependency.tasks.every((task) => task.status === "complete"));
  assert.match(spec, /owns one optional widget/);
  for (const group of ["Model", "Context pressure", "Git summary", "Activity"]) {
    assert.ok(spec.includes(`**${group}**`), `missing ${group} group`);
  }
  assert.match(spec, /native footer remains visible and authoritative/);
  for (const exclusion of ["modal or overlay ui", "work timers", "event or tool history", "custom footer"]) {
    assert.ok(lower.includes(exclusion), `missing ${exclusion} exclusion`);
  }
  assert.match(spec, /color is supplementary/);
  assert.match(spec, /do not steal focus/);
  assert.match(spec, /Narrow terminals/);
});
