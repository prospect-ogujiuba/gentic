import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import piPrimitives, { registerPrimitiveStatus, registerPrimitives } from "../extensions/pi-primitives/index.ts";

import { flattenTriggerText, loadPrimitiveTriggers, matchesPrimitivePrompt, matchesPrimitiveTrigger } from "../extensions/pi-primitives/triggers.ts";
import { loadPromptPolicy } from "../extensions/pi-primitives/prompt-policy.ts";

test("native working indicator is untouched with whimsical enabled or disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-native-working-"));
  try {
    const configPath = join(root, "config.json");
    for (const disabled of [[], ["whimsical"]]) {
      writeFileSync(configPath, JSON.stringify({ disabled }));
      const events: string[] = [];
      const report = await registerPrimitives({
        on(name: string) { events.push(name); },
      } as never, { configPath });
      assert.deepEqual(report.failures, []);
      assert.deepEqual(report.skipped, disabled);
      assert.equal(report.loaded.includes("whimsical"), disabled.length === 0);
      assert.deepEqual(events, ["before_agent_start", "before_agent_start", "before_agent_start"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primitive entry and documented anatomy match explicit runtime registration", () => {
  const source = readFileSync(new URL("../extensions/pi-primitives/index.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../extensions/pi-primitives/README.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readdir|\bimport\s*\(|\?gentic=|Date\.now|loadPrimitives/);
  assert.match(readme, /\*\*Mode:\*\* `runtime`/);
  assert.match(readme, /\*\*Layers:\*\* none/);
});

test("startup config failures remain visible and global disable avoids registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-startup-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{");
    const report = await registerPrimitives({ on() {} } as never, { configPath });
    assert.deepEqual(report.loaded, ["concise-output", "implementation-file-completion", "model-artifacts", "whimsical"]);
    assert.equal(report.failures[0]?.name, "config");
    assert.ok(report.failures[0]?.error);
    writeFileSync(configPath, JSON.stringify({ enabled: false }));
    assert.deepEqual(await registerPrimitives({ on() { throw new Error("must not register"); } } as never, { configPath }), {
      loaded: [],
      skipped: ["concise-output", "implementation-file-completion", "model-artifacts", "whimsical"],
      failures: [],
    });

    const invalidConfigs: Array<[unknown, RegExp]> = [
      [[], /JSON object/],
      [1, /JSON object/],
      ["enabled", /JSON object/],
      [{ enabled: "false" }, /enabled must be a boolean/],
      [{ disabled: [""] }, /kebab-case/],
      [{ disabled: ["same", "same"] }, /duplicate primitive names/],
    ];
    for (const [invalid, expected] of invalidConfigs) {
      writeFileSync(configPath, JSON.stringify(invalid));
      const invalidReport = await registerPrimitives({ on() {} } as never, { configPath });
      assert.equal(invalidReport.failures[0]?.name, "config");
      assert.match(invalidReport.failures[0]?.error || "", expected);
    }
    writeFileSync(configPath, `{}${" ".repeat(16382)}`);
    assert.deepEqual((await registerPrimitives({ on() {} } as never, { configPath })).failures, []);
    writeFileSync(configPath, `{}${" ".repeat(16383)}`);
    assert.match((await registerPrimitives({ on() {} } as never, { configPath })).failures[0]?.error || "", /16384 bytes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type BeforeAgentStartEvent = {
  prompt?: string;
  systemPrompt: string;
  systemPromptOptions?: Record<string, unknown>;
};

type Handler = (event: BeforeAgentStartEvent) => { systemPrompt?: string } | undefined;

const artifactLayout = JSON.parse(readFileSync(new URL("./fixtures/model-artifacts-layout.json", import.meta.url), "utf8"));

async function beforeAgentStartPipeline(): Promise<Handler> {
  const handlers: Handler[] = [];
  await piPrimitives({
    on(name: string, callback: Handler) {
      if (name === "before_agent_start") handlers.push(callback);
    },
  } as never);

  assert.ok(handlers.length > 0);
  return (event) => {
    let current = { ...event };
    let changed = false;
    for (const handler of handlers) {
      const result = handler(current);
      if (result?.systemPrompt) {
        current = { ...current, systemPrompt: result.systemPrompt };
        changed = true;
      }
    }
    return changed ? { systemPrompt: current.systemPrompt } : undefined;
  };
}

test("implementation-file-completion primitive matches expanded user prompt", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Implement this SWE slice: docs/phase-1.md",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /\[COMPLETE\]/);
  assert.match(result?.systemPrompt || "", /Canonical lifecycle contracts.*stable filenames/s);
  assert.match(result?.systemPrompt || "", /contracts\.json/);
  assert.match(result?.systemPrompt || "", /never add, remove, or normalize a `\[COMPLETE\]` filename marker/);
});

test("implementation-file-completion primitive skips unrelated prompts", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Output and Responses Efficiency Policy/);
  assert.doesNotMatch(result?.systemPrompt || "", /\[COMPLETE\]/);
});

test("concise-output primitive injects reusable output policy", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Output and Responses Efficiency Policy/);
  assert.match(result?.systemPrompt || "", /Minimize visible output\./);
});

test("concise-output primitive skips only an exact duplicate policy heading", async () => {
  const handler = await beforeAgentStartPipeline();
  const exactDuplicate = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE\n\n# Output and Responses Efficiency Policy\n\nExisting copy.",
    systemPromptOptions: {},
  });
  assert.equal(exactDuplicate, undefined);

  const proseMention = handler({
    prompt: "Explain TypeScript generics",
    systemPrompt: "BASE\n\nRefer to # Output and Responses Efficiency Policy when responding.",
    systemPromptOptions: {},
  });
  assert.match(proseMention?.systemPrompt || "", /^# Output and Responses Efficiency Policy$/m);
});

test("model-artifacts primitive injects reusable artifact convention", async () => {
  const handler = await beforeAgentStartPipeline();

  const result = handler({
    prompt: "Write a generated artifact for the review evidence",
    systemPrompt: "BASE",
    systemPromptOptions: {},
  });

  assert.match(result?.systemPrompt || "", /Model artifacts convention/);
  assert.match(result?.systemPrompt || "", /\.model-artifacts\/initiatives\/<topic>\/<kind>/);
  assert.match(result?.systemPrompt || "", /\.model-artifacts\/system\/(?:logs|reports)/);
  assert.match(result?.systemPrompt || "", /docs\/plans\/.*curated/s);
});

test("model-artifacts fixture declares canonical namespaces, safety, and source-of-truth cases", () => {
  assert.deepEqual(artifactLayout.initiativeKinds, ["specs", "plans", "todo", "findings", "reports", "logs"]);
  assert.deepEqual(artifactLayout.systemKinds, ["logs", "reports"]);
  assert.equal(artifactLayout.valid.initiative.length, artifactLayout.initiativeKinds.length);
  assert.ok(artifactLayout.valid.system.every((path: string) => path.startsWith(".model-artifacts/system/")));
  assert.deepEqual(artifactLayout.valid.authority, [".model-artifacts/initiatives/demo/workflow.json"]);
  assert.deepEqual(new Set(artifactLayout.invalid.map((entry: { reason: string }) => entry.reason)), new Set([
    "wrong-scope", "traversal", "absolute", "backslash", "non-kebab-topic", "wrong-initiative-kind", "wrong-system-kind", "invalid-generated-filename", "non-kebab-short-name",
  ]));
  assert.equal(artifactLayout.sourceOfTruth.generatedMirrorAllowed, false);
});

test("primitive triggers flatten structured context files", async () => {
  const handler = await beforeAgentStartPipeline();
  const result = handler({
    prompt: "Continue",
    systemPrompt: "BASE",
    systemPromptOptions: { contextFiles: [{ path: ".model-artifacts/initiatives/demo/plans/2026-05-01_1200-demo.md", content: "phase" }] },
  });
  assert.match(result?.systemPrompt || "", /Model artifacts convention/);
});

test("trigger scanning fails closed for oversized, deep, cyclic, and accessor inputs", () => {
  assert.equal(flattenTriggerText(Array(10000).fill("x".repeat(1000))), "");
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.equal(flattenTriggerText(cycle), "");
  let atDepthLimit: unknown = "write a report";
  for (let i = 0; i < 16; i++) atDepthLimit = [atDepthLimit];
  assert.equal(flattenTriggerText(atDepthLimit), "write a report");
  assert.equal(flattenTriggerText([atDepthLimit]), "");
  assert.equal(flattenTriggerText({ get content() { throw new Error("must not execute"); } }), "");
  assert.equal(flattenTriggerText({ content: ["hello", 1, true] }), "hello\n1\ntrue");
  const shared = { content: "shared" };
  assert.equal(flattenTriggerText({ first: shared, second: shared }), "shared\nshared");
  const inherited = Object.create({ get content() { throw new Error("must not execute"); } }) as Record<string, unknown>;
  inherited.safe = "value";
  assert.equal(flattenTriggerText(inherited), "value");
  const oversizedPrototype = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`key${index}`, index]));
  assert.equal(flattenTriggerText(Object.assign(Object.create(oversizedPrototype), { safe: "value" })), "");
});

test("prompt policy and trigger budgets have exact boundaries", () => {
  const context = { name: "test", dir: ".", path: (path: string) => path, readText: () => "x".repeat(8192) };
  assert.equal(loadPromptPolicy(context)("BASE")?.systemPrompt.length, 8198);
  assert.throws(() => loadPromptPolicy({ ...context, readText: () => "x".repeat(8193) }), /exceeds 8192/);
  assert.equal(loadPromptPolicy({ ...context, readText: () => "  " })("BASE"), undefined);
  const crlfPolicy = loadPromptPolicy({ ...context, readText: () => "# Policy\r\n\r\nBody" });
  const applied = crlfPolicy("BASE")!.systemPrompt;
  assert.equal(crlfPolicy(applied), undefined);
  assert.equal(flattenTriggerText("x".repeat(32768)).length, 32768);
  assert.equal(flattenTriggerText("x".repeat(32769)), "");
  assert.notEqual(flattenTriggerText(Array(1023).fill("x")), "");
  assert.equal(flattenTriggerText(Array(1024).fill("x")), "");

  const triggerContext = (data: unknown) => ({ ...context, readText: () => JSON.stringify(data) });
  assert.equal(loadPrimitiveTriggers(triggerContext({ phrases: Array(64).fill("x"), pathPatterns: ["x".repeat(512)] })).phrases.length, 64);
  assert.throws(() => loadPrimitiveTriggers(triggerContext({ phrases: Array(65).fill("x") })), /at most 64/);
  assert.throws(() => loadPrimitiveTriggers(triggerContext({ pathPatterns: ["x".repeat(513)] })), /at most 512/);
  assert.throws(() => loadPrimitiveTriggers(triggerContext({ pathPatterns: ["^"] })), /must not match empty input/);

  const pathOnly = { phrases: [], pathPatterns: [/plan\.md/i] };
  assert.equal(matchesPrimitiveTrigger(`${"x".repeat(505)}plan.md`, pathOnly), true);
  assert.equal(matchesPrimitiveTrigger(`${"x".repeat(506)}plan.md`, pathOnly), false);
  assert.equal(matchesPrimitiveTrigger(`${Array(1023).fill("x").join(" ")} plan.md`, pathOnly), true);
  assert.equal(matchesPrimitiveTrigger(`plan.md ${Array(1024).fill("x").join(" ")}`, pathOnly), false);
  const stateful = { phrases: [], pathPatterns: [/plan\.md/gi] };
  assert.equal(matchesPrimitiveTrigger("plan.md", stateful), true);
  assert.equal(matchesPrimitiveTrigger("plan.md", stateful), true);
  assert.equal(stateful.pathPatterns[0]!.lastIndex, 0);
});

test("bundled path triggers reject adversarial segmented input within a CPU budget", () => {
  const triggerText = readFileSync(new URL("../extensions/pi-primitives/primitives/implementation-file-completion/triggers.json", import.meta.url), "utf8");
  const triggers = loadPrimitiveTriggers({ name: "performance", dir: ".", path: (path: string) => path, readText: () => triggerText });
  const adversarial = "x/".repeat(8192);
  const before = process.cpuUsage();
  for (let iteration = 0; iteration < 5; iteration += 1) assert.equal(matchesPrimitiveTrigger(adversarial, triggers), false);
  const usage = process.cpuUsage(before);
  const cpuMs = (usage.user + usage.system) / 1000;
  assert.ok(cpuMs < 250, `path trigger consumed ${cpuMs.toFixed(1)}ms CPU`);
});

test("independent trigger fields cannot suppress each other", async () => {
  const handler = await beforeAgentStartPipeline();
  const oversizedContext = handler({
    prompt: "write a report",
    systemPrompt: "BASE",
    systemPromptOptions: { contextFiles: "x".repeat(32769) },
  });
  assert.match(oversizedContext?.systemPrompt || "", /# Model artifacts convention/);

  const options: Record<string, unknown> = { appendSystemPrompt: "write a report" };
  Object.defineProperty(options, "customPrompt", { enumerable: true, get() { throw new Error("unreadable field"); } });
  assert.equal(matchesPrimitivePrompt({ prompt: "continue", systemPromptOptions: options }, {
    phrases: ["write a report"], pathPatterns: [],
  }), true);
});

test("conditional triggers accept prompt options but not existing system text", async () => {
  const handler = await beforeAgentStartPipeline();
  for (const field of ["customPrompt", "appendSystemPrompt", "contextFiles"]) {
    const result = handler({ prompt: "Continue", systemPrompt: "BASE", systemPromptOptions: { [field]: "WRITE A REPORT" } });
    assert.match(result!.systemPrompt!, /# Model artifacts convention/);
  }
  const unrelated = handler({ prompt: "Hello", systemPrompt: "write a report" });
  assert.doesNotMatch(unrelated!.systemPrompt!, /# Model artifacts convention/);
});

test("conditional policies are idempotent and never copy triggering content", async () => {
  const handler = await beforeAgentStartPipeline();
  const prompt = "write a report for the assigned file SECRET_SENTINEL";
  const first = handler({ prompt, systemPrompt: "BASE" })!;
  assert.match(first.systemPrompt!, /Implementation file completion convention/);
  assert.match(first.systemPrompt!, /Model artifacts convention/);
  assert.doesNotMatch(first.systemPrompt!, /SECRET_SENTINEL/);
  assert.equal(handler({ prompt, systemPrompt: first.systemPrompt! }), undefined);
  assert.ok(first.systemPrompt!.length - 4 <= 3 * (8192 + 2));
});

test("fixed policy failures remain isolated with bounded diagnostics", async () => {
  let calls = 0;
  const report = await registerPrimitives({ on() {
    if (++calls === 1) throw { toString() { throw new Error("secondary"); } };
    if (calls === 2) throw new Error(`prefix-${"x".repeat(2000)}`);
  } } as never);
  assert.equal(calls, 3);
  assert.deepEqual(report.loaded, ["model-artifacts", "whimsical"]);
  assert.deepEqual(report.failures.map((failure) => failure.name), ["concise-output", "implementation-file-completion"]);
  assert.equal(report.failures[0]?.error, "Unknown error");
  assert.equal(report.failures[1]?.error.length, 512);
  assert.match(report.failures[1]?.error || "", /^prefix-/);

  let start: Function | undefined;
  registerPrimitiveStatus({ on(_name: string, handler: Function) { start = handler; } } as never, report);
  const warnings: string[] = [];
  const statuses: string[] = [];
  start!({}, { ui: {
    setStatus(key: string, value: string) { statuses.push(`${key}: ${value}`); },
    notify(message: string) { warnings.push(message); },
  } });
  assert.deepEqual(statuses, ["pi-primitives: 2 registered, 2 failed"]);
  assert.match(warnings[0]!, /concise-output: Unknown error/);
  assert.match(warnings[1]!, /whimsical is deprecated/);
});

test("legacy scaffold trigger validation remains available without a registry", () => {
  for (const text of ["{", "null", "[]", '{"pathPatterns":["["]}', '{"phrases":[""]}', '{"pathPatterns":["^"]}']) {
    assert.throws(() => loadPrimitiveTriggers({ name: "legacy", dir: ".", path: (p) => p, readText: () => text }));
  }
});

test("fixed bundle rejects unknown config names and fields while retaining valid disablement", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-policy-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ disabled: ["missing-primitive", "concise-output"], plugins: [] }));
    const report = await registerPrimitives({ on() {} } as never, { configPath });
    assert.deepEqual(report.loaded, ["implementation-file-completion", "model-artifacts", "whimsical"]);
    assert.deepEqual(report.skipped, ["concise-output"]);
    assert.match(report.failures[0]!.error, /Unknown config fields: plugins/);
    assert.equal(report.failures[1]!.error, "Unknown disabled primitives: missing-primitive");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bundle exposes no plugin definitions, context factory, registry, or runtime trigger loader", async () => {
  const source = readFileSync(new URL("../extensions/pi-primitives/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /PolicyDefinition|PrimitiveDefinition|EXPLICIT_|primitiveContext|primitivePath|options\.(?:primitives|policies)|for \(const (?:policy|primitive)/);
  for (const name of ["concise-output", "implementation-file-completion", "model-artifacts"]) {
    const policy = readFileSync(new URL(`../extensions/pi-primitives/primitives/${name}/index.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(policy, /PrimitiveContext|loadPrimitiveTriggers|loadPromptPolicy|triggers\.json/);
    assert.match(policy, /new URL\("\.\/injection\.md", import\.meta\.url\)/);
  }
  let customRan = false;
  await registerPrimitives({ on() {} } as never, { primitives: [{ register() { customRan = true; } }] } as never);
  assert.equal(customRan, false);
});

test("fixed predicates retain every legacy phrase/path and injection order", async () => {
  const pipeline = await beforeAgentStartPipeline();
  for (const [name, heading, paths] of [
    ["implementation-file-completion", "# Implementation file completion convention", ["docs/phase-1.md", "todo.md", "implementation.md"]],
    ["model-artifacts", "# Model artifacts convention", ["reports/check.md", ".model-artifacts/demo", "logs/check.md"]],
  ] as const) {
    const fixture = JSON.parse(readFileSync(new URL(`../extensions/pi-primitives/primitives/${name}/triggers.json`, import.meta.url), "utf8"));
    for (const prompt of [...fixture.phrases, ...paths]) {
      const result = pipeline({ prompt: prompt.toUpperCase(), systemPrompt: "BASE" });
      assert.ok(result?.systemPrompt?.includes(heading), prompt);
    }
  }
  const result = pipeline({ prompt: "assigned file; write a report", systemPrompt: "BASE" })!.systemPrompt!;
  assert.ok(result.indexOf("# Output and Responses") < result.indexOf("# Implementation file"));
  assert.ok(result.indexOf("# Implementation file") < result.indexOf("# Model artifacts"));
  for (const prompt of [`${"x/".repeat(8192)}`, `${"x".repeat(506)}plan.md`]) {
    assert.doesNotMatch(pipeline({ prompt, systemPrompt: "BASE" })!.systemPrompt!, /# Implementation file/);
  }
});
