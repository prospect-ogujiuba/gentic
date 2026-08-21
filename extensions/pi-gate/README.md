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

- **What it does:** evaluates deny-first shell policy, blocks protected edit/write paths, and optionally owns configured project-trust decisions. Shell control syntax always requires explicit confirmation; cancellation, timeout, prompt failure, and noninteractive asks fail closed.
- **Commands/tools it registers:** `/gate` command for status, `reload`, `check <cmd>`, and `mode <ask|strict|permissive|off>`. It registers no model-callable tool.
- **Pi events it listens to:** `project_trust` applies global trust policy before project resources load; `session_start` validates trusted config and sets status; `tool_call` gates `bash`, `read`, `edit`, and `write`; `user_bash` gates user bash commands.
- **State/config files it reads/writes:** reads `PI_GATE_CONFIG`, `~/.pi/pi-gate/pi-gate.json`, and `<project>/.pi/pi-gate/pi-gate.json`; writes remembered project/global rules to those config locations; writes audit JSONL to `.pi/pi-gate/pi-gate-audit.jsonl` by default; keeps session-only remembered decisions and stats in memory.
- **Internal module map:** `index.ts` remains the extension entrypoint and public test exports; `src/config/index.ts` loads/merges config; `src/domain/policy.ts` normalizes commands, expands wildcard patterns, and decides allow/ask/deny; `src/app/audit.ts` appends audit JSONL; `src/app/remember.ts` stores session/project/global remembered rules; `src/ui/prompt.ts` owns the mode-aware native dialog and safe outcome contract; `src/pi/register.ts` wires Pi events and `/gate`; `pi-gate.schema.json` documents the JSON config shape.
- **Tests to run:** `npm run test:gate` or the full `npm test` suite.
- **Known boundaries/non-goals:** this is conservative classification, not a complete shell parser or sandbox. Configured `permissions` are explicit globs; remembered commands are stored separately in `literalPermissions` and match exactly. Invalid reloads retain the last-known-good policy.

## Prompt outcome contract

`promptPermissionOutcome()` returns `{ action, outcome, remember, error? }`. The possible outcomes are `allow`, `deny`, `cancel`, `timeout`, `unavailable`, and `error`. Only explicit allow choices return `action: "allow"`; every other outcome denies safely. Remembered-rule behavior is unchanged and runs only after an explicit selection.

| Pi mode | Prompt behavior |
|---|---|
| `tui` | Native `select()` dialog with abort signal and 30-second timeout. |
| `rpc` | The same supported dialog API through the RPC extension-UI protocol; no custom component factory is invoked. |
| `json` | No UI call; `unavailable`/deny. |
| `print` | No UI call; `unavailable`/deny. |

Escape/client cancellation resolves `cancel`; the deadline resolves `timeout`; thrown or unknown dialog results resolve `error`. `session_shutdown` aborts every pending gate dialog and clears the `pi-gate` status key. Project-trust confirmation also fails closed on unavailable UI, timeout/cancellation, or dialog error.
