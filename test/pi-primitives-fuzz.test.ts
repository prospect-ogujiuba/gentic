import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPrimitives } from "../extensions/pi-primitives/index.ts";
import { flattenTriggerText, loadPrimitiveTriggers } from "../extensions/pi-primitives/triggers.ts";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function randomValue(random: () => number, depth: number, ancestors: object[]): unknown {
  const choice = Math.floor(random() * (depth > 20 ? 5 : 10));
  if (choice === 0) return `text-${Math.floor(random() * 1_000_000)}`;
  if (choice === 1) return Math.floor(random() * 1_000_000);
  if (choice === 2) return random() > 0.5;
  if (choice === 3) return null;
  if (choice === 4) return undefined;
  if (choice === 5 && ancestors.length) return ancestors[Math.floor(random() * ancestors.length)];
  if (choice === 6) {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "hostile", { enumerable: true, get() { throw new Error("accessor must not run"); } });
    return value;
  }
  if (choice === 7) return new Proxy({ safe: "value" }, { ownKeys() { throw new Error("proxy trap"); } });
  const container: unknown[] | Record<string, unknown> = choice === 8 ? [] : {};
  const nextAncestors = [...ancestors, container];
  const count = Math.floor(random() * 5);
  for (let index = 0; index < count; index += 1) {
    const child = randomValue(random, depth + 1, nextAncestors);
    if (Array.isArray(container)) container.push(child);
    else container[`key${index}`] = child;
  }
  return container;
}

test("seeded recursive fuzzing preserves fail-closed traversal budgets", () => {
  const random = seeded(0x51f15e);
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const value = randomValue(random, 0, []);
    const output = flattenTriggerText(value);
    assert.ok(output.length <= 32768, `seeded iteration ${iteration} exceeded the character budget`);
  }

  for (let length = 32752; length <= 32784; length += 1) {
    assert.equal(flattenTriggerText("x".repeat(length)).length, length <= 32768 ? length : 0);
  }
  for (let depth = 0; depth <= 24; depth += 1) {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = [value];
    assert.equal(flattenTriggerText(value), depth <= 16 ? "leaf" : "");
  }
  for (let entries = 1016; entries <= 1032; entries += 1) {
    assert.equal(flattenTriggerText(Array(entries).fill("x")) === "", entries > 1023);
  }
});

test("seeded trigger and config fuzzing never escapes bounded diagnostics", async () => {
  const random = seeded(0xc0ffee);
  const root = mkdtempSync(join(tmpdir(), "gentic-primitives-fuzz-"));
  try {
    const configPath = join(root, "config.json");
    const triggerContext = { name: "fuzz", dir: root, path: (path: string) => join(root, path), readText: () => "{}" };
    const triggerCandidates: unknown[] = [
      null, [], 1, "x", {}, { phrases: [""] }, { pathPatterns: ["^"] }, { pathPatterns: ["["] },
      { phrases: Array(65).fill("x") }, { pathPatterns: ["x".repeat(513)] },
    ];
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const phraseCount = Math.floor(random() * 70);
      triggerCandidates.push({
        phrases: Array.from({ length: phraseCount }, () => random() < 0.05 ? "" : `phrase-${Math.floor(random() * 1000)}`),
        pathPatterns: random() < 0.5 ? ["(?:^|/)safe(?:/|$)"] : ["^"],
      });
    }
    for (const candidate of triggerCandidates) {
      try {
        const triggers = loadPrimitiveTriggers({ ...triggerContext, readText: () => JSON.stringify(candidate) });
        assert.ok(triggers.phrases.length <= 64);
        assert.ok(triggers.pathPatterns.length <= 64);
        assert.ok(triggers.pathPatterns.every((pattern) => !pattern.test("")));
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }

    const configCandidates = [
      "{", "null", "[]", "1", JSON.stringify({ enabled: false }), JSON.stringify({ enabled: "false" }),
      JSON.stringify({ disabled: [""] }), JSON.stringify({ disabled: ["same", "same"] }),
      JSON.stringify({ disabled: ["unknown"] }), `{}${" ".repeat(16383)}`,
    ];
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const count = Math.floor(random() * 20);
      configCandidates.push(JSON.stringify({ disabled: Array.from({ length: count }, () => `name-${Math.floor(random() * 20)}`) }));
    }
    for (const content of configCandidates) {
      writeFileSync(configPath, content);
      const report = await registerPrimitives({ on() {} } as never, { configPath });
      assert.ok(report.failures.every((failure) => failure.error.length <= 512 && !/[\r\n]/.test(failure.error)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("seeded thrown-value fuzzing preserves fixed policy startup recovery", async () => {
  const random = seeded(0xdecafbad);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const payload = `${"x".repeat(Math.floor(random() * 2000))}\nline-${iteration}`;
    let calls = 0;
    const report = await registerPrimitives({ on() {
      if (++calls === 1) throw iteration % 17 === 0 ? { toString() { throw new Error("nested"); } } : new Error(payload);
    } } as never);
    assert.deepEqual(report.loaded, ["implementation-file-completion", "model-artifacts", "whimsical"]);
    assert.ok((report.failures[0]?.error.length ?? Infinity) <= 512);
    assert.doesNotMatch(report.failures[0]?.error || "", /[\r\n]/);
  }
});
