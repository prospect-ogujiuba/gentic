import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  APPROVED_ARTIFACT_KINDS,
  discoverPackageResources,
  validatePackageResources,
} from "../src/package-resource-validation.ts";

const root = new URL("..", import.meta.url).pathname;

function write(path: string, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "gentic-resources-"));
}

test("Gentic package resources validate as one collision-free native surface", () => {
  const { inventory, issues } = validatePackageResources(root);
  assert.deepEqual(issues, []);
  assert.equal(inventory.themes.length, 12);
  assert.ok(inventory.prompts.includes("prompts/add-prompt.md"));
  assert.ok(inventory.skills.includes("skills/add-skill/SKILL.md"));
  assert.equal(inventory.prompts.some((path) => path.startsWith("extensions/pi-swe/")), false);
  assert.equal(inventory.extensions.some((path) => /pi-(prompts|skills)\//.test(path)), false);
  assert.deepEqual(APPROVED_ARTIFACT_KINDS, ["reports", "plans", "findings", "logs", "specs", "todo"]);
});

test("manifest discovery covers inclusions and exclusions", () => {
  const directory = fixture();
  try {
    write(join(directory, "prompts/included.md"));
    write(join(directory, "prompts/excluded.md"));
    write(join(directory, "skills/kept/SKILL.md"));
    write(join(directory, "skills/ignored/SKILL.md"));
    const inventory = discoverPackageResources(directory, {
      prompts: ["./prompts/**/*.md", "!./prompts/excluded.md"],
      skills: ["./skills", "!./skills/ignored/**"],
      extensions: [],
      themes: [],
    });
    assert.deepEqual(inventory.prompts, ["prompts/included.md"]);
    assert.deepEqual(inventory.skills, ["skills/kept/SKILL.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest discovery includes explicitly bundled node_modules extensions", () => {
  const directory = fixture();
  try {
    const extension = "node_modules/@example/permission-system/src/index.ts";
    write(join(directory, extension), "export default function extension() {}\n");
    const inventory = discoverPackageResources(directory, {
      extensions: [`./${extension}`],
      skills: [],
      prompts: [],
      themes: [],
    });
    assert.deepEqual(inventory.extensions, [extension]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resource validation rejects a skill name that differs from its parent directory", () => {
  const directory = fixture();
  try {
    write(join(directory, "package.json"), JSON.stringify({ pi: {
      extensions: [],
      skills: ["./skills"],
      prompts: [],
      themes: [],
    } }));
    write(join(directory, "skills/expected/SKILL.md"), "---\nname: different\ndescription: mismatch fixture\n---\nFixture\n");
    const { issues } = validatePackageResources(directory);
    assert.ok(issues.some((issue) => issue.message.includes("skill name different must match parent directory expected")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resource validation rejects invalid artifact kinds in root-owned skills and prompts", () => {
  const directory = fixture();
  try {
    write(join(directory, "package.json"), JSON.stringify({ pi: {
      extensions: [],
      skills: ["./skills"],
      prompts: ["./prompts/**/*.md"],
      themes: [],
    } }));
    write(join(directory, "skills/example/SKILL.md"), "---\nname: example\ndescription: artifact fixture\n---\nWrite .model-artifacts/diagnosis/example.md\n");
    write(join(directory, "prompts/example.md"), "---\ndescription: artifact fixture\n---\nWrite .model-artifacts/analysis/example.md\n");
    const { issues } = validatePackageResources(directory);
    assert.ok(issues.some((issue) => issue.path.endsWith("skills/example/SKILL.md") && issue.message === "unapproved model artifact kind: diagnosis"));
    assert.ok(issues.some((issue) => issue.path.endsWith("prompts/example.md") && issue.message === "unapproved model artifact kind: analysis"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resource validation rejects duplicate prompt names across owners", () => {
  const directory = fixture();
  try {
    write(join(directory, "package.json"), JSON.stringify({ pi: {
      extensions: [],
      skills: [],
      prompts: ["./prompts/**/*.md", "./extensions/**/prompts/**/*.md"],
      themes: [],
    } }));
    const prompt = "---\ndescription: duplicate fixture\n---\nFixture\n";
    write(join(directory, "prompts/review.md"), prompt);
    write(join(directory, "extensions/example/prompts/review.md"), prompt);
    const { issues } = validatePackageResources(directory);
    assert.ok(issues.some((issue) => issue.message.includes("duplicate invocation /review")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
