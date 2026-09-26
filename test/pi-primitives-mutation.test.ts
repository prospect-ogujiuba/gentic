import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

type Mutant = { name: string; file: string; from: string; to: string };

const mutants: Mutant[] = [
  { name: "depth boundary", file: "prompt-input.ts", from: "if (++nodes > 1024 || depth > 16)", to: "if (++nodes > 1024 || depth > 17)" },
  { name: "character boundary", file: "prompt-input.ts", from: "if (characters > 32768)", to: "if (characters > 32769)" },
  { name: "property boundary", file: "prompt-input.ts", from: "if (++properties > 1024)", to: "if (++properties > 1025)" },
  { name: "trigger count boundary", file: "triggers.ts", from: "const MAX_TRIGGER_ENTRIES = 64;", to: "const MAX_TRIGGER_ENTRIES = 65;" },
  { name: "empty-match regex", file: "triggers.ts", from: "if (compiled.test(\"\"))", to: "if (false && compiled.test(\"\"))" },
  { name: "path candidate length", file: "triggers.ts", from: "candidate.length > MAX_PATH_CANDIDATE_LENGTH", to: "false && candidate.length > MAX_PATH_CANDIDATE_LENGTH" },
  { name: "exact heading", file: "prompt-policy.ts", from: "systemPrompt.split(/\\r?\\n/).includes(heading)", to: "systemPrompt.includes(heading)" },
  { name: "config byte boundary", file: "index.ts", from: "statSync(configPath).size > MAX_CONFIG_BYTES", to: "statSync(configPath).size >= MAX_CONFIG_BYTES" },
  { name: "diagnostic bound", file: "index.ts", from: "const MAX_DIAGNOSTIC_LENGTH = 512;", to: "const MAX_DIAGNOSTIC_LENGTH = 513;" },
  { name: "duplicate disabled names", file: "index.ts", from: "if (config.disabled && new Set(config.disabled).size !== config.disabled.length)", to: "if (false && config.disabled && new Set(config.disabled).size !== config.disabled.length)" },
];

test("focused primitive tests kill critical boundary and containment mutants", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "gentic-primitives-mutation-"));
  try {
    for (const mutant of mutants) {
      const mutantRoot = join(sandbox, mutant.name.replaceAll(" ", "-"));
      cpSync(join(root, "extensions/pi-primitives"), join(mutantRoot, "extensions/pi-primitives"), { recursive: true });
      mkdirSync(join(mutantRoot, "test"), { recursive: true });
      cpSync(join(root, "test/fixtures"), join(mutantRoot, "test/fixtures"), { recursive: true });
      cpSync(join(root, "test/pi-primitives.test.ts"), join(mutantRoot, "test/pi-primitives.test.ts"));

      const target = join(mutantRoot, "extensions/pi-primitives", mutant.file);
      const source = readFileSync(target, "utf8");
      const occurrences = source.split(mutant.from).length - 1;
      assert.equal(occurrences, 1, `${mutant.name}: mutation target must be unique`);
      writeFileSync(target, source.replace(mutant.from, mutant.to));

      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST")));
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "test/pi-primitives.test.ts"], {
        cwd: mutantRoot,
        encoding: "utf8",
        env,
        timeout: 30000,
      });
      assert.notEqual(result.status, 0, `${mutant.name} survived\n${result.stdout}\n${result.stderr}`);
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
