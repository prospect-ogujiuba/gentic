import test from "node:test";
import assert from "node:assert/strict";
import { recordLedgerEntries, startSessionState } from "../extensions/pi-context/src/app/index.ts";
import { collectStaticInventory } from "../extensions/pi-context/src/pi/index.ts";

const at = "2026-05-13T02:00:00.000Z";

test("static inventory groups system, user, project, extension and tool sources without storing content", () => {
  const inventory = collectStaticInventory({
    at,
    cwd: "/repo/work",
    homeDir: "/home/alice",
    systemPrompt: "base system prompt",
    systemPromptOptions: {
      cwd: "/repo/work",
      contextFiles: [
        { path: "/home/alice/.pi/agent/AGENTS.md", content: "global guidance" },
        { path: "/repo/AGENTS.md", content: "repo guidance" },
      ],
      selectedTools: ["read", "bash"],
      toolSnippets: { read: "Read file contents" },
      skills: [
        {
          name: "context-mode",
          description: "Use context-mode tools",
          filePath: "/packages/context-mode/skills/context-mode/SKILL.md",
          sourceInfo: { source: "npm:context-mode", scope: "user", origin: "package", path: "/packages/context-mode/skills" },
        },
      ],
    },
  });

  const byKind = new Set(inventory.entries.map((entry) => entry.kind));
  assert.equal(byKind.has("system"), true);
  assert.equal(byKind.has("user"), true);
  assert.equal(byKind.has("project"), true);
  assert.equal(byKind.has("extension"), true);
  assert.equal(byKind.has("tool"), true);
  assert.equal(inventory.entries.some((entry) => entry.sourceMetadata?.status === "absent" && entry.kind === "project"), true);

  const measured = inventory.entries.find((entry) => entry.origin === "/repo/AGENTS.md");
  assert.equal(measured?.redaction?.redacted, true);
  assert.equal(measured?.sourceMetadata?.contentStored, false);
  assert.match(measured?.sourceMetadata?.hash ?? "", /^[a-f0-9]{64}$/);
});

test("recorded static inventory updates rediscovered sources without duplicating entries", () => {
  startSessionState({ reason: "startup", at, metadata: { sessionId: "s-static" } });
  const first = collectStaticInventory({
    at,
    cwd: "/repo",
    homeDir: "/home/alice",
    systemPromptOptions: { cwd: "/repo", contextFiles: [{ path: "/repo/AGENTS.md", content: "old" }] },
  });
  recordLedgerEntries({ at, entries: first.entries, warnings: first.warnings });

  const second = collectStaticInventory({
    at: "2026-05-13T02:01:00.000Z",
    cwd: "/repo",
    homeDir: "/home/alice",
    systemPromptOptions: { cwd: "/repo", contextFiles: [{ path: "/repo/AGENTS.md", content: "new and longer" }] },
  });
  const state = recordLedgerEntries({ at: "2026-05-13T02:01:00.000Z", entries: second.entries, warnings: second.warnings });

  const projectAgents = state.ledgerEntries.filter((entry) => entry.origin === "/repo/AGENTS.md");
  assert.equal(projectAgents.length, 1);
  assert.equal(projectAgents[0]?.byteCount, "new and longer".length);
  assert.equal(projectAgents[0]?.firstSeenAt, at);
  assert.equal(projectAgents[0]?.lastSeenAt, "2026-05-13T02:01:00.000Z");
});
