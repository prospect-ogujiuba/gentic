import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      const invalidReport = await registerPrimitives({} as never, { configPath, primitives: [] });
      assert.equal(invalidReport.failures[0]?.name, "config");
      assert.match(invalidReport.failures[0]?.error || "", expected);
    }
    writeFileSync(configPath, `{}${" ".repeat(16382)}`);
    assert.deepEqual((await registerPrimitives({} as never, { configPath, primitives: [] })).failures, []);
    writeFileSync(configPath, `{}${" ".repeat(16383)}`);
    assert.match((await registerPrimitives({} as never, { configPath, primitives: [] })).failures[0]?.error || "", /16384 bytes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type BeforeAgentStartEvent = {
  prompt?: string;
  systemPrompt: string;
  systemPromptOptions?: Record<string, unknown>;
};

type Handler = (event: BeforeAgentStartEvent) => { systemPrompt?: string } | undefined;

const layoutV2 = JSON.parse(readFileSync(new URL("./fixtures/model-artifacts-layout-v2.json", import.meta.url), "utf8"));

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

test("layout-v2 fixture declares namespaces, compatibility, safety, and source-of-truth cases", () => {
  assert.deepEqual(layoutV2.initiativeKinds, ["specs", "plans", "todo", "findings", "reports", "logs"]);
  assert.deepEqual(layoutV2.systemKinds, ["logs", "reports"]);
  assert.equal(layoutV2.valid.initiative.length, layoutV2.initiativeKinds.length);
  assert.ok(layoutV2.valid.system.every((path: string) => path.startsWith(".model-artifacts/system/")));
  assert.ok(layoutV2.valid.canonicalExceptions.some((path: string) => path.endsWith("/manifest.json")));
  assert.ok(layoutV2.valid.canonicalExceptions.some((path: string) => path.endsWith("/contracts.json")));
  assert.ok(layoutV2.legacyReadOnly.every((path: string) => !path.startsWith(".model-artifacts/initiatives/")));
  assert.equal(layoutV2.mixedAuthority.expected, "blocking-conflict");
  assert.deepEqual(new Set(layoutV2.invalid.map((entry: { reason: string }) => entry.reason)), new Set([
    "traversal", "absolute", "backslash", "non-kebab-topic", "wrong-initiative-kind", "wrong-system-kind", "invalid-generated-filename", "non-kebab-short-name",
  ]));
  assert.equal(layoutV2.symlink.expected, "reject-without-following");
  assert.equal(layoutV2.sourceOfTruth.generatedMirrorAllowed, false);
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

test("explicit primitive registration isolates failures and preserves startup diagnostics", async () => {
  const commands: string[] = [];
  const handlers: Array<(event: unknown, ctx: { ui: { setStatus(key: string, value: string): void; notify(message: string, level: string): void } }) => void> = [];
  const pi = {
    registerCommand(name: string) { commands.push(name); },
    on(name: string, callback: typeof handlers[number]) {
      if (name === "session_start") handlers.push(callback);
    },
  } as never;

  const report = await registerPrimitives(pi, {
    primitives: [
      { name: "broken", dir: "/broken", register() { throw new Error("broken registration"); } },
      { name: "healthy", dir: "/healthy", register(api: { registerCommand(name: string): void }) { api.registerCommand("healthy"); } },
    ],
  });

  assert.deepEqual(report.loaded, ["healthy"]);
  assert.deepEqual(report.failures, [{ name: "broken", error: "broken registration" }]);
  assert.deepEqual(commands, ["healthy"]);

  registerPrimitiveStatus(pi, report);
  const statuses: string[] = [];
  const warnings: string[] = [];
  handlers[0]?.({}, {
    ui: {
      setStatus(key, value) { statuses.push(`${key}: ${value}`); },
      notify(message, level) { warnings.push(`${level}: ${message}`); },
    },
  });
  assert.deepEqual(statuses, ["pi-primitives: 1 registered, 1 failed"]);
  assert.deepEqual(warnings, ["warning: Primitive registration failures:\n- broken: broken registration"]);
});

test("hostile thrown values produce bounded diagnostics without breaking registration isolation", async () => {
  const registered: string[] = [];
  const report = await registerPrimitives({} as never, { primitives: [
    { name: "unprintable", dir: "/unused", register() { throw { toString() { throw new Error("secondary failure"); } }; } },
    { name: "oversized", dir: "/unused", register() { throw new Error(`prefix-${"x".repeat(2000)}`); } },
    { name: "healthy", dir: "/unused", register() { registered.push("healthy"); } },
  ] });
  assert.deepEqual(registered, ["healthy"]);
  assert.deepEqual(report.loaded, ["healthy"]);
  assert.deepEqual(report.failures.map((failure) => failure.name), ["unprintable", "oversized"]);
  assert.equal(report.failures[0]?.error, "Unknown error");
  assert.ok((report.failures[1]?.error.length ?? Infinity) <= 512);
  assert.match(report.failures[1]?.error || "", /^prefix-/);
});

test("invalid primitive JSON, regex, and empty triggers do not prevent later registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-"));
  const fixtures = ["invalid-json", "invalid-regex", "empty-phrase", "empty-pattern", "empty-match-pattern"];
  try {
    for (const name of fixtures) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(root, "invalid-json/triggers.json"), "{");
    writeFileSync(join(root, "invalid-regex/triggers.json"), JSON.stringify({ pathPatterns: ["["] }));
    writeFileSync(join(root, "empty-phrase/triggers.json"), JSON.stringify({ phrases: [""] }));
    writeFileSync(join(root, "empty-pattern/triggers.json"), JSON.stringify({ pathPatterns: [""] }));
    writeFileSync(join(root, "empty-match-pattern/triggers.json"), JSON.stringify({ pathPatterns: ["^"] }));
    const commands: string[] = [];
    const report = await registerPrimitives({} as never, { primitives: [
      ...fixtures.map(name => ({ name, dir: join(root, name), register: (_pi: unknown, ctx: Parameters<typeof loadPrimitiveTriggers>[0]) => { loadPrimitiveTriggers(ctx); } })),
      { name: "rejected", dir: root, async register() { throw new Error("async failure"); } },
      { name: "z-valid", dir: root, register() { commands.push("later"); } },
    ] });
    assert.deepEqual(report.loaded, ["z-valid"]);
    assert.deepEqual(report.failures.map((failure) => failure.name), ["invalid-json", "invalid-regex", "empty-phrase", "empty-pattern", "empty-match-pattern", "rejected"]);
    assert.deepEqual(commands, ["later"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primitive resource reads reject traversal through symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-path-"));
  try {
    const dir = join(root, "primitive");
    mkdirSync(dir);
    writeFileSync(join(root, "outside.txt"), "secret");
    writeFileSync(join(dir, "..local.txt"), "local");
    symlinkSync(join(root, "outside.txt"), join(dir, "link.txt"));
    symlinkSync(join(root, "future-outside.txt"), join(dir, "dangling.txt"));
    const report = await registerPrimitives({} as never, { primitives: [
      { name: "dot-prefixed", dir, register(_pi, ctx) { assert.equal(ctx.readText("..local.txt"), "local"); } },
      { name: "contained", dir, register(_pi, ctx) { ctx.readText("link.txt"); } },
      { name: "dangling", dir, register(_pi, ctx) { ctx.path("dangling.txt"); } },
    ] });
    assert.deepEqual(report.loaded, ["dot-prefixed"]);
    assert.deepEqual(report.failures.map((failure) => failure.name), ["contained", "dangling"]);
    assert.ok(report.failures.every((failure) => /escapes primitive directory|cannot be resolved within primitive directory/.test(failure.error)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primitive config reports unknown disabled names without hiding valid registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-unknown-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ disabled: ["missing-primitive"] }));
    const report = await registerPrimitives({} as never, { configPath, primitives: [
      { name: "healthy", dir: root, register() {} },
    ] });
    assert.deepEqual(report.loaded, ["healthy"]);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(report.failures, [{ name: "config", error: "Unknown disabled primitives: missing-primitive" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primitive config can disable modules without hiding status data", async () => {
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-config-"));
  try {
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ disabled: ["disabled"] }));
    const report = await registerPrimitives({} as never, { configPath, primitives: [
      { name: "disabled", dir: root, register() { throw new Error("should not register"); } },
    ] });
    assert.deepEqual(report.skipped, ["disabled"]);
    assert.deepEqual(report.failures, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
