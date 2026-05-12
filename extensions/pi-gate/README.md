# pi-gate

`pi-gate` is a Pi extension that gates bash execution with allow/ask/deny command-pattern rules. It protects both agent-initiated bash tool calls and user-triggered bash commands, records audit events when enabled, and can persist remembered decisions to project or global config.

## Anatomy

- **Mode:** `layered`
- **State:** `layered-lite`
- **Public entry:** `index.ts`
- **Layers:** `config`, `domain`, `app`, `pi`, `ui`
- **Machine declaration:** `extension.anatomy.json`
- **Reference role:** layered-lite migrated example.
- **Mismatch notes:** none known; layer folders are intentionally lightweight rather than deep framework structure.

## Orientation block

- **What it does:** evaluates normalized shell command text against configured and built-in permission patterns, optionally prompts through the TUI, then allows or blocks execution.
- **Commands/tools it registers:** `/gate` command for status, `reload`, `check <cmd>`, and `mode <ask|strict|permissive|off>`. It registers no model-callable tool.
- **Pi events it listens to:** `session_start` loads config and sets status; `tool_call` gates the `bash` tool; `user_bash` gates user bash commands.
- **State/config files it reads/writes:** reads `PI_GATE_CONFIG`, `~/.pi/pi-gate/pi-gate.json`, and `<project>/.pi/pi-gate/pi-gate.json`; writes remembered project/global rules to those config locations; writes audit JSONL to `.pi/pi-gate/pi-gate-audit.jsonl` by default; keeps session-only remembered decisions and stats in memory.
- **Internal module map:** `index.ts` remains the extension entrypoint and public test exports; `src/config/index.ts` loads/merges config; `src/domain/policy.ts` normalizes commands, expands wildcard patterns, and decides allow/ask/deny; `src/app/audit.ts` appends audit JSONL; `src/app/remember.ts` stores session/project/global remembered rules; `src/ui/prompt.ts` renders the TUI prompt and no-UI fallback; `src/pi/register.ts` wires Pi events and `/gate`; `pi-gate.schema.json` documents the JSON config shape.
- **Tests to run:** `npm run test:gate` or the full `npm test` suite.
- **Known boundaries/non-goals:** gates bash command text only; it does not parse shell syntax deeply, sandbox commands, or gate non-bash tools.
