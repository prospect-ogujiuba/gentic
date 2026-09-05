import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const skillPath = join(root, "skills/swe-complete/SKILL.md");

test("swe-complete skill is user-invoked and delegates concise guarded completion", () => {
  assert.equal(existsSync(skillPath), true);
  const skill = readFileSync(skillPath, "utf8");

  assert.match(skill, /^---\nname: swe-complete\n/m);
  assert.match(skill, /description: .+\n/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /\bswe_complete\b/);
  assert.match(skill, /confirm:\s*true/);
  assert.match(skill, /defaults? to `?advance`?/i);
  assert.match(skill, /Do not ask .*paths?, hashes?, revisions?, or evidence/i);
  assert.match(skill, /status.*completed.*already-complete.*rejected.*conflict.*blocked-recovery/is);
});
