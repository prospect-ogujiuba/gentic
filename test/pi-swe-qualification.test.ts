import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SweService } from "../extensions/pi-swe/src/app/service.ts";
import { InitiativeStore, initiativePath } from "../extensions/pi-swe/src/app/store.ts";
import { buildSweContextProjection } from "../extensions/pi-swe/src/pi/context.ts";
import { parseInitiative } from "../extensions/pi-swe/src/domain/initiative.ts";
import { projectSweDocket, renderSweDocketLines } from "../extensions/pi-swe/src/ui/docket.ts";
import { plainSweTheme } from "../extensions/pi-swe/src/ui/theme.ts";

const bootstrap = JSON.parse(readFileSync(new URL("./fixtures/pi-swe-foundation.json", import.meta.url), "utf8"));

function lightInitiative() {
  const criterion = structuredClone(bootstrap.acceptanceCriteria.find((item: { id: string }) => item.id === "AC-6"));
  const practice = structuredClone(bootstrap.practices.find((item: { id: string }) => item.id === "P-4"));
  const obligation = structuredClone(bootstrap.obligations.find((item: { id: string }) => item.id === "O-1"));
  const work = structuredClone(bootstrap.work.find((item: { id: string }) => item.id === "W-1"));
  return parseInitiative({
    ...structuredClone(bootstrap),
    id: "small-fix",
    revision: 1,
    status: "draft",
    objective: "Repair one bounded defect without unrelated process ceremony.",
    scope: { in: ["one bounded defect"], out: ["unrelated refactors"] },
    constraints: ["Keep authority and verification bounded."],
    acceptanceCriteria: [criterion],
    assessment: {
      depth: "light",
      reason: "One local behavior with a deterministic verification seam.",
      surfaces: ["extension-api"],
      unknowns: [],
    },
    practices: [{ ...practice, appliesTo: ["W-1"] }],
    obligations: [obligation],
    work: [{
      ...work,
      parentId: undefined,
      title: "Repair the bounded defect",
      status: "pending",
      dependsOn: [],
      criterionIds: ["AC-6"],
      obligationIds: ["O-1"],
      testing: {
        approach: "test-after",
        reason: "Qualify the integrated behavior after the focused implementation; this is not retrospective TDD.",
      },
    }],
    artifacts: [],
    evidence: [],
    decisions: [],
    risks: [],
    bootstrap: undefined,
  });
}

test("a light one-task initiative stays proportional while retaining canonical gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-small-"));
  try {
    const initiative = lightInitiative();
    assert.equal(initiative.assessment.depth, "light");
    assert.equal(initiative.work.length, 1);
    assert.equal(initiative.work.some((item) => item.kind === "phase"), false);
    assert.equal(initiative.practices.length, 1);
    assert.equal(initiative.obligations.length, 1);
    assert.equal(initiative.work[0].testing?.approach, "test-after");

    const path = initiativePath(root, initiative.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(initiative, null, 2)}\n`);
    const service = new SweService(root, new InitiativeStore(root));
    assert.equal(service.next(initiative.id)?.id, "W-1");
    await service.start(initiative.id, "W-1");
    await service.markImplemented(initiative.id, "W-1");
    assert.match(service.completionBlockers(initiative.id, "W-1").join(" "), /missing machine-command evidence/i);

    const restarted = new SweService(root, new InitiativeStore(root));
    assert.equal(restarted.status(initiative.id).initiative.work[0].status, "implemented");
    assert.ok(buildSweContextProjection(restarted.status(initiative.id).initiative, { maxChars: 2_000 }).length <= 2_000);
    const lines = renderSweDocketLines(projectSweDocket(restarted.status(initiative.id).initiative), plainSweTheme, { width: 52, limit: 4 });
    assert.ok(lines.length <= 9);
    assert.match(lines.join("\n"), /implemented/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported workflow authorities fail closed and remain byte-identical", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-swe-legacy-"));
  try {
    for (const topic of ["legacy-complete", "legacy-obsolete"]) {
      const path = initiativePath(root, topic);
      const before = `${JSON.stringify({ version: 2, topic, status: "paused", tasks: [] }, null, 2)}\n`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, before);

      const service = new SweService(root, new InitiativeStore(root));
      assert.throws(() => service.status(topic), /unsupported initiative schema/i);
      await assert.rejects(() => service.start(topic, "W-1"), /unsupported initiative schema/i);
      assert.equal(readFileSync(path, "utf8"), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable operator documentation states the authority, permission, artifact, UI, and proportionality boundaries", () => {
  const readme = readFileSync(new URL("../extensions/pi-swe/README.md", import.meta.url), "utf8");
  for (const pattern of [
    /sole planning authority/i,
    /ordinary `bash` tool/i,
    /test-after/i,
    /small initiatives/i,
    /create model-generated Markdown through pi-artifacts/i,
    /keyboard/i,
    /non-TUI/i,
    /session.*repository authority/i,
  ]) assert.match(readme, pattern);
  assert.doesNotMatch(readme, /retrospective TDD/i);
});
