import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import piSwe, { metadata } from "../extensions/pi-swe/index.ts";

const root = new URL("..", import.meta.url).pathname;

test("package discovery sees pi-swe extension", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.pi?.extensions, ["./extensions", "./node_modules/@gotgenes/pi-permission-system/src/index.ts"]);
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
      return [{ name: "permission-system", sourceInfo: { path: `${root}/node_modules/@gotgenes/pi-permission-system/src/index.ts` } }];
    },
  };
  const ctx = { cwd: root, sessionId: "test", hasUI: true, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };

  assert.equal(piSwe(pi as never, ctx as never), undefined);
  assert.deepEqual([...handlers.keys()], ["session_start", "session_tree", "session_info_changed", "session_shutdown", "turn_start", "agent_settled", "tool_call", "tool_result"]);
  assert.equal(commands.has("swe"), true);

  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start" }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "read", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_call")?.({ type: "tool_call", toolName: "edit", input: { path: "extensions/pi-swe/index.ts" } }, ctx);
  handlers.get("tool_result")?.({ type: "tool_result", toolName: "bash", input: { command: "node --test test/pi-swe.test.ts" }, details: { exitCode: 0 }, isError: false }, ctx);

  await commands.get("swe")?.handler("status", ctx);
  await commands.get("swe")?.handler("config", ctx);

  assert.ok(notifications.some((entry) => entry.message.includes("enabled: true")));
  assert.ok(notifications.some((entry) => entry.message.includes("detected peers: pi-permission-system, pi-todo")));
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

test("pi-swe rollout resources use one canonical skill surface", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionRoot = join(root, "extensions/pi-swe");

  assert.deepEqual(packageJson.pi?.extensions, ["./extensions", "./node_modules/@gotgenes/pi-permission-system/src/index.ts"]);
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));
  assert.equal(existsSync(join(extensionRoot, "index.ts")), true, "public entrypoint should stay top-level discoverable");
  assert.equal(existsSync(join(extensionRoot, "prompts")), false, "mirrored SWE prompts should stay removed");

  for (const resourceDir of ["docs", "skills", "references"] as const) {
    assert.equal(existsSync(join(extensionRoot, resourceDir)), true, `${resourceDir}/ should stay top-level`);
  }
  assert.equal(existsSync(join(extensionRoot, "pi-swe.schema.json")), true, "schema should stay top-level discoverable");

  for (const stage of lifecycleResourceStages) {
    assert.equal(existsSync(join(extensionRoot, `skills/swe-${stage}/SKILL.md`)), true, `missing skill for ${stage}`);
  }
  for (const reference of dsaReferenceFiles) {
    assert.equal(existsSync(join(extensionRoot, `references/dsa/${reference}.md`)), true, `missing DSA reference ${reference}`);
  }
  for (const reference of tddReferences) {
    assert.equal(existsSync(join(extensionRoot, `references/tdd-rgr/${reference}.md`)), true, `missing TDD reference ${reference}`);
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
  assert.ok(packageJson.pi?.skills?.includes("./extensions/**/skills"));

  const skillPath = join(root, "extensions/pi-swe/skills/swe-dsa/SKILL.md");
  assert.equal(existsSync(skillPath), true, "missing swe-dsa skill");

  const skill = readFileSync(skillPath, "utf8");
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
  assert.match(skill, /measure first|no change/i);

  for (const reference of dsaReferenceFiles) {
    const referencePath = join(root, `extensions/pi-swe/references/dsa/${reference}.md`);
    assert.equal(existsSync(referencePath), true, `missing DSA reference ${reference}`);
    assert.match(readFileSync(referencePath, "utf8"), /^# /);
  }

  const extensionEntrypoint = readFileSync(join(root, "extensions/pi-swe/index.ts"), "utf8");
  assert.doesNotMatch(`${skill}\n${extensionEntrypoint}`, /\/dsa-advisor\b|dsa_advisor|dsa-assessment|registerTool\([^)]*dsa/i);
});

test("swe-orchestrate skill composes existing lifecycle resources", () => {
  const skillPath = join(root, "extensions/pi-swe/skills/swe-orchestrate/SKILL.md");
  assert.equal(existsSync(skillPath), true, "missing swe-orchestrate skill");

  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /name: swe-orchestrate/);
  for (const required of ["inspect work order", "choose the next lifecycle stage", "swe-finalize", "verification evidence", "exception handoff"]) {
    assert.match(skill, new RegExp(required, "i"));
  }
  assert.doesNotMatch(skill, /from ["'].*pi-(todo|git|messenger)|registerTool|\/swe-auto|swe-auto/i);
});

test("swe-tdd skill and compact references are discoverable", () => {
  const skillPath = join(root, "extensions/pi-swe/skills/swe-tdd/SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const skillContent = readFileSync(skillPath, "utf8");
  assert.match(skillContent, /name: swe-tdd/);
  assert.match(skillContent, /description:/);
  assert.match(skillContent, /Next Observable Behavior/);
  assert.match(skillContent, /Test Level/);

  for (const reference of tddReferences) {
    assert.equal(existsSync(join(root, `extensions/pi-swe/references/tdd-rgr/${reference}.md`)), true, `missing TDD reference ${reference}`);
  }
});

test("swe-tdd guidance separates Red, Green, Refactor, and verification", () => {
  const combined = readFileSync(join(root, "extensions/pi-swe/skills/swe-tdd/SKILL.md"), "utf8");

  for (const required of ["Next Observable Behavior", "Test Level", "Red", "Green", "Refactor", "Verification"]) {
    assert.match(combined, new RegExp(`\\b${required}\\b`));
  }
  assert.match(combined, /one failing test|failing test first/i);
  assert.match(combined, /smallest production change/i);
  assert.match(combined, /only after green/i);
});

test("pi-swe TDD resources do not add legacy namespace or model-callable TDD tool", () => {
  const files = [
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

  for (const command of ["/skill:swe-plan", "/skill:swe-diagnose", "/skill:swe-implement", "/skill:swe-verify", "/skill:swe-review", "/skill:swe-finalize", "/skill:swe-tdd", "/skill:swe-dsa", "/swe orchestrate"]) {
    assert.match(readme, new RegExp(command.replace("/", "\\/")));
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
