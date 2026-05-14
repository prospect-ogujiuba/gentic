import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import piSwe, { metadata } from "../extensions/pi-swe/index.ts";

const root = new URL("..", import.meta.url).pathname;

test("package discovery sees pi-swe extension", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.pi?.extensions, ["./extensions"]);
  assert.ok(readdirSync(join(root, "extensions"), { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name === "pi-swe"));
  assert.equal(existsSync(join(root, "extensions/pi-swe/index.ts")), true);
  assert.equal(existsSync(join(root, "extensions/pi-swe/src/pi/commands.ts")), true);
  assert.equal(existsSync(join(root, "extensions/pi-swe/src/pi/events.ts")), true);
  const entrypoint = readFileSync(join(root, "extensions/pi-swe/index.ts"), "utf8");
  assert.match(entrypoint, /\.\/src\/pi\/commands\.ts/);
  assert.match(entrypoint, /\.\/src\/pi\/events\.ts/);
  assert.equal(metadata.id, "pi-swe");
});

test("pi-swe registers runtime event wiring and /swe command", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const todoProvider = {
    getActiveTodo: () => ({ id: "todo-1", title: "Implement adapter", acceptanceCriteria: ["peer context"], definitionOfDone: ["tests pass"] }),
    getTodoScope: () => ({ files: ["extensions/pi-swe/index.ts"] }),
    getTodoEvidence: () => [{ type: "command", command: "npm test", exitCode: 0 }],
  };
  const pi = {
    capabilities: new Map([["pi-todo", todoProvider]]),
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    getCommands() {
      return [{ name: "todo" }];
    },
    getAllTools() {
      return [{ name: "gate", sourceInfo: { path: `${root}/extensions/pi-gate/index.ts` } }];
    },
  };
  const ctx = { cwd: root, sessionId: "test", hasUI: true, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  assert.equal(piSwe(pi as never, ctx as never), undefined);
  assert.deepEqual([...handlers.keys()], ["session_start", "turn_start", "tool_call", "tool_result"]);
  assert.equal(commands.has("swe"), true);

  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start" }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "read", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "edit", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_result")?.({ type: "tool_result", toolName: "bash", input: { command: "node --test test/pi-swe.test.ts" }, details: { exitCode: 0 }, isError: false }, ctx);

  await commands.get("swe")?.handler("status", ctx);
  await commands.get("swe")?.handler("config", ctx);

  assert.ok(notifications.some((entry) => entry.message.includes("enabled: true")));
  assert.ok(notifications.some((entry) => entry.message.includes("detected peers: pi-gate, pi-todo")));
  assert.ok(notifications.some((entry) => entry.message.includes("active plan: todo:todo-1 Implement adapter (AC:1, DoD:1)")));
  assert.ok(notifications.some((entry) => entry.message.includes("todo scope: files:extensions/pi-swe/index.ts")));
  assert.ok(notifications.some((entry) => entry.message.includes("inspected paths: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("changed paths: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("verification count: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("todo evidence count: 1")));
  assert.ok(notifications.some((entry) => entry.message.includes("pi-swe config")));
});

test("/swe orchestrate is guidance-only and preserves existing command behavior", async () => {
  const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    capabilities: new Map(),
    on() {},
    registerCommand(name: string, command: { handler: Function; getArgumentCompletions?: Function }) {
      commands.set(name, command);
    },
    getCommands() {
      return [];
    },
    getAllTools() {
      return [];
    },
  };
  const ctx = { cwd: root, sessionId: "test", hasUI: true, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  piSwe(pi as never, ctx as never);
  const swe = commands.get("swe");
  assert.ok(swe);
  assert.deepEqual(swe.getArgumentCompletions?.(""), [
    { value: "status", label: "status" },
    { value: "config", label: "config" },
    { value: "orchestrate", label: "orchestrate" },
  ]);

  await swe.handler("orchestrate", ctx);
  await swe.handler("status", ctx);
  await swe.handler("config", ctx);

  assert.ok(notifications.some((entry) => entry.message.includes("Usage: /swe orchestrate [status|start|resume|handoff]")));
  assert.ok(notifications.some((entry) => entry.message.includes("guidance-only")));
  assert.ok(notifications.some((entry) => entry.message.includes("pi-swe status")));
  assert.ok(notifications.some((entry) => entry.message.includes("pi-swe config")));
});

test("/swe orchestrate subcommands provide deterministic guidance-only handoffs", async () => {
  const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    capabilities: new Map(),
    on() {},
    registerCommand(name: string, command: { handler: Function; getArgumentCompletions?: Function }) {
      commands.set(name, command);
    },
    getCommands() {
      return [];
    },
    getAllTools() {
      return [];
    },
  };
  const ctx = { cwd: root, sessionId: "test", hasUI: true, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  piSwe(pi as never, ctx as never);
  const swe = commands.get("swe");
  assert.ok(swe);

  await swe.handler("orchestrate status", ctx);
  await swe.handler("orchestrate start", ctx);
  await swe.handler("orchestrate resume", ctx);
  await swe.handler("orchestrate handoff", ctx);

  assert.ok(notifications.some((entry) => entry.message.includes("artifact readiness")));
  assert.ok(notifications.some((entry) => entry.message.includes("next recommended lifecycle step")));
  assert.ok(notifications.some((entry) => entry.message.includes("resume from model artifacts")));
  assert.ok(notifications.some((entry) => entry.message.includes("exception handoff")));
  assert.ok(notifications.every((entry) => entry.type === "info"));
});

const baseStages = ["plan", "diagnose", "implement", "verify", "review", "finalize"] as const;
const lifecycleResourceStages = [...baseStages, "tdd", "dsa", "orchestrate"] as const;
const dsaReferenceFiles = ["decision-rubric", "algorithm-playbook", "data-structures-catalog"] as const;
const tddReferences = ["rgr-playbook", "tdd-architecture", "red-green-refactor"] as const;

test("pi-swe rollout resources remain discoverable by package and anatomy tooling", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionRoot = join(root, "extensions/pi-swe");
  const anatomy = JSON.parse(readFileSync(join(extensionRoot, "extension.anatomy.json"), "utf8"));

  assert.deepEqual(packageJson.pi?.extensions, ["./extensions"]);
  assert.ok(packageJson.pi?.prompts?.includes("./extensions/**/prompts/**/*.md"));
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));
  assert.equal(anatomy.publicEntry, "index.ts");
  assert.ok(anatomy.tests.includes("npm run test:swe"));

  for (const resourceDir of ["docs", "prompts", "skills", "references"] as const) {
    assert.equal(existsSync(join(extensionRoot, resourceDir)), true, `${resourceDir}/ should stay top-level`);
    assert.ok(anatomy.resources.includes(resourceDir), `${resourceDir}/ should be declared as a pi-swe resource`);
  }
  assert.equal(existsSync(join(extensionRoot, "pi-swe.schema.json")), true, "schema should stay top-level discoverable");
  assert.ok(anatomy.resources.includes("schemas"));

  for (const stage of lifecycleResourceStages) {
    assert.equal(existsSync(join(extensionRoot, `prompts/swe-${stage}.md`)), true, `missing prompt for ${stage}`);
    assert.equal(existsSync(join(extensionRoot, `skills/swe-${stage}/SKILL.md`)), true, `missing skill for ${stage}`);
  }
  for (const reference of dsaReferenceFiles) {
    assert.equal(existsSync(join(extensionRoot, `references/dsa/${reference}.md`)), true, `missing DSA reference ${reference}`);
  }
  for (const reference of tddReferences) {
    assert.equal(existsSync(join(extensionRoot, `references/tdd-rgr/${reference}.md`)), true, `missing TDD reference ${reference}`);
  }
});

test("all base pi-swe prompt templates are discoverable", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.pi?.prompts?.includes("./extensions/**/prompts/**/*.md"));

  for (const stage of baseStages) {
    const promptPath = join(root, `extensions/pi-swe/prompts/swe-${stage}.md`);
    assert.equal(existsSync(promptPath), true, `missing prompt for ${stage}`);
    const content = readFileSync(promptPath, "utf8");
    assert.match(content, /^---\n[\s\S]*description:/);
    assert.doesNotMatch(content, /\/sop\b|programming_sop|sop-/);
  }
});

test("all base pi-swe skills are discoverable", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));

  for (const stage of baseStages) {
    const skillPath = join(root, `extensions/pi-swe/skills/swe-${stage}/SKILL.md`);
    assert.equal(existsSync(skillPath), true, `missing skill for ${stage}`);
    const content = readFileSync(skillPath, "utf8");
    assert.match(content, new RegExp(`name: swe-${stage}`));
    assert.match(content, /description:/);
    assert.doesNotMatch(content, /\/sop\b|programming_sop|sop-/);
  }
});

test("swe-dsa resources are discoverable and resource-only", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(packageJson.pi?.prompts?.includes("./extensions/**/prompts/**/*.md"));
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));

  const promptPath = join(root, "extensions/pi-swe/prompts/swe-dsa.md");
  const skillPath = join(root, "extensions/pi-swe/skills/swe-dsa/SKILL.md");
  assert.equal(existsSync(promptPath), true, "missing /swe-dsa prompt");
  assert.equal(existsSync(skillPath), true, "missing swe-dsa skill");

  const prompt = readFileSync(promptPath, "utf8");
  const skill = readFileSync(skillPath, "utf8");
  assert.match(prompt, /^---\n[\s\S]*description:/);
  assert.match(skill, /name: swe-dsa/);
  assert.match(skill, /problem summary/i);
  assert.match(skill, /current implementation/i);
  assert.match(skill, /workload \/ constraints/i);
  assert.match(skill, /recommendation/i);
  assert.match(skill, /rejected alternatives/i);
  assert.match(skill, /complexity impact/i);
  assert.match(skill, /memory tradeoff/i);
  assert.match(skill, /migration advice/i);
  assert.match(skill, /validation plan/i);
  assert.match(skill, /confidence/i);
  assert.match(skill, /semantic requirements/i);
  assert.match(`${prompt}\n${skill}`, /measure first|no change/i);

  for (const reference of dsaReferenceFiles) {
    const referencePath = join(root, `extensions/pi-swe/references/dsa/${reference}.md`);
    assert.equal(existsSync(referencePath), true, `missing DSA reference ${reference}`);
    assert.match(readFileSync(referencePath, "utf8"), /^# /);
  }

  const extensionEntrypoint = readFileSync(join(root, "extensions/pi-swe/index.ts"), "utf8");
  assert.doesNotMatch(`${prompt}\n${skill}\n${extensionEntrypoint}`, /\/dsa-advisor\b|dsa_advisor|dsa-assessment|registerTool\([^)]*dsa/i);
});

test("swe-orchestrate prompt and skill compose existing lifecycle resources", () => {
  const promptPath = join(root, "extensions/pi-swe/prompts/swe-orchestrate.md");
  const skillPath = join(root, "extensions/pi-swe/skills/swe-orchestrate/SKILL.md");
  assert.equal(existsSync(promptPath), true, "missing swe-orchestrate prompt");
  assert.equal(existsSync(skillPath), true, "missing swe-orchestrate skill");

  const prompt = readFileSync(promptPath, "utf8");
  const skill = readFileSync(skillPath, "utf8");
  assert.match(prompt, /^---\n[\s\S]*description:/);
  assert.match(skill, /name: swe-orchestrate/);
  for (const required of ["inspect work order", "choose the next lifecycle stage", "swe-finalize", "verification evidence", "exception handoff"]) {
    assert.match(`${prompt}\n${skill}`, new RegExp(required, "i"));
  }
  assert.doesNotMatch(`${prompt}\n${skill}`, /from ["'].*pi-(todo|git|messenger)|registerTool|\/swe-auto|swe-auto/i);
});

test("swe-tdd prompt, skill, and compact references are discoverable", () => {
  const promptPath = join(root, "extensions/pi-swe/prompts/swe-tdd.md");
  assert.equal(existsSync(promptPath), true);
  const promptContent = readFileSync(promptPath, "utf8");
  assert.match(promptContent, /^---\n[\s\S]*description:/);
  assert.match(promptContent, /Next Observable Behavior/);
  assert.match(promptContent, /Test Level/);

  const skillPath = join(root, "extensions/pi-swe/skills/swe-tdd/SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const skillContent = readFileSync(skillPath, "utf8");
  assert.match(skillContent, /name: swe-tdd/);
  assert.match(skillContent, /description:/);

  for (const reference of tddReferences) {
    assert.equal(existsSync(join(root, `extensions/pi-swe/references/tdd-rgr/${reference}.md`)), true, `missing TDD reference ${reference}`);
  }
});

test("swe-tdd guidance separates Red, Green, Refactor, and verification", () => {
  const promptContent = readFileSync(join(root, "extensions/pi-swe/prompts/swe-tdd.md"), "utf8");
  const skillContent = readFileSync(join(root, "extensions/pi-swe/skills/swe-tdd/SKILL.md"), "utf8");
  const combined = `${promptContent}\n${skillContent}`;

  for (const required of ["Next Observable Behavior", "Test Level", "Red", "Green", "Refactor", "Verification"]) {
    assert.match(combined, new RegExp(`\\b${required}\\b`));
  }
  assert.match(combined, /one failing test|failing test first/i);
  assert.match(combined, /smallest production change/i);
  assert.match(combined, /only after green/i);
});

test("pi-swe TDD resources do not add legacy namespace or model-callable TDD tool", () => {
  const files = [
    "extensions/pi-swe/prompts/swe-tdd.md",
    "extensions/pi-swe/skills/swe-tdd/SKILL.md",
    "extensions/pi-swe/index.ts",
  ];
  const content = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

  assert.equal(existsSync(join(root, "extensions/pi-swe/prompts/tdd-rgr.md")), false);
  assert.equal(existsSync(join(root, "extensions/pi-swe/skills/tdd-rgr/SKILL.md")), false);
  assert.doesNotMatch(content, /(^|[\s`])\/tdd-rgr\b/m);
  assert.doesNotMatch(content, /registerTool\([^)]*(?:tdd|swe-tdd)/i);
});

test("pi-swe end-to-end docs cover scenarios, migration, and omitted legacy surfaces", () => {
  const readme = readFileSync(join(root, "extensions/pi-swe/README.md"), "utf8");
  const scenariosPath = join(root, "extensions/pi-swe/docs/e2e-scenarios.md");
  assert.equal(existsSync(scenariosPath), true);
  const scenarios = readFileSync(scenariosPath, "utf8");
  const docs = `${readme}\n${scenarios}`;

  for (const prompt of ["/swe-plan", "/swe-diagnose", "/swe-implement", "/swe-verify", "/swe-review", "/swe-finalize", "/swe-tdd", "/swe-dsa", "/swe orchestrate"]) {
    assert.match(readme, new RegExp(prompt.replace("/", "\\/")));
  }

  for (const required of [
    "plan → implement → verify → finalize",
    "diagnose bug → TDD fix → verify → review",
    "DSA assessment → implementation → validation",
    "no `pi-todo` installed",
    "`pi-todo` installed with active task/evidence",
    "standalone",
    "optional peer",
    "Programming SOP",
    "TDD RGR",
    "DSA Advisor",
    "Intentionally omitted legacy surfaces",
    "Complete-version checklist",
    "Feature orchestration path",
    "Bug orchestration path",
    "DSA orchestration path",
    "Exception orchestration path",
    "Resume orchestration path",
    "Finalize gate orchestration path",
  ]) {
    assert.match(docs, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  assert.match(readme, /\/sop|\/programming-sop|programming_sop/);
  assert.match(readme, /\/tdd-rgr|tdd_rgr/);
  assert.match(readme, /\/dsa-advisor|dsa_advisor/);
});
