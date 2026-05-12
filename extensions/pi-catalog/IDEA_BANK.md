# pi quality-of-life idea bank

Purpose: durable, non-ephemeral idea bank for future Pi/Gentic quality-of-life extensions. Ideas here are candidates to pick, refine, and implement later.

## Current local surfaces

- `extensions/pi-skills/skills`: repeatable agent workflows.
- `extensions/pi-prompts/prompts`: reusable prompt templates.
- `extensions/pi-primitives/primitives`: conditional prompt/context primitives.
- `extensions/pi-commands/commands`: slash-command UX.
- `extensions/pi-catalog`: durable catalog/reference docs and introspection helpers.

## Existing command surface

- `/gentic`
- `/catalog`, `/catalog surfaces`, `/catalog surface <id>`, `/catalog events`
- `/surfaces`
- `/surface`
- `/events`
- `/clear`
- `/gate`
- `/pi-git`
- `/pi-hud`
- `/swe`
- `/todo`

## Existing extension events worth targeting

These are useful for conditional injections, takeover behavior, and low-context automation.

### Session lifecycle

- `session_start`: initialize status, detect repo state, attach passive helpers.
- `session_before_switch`: checkpoint before model/session switch.
- `session_before_fork`: create handoff packet before fork.
- `session_before_compact`: emit compact checkpoint or context-preservation note.
- `session_compact`: restore compacted state from checkpoint.
- `session_shutdown`: final checkpoint or cleanup.
- `session_before_tree`, `session_tree`: tree-aware orientation helpers.

### Agent/turn lifecycle

- `before_agent_start`: inject only the smallest relevant primitive before agent runs.
- `agent_start`, `agent_end`: timing, status, and post-run summary hooks.
- `turn_start`, `turn_end`: per-turn todo checks, checkpoint prompts, verification nudges.
- `context`: inspect context conditions before injecting.
- `before_provider_request`, `after_provider_response`: last-resort request/response shaping or metrics.

### Message/tool lifecycle

- `message_start`, `message_update`, `message_end`: stream-aware HUD or capture summaries.
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`: command/test progress, failure capture.
- `tool_call`, `tool_result`: enforce policies, summarize large outputs, record verification evidence.
- `user_bash`: intercept risky shell commands or suggest safer tools.
- `input`: shortcut/keybinding-style user input hooks.

### Model selection

- `model_select`: route tasks to cheaper/stronger models.
- `thinking_level_select`: raise/lower reasoning only when needed.

## Observed event usage by existing plugins

- `gentic`: `session_start`, `resources_discover`
- `pi-catalog`: `session_start`
- `pi-gate`: `session_start`, `tool_call`, `user_bash`
- `pi-hud`: `session_start`, `model_select`, `thinking_level_select`, `agent_start`, `agent_end`, `turn_start`, `tool_execution_start`, `tool_execution_end`, `tool_result`, `message_end`, `session_shutdown`
- `pi-primitives/implementation-file-completion`: `before_agent_start`
- `pi-swe`: `session_start`, `turn_start`, `tool_call`, `tool_result`
- `pi-todo`: `session_start`, `turn_end`, `tool_call`

---

# Idea 1: checkpoint/resume workspace

## Pitch

Add durable session checkpoints so users and agents can recover state after compaction, interruption, fork, handoff, or context loss.

## Candidate location

Start inside existing containers:

- `pi-commands`: `/checkpoint`, `/resume`, `/handoff`, `/where-am-i`
- `pi-prompts`: checkpoint and handoff templates
- `pi-skills`: checkpoint workflow skill
- `pi-primitives`: minimal conditional reminder before risky moments

Split later into `extensions/pi-workspace` only if it grows persistent indexing, sync, or dashboard UI.

## Commands

- `/checkpoint [label]`: write a durable checkpoint.
- `/resume [latest|label]`: summarize latest checkpoint and next action.
- `/handoff [agent|human]`: generate compact handoff packet.
- `/where-am-i`: show branch, todo, files changed, current objective, next step.
- `/checkpoint diff`: show what changed since last checkpoint.

## Shortcuts / aliases

- `/cp` -> `/checkpoint`
- `/rs` -> `/resume`
- `/ho` -> `/handoff`
- Optional input shortcut: `Ctrl+S` style intent could trigger checkpoint if Pi supports binding it through `input`.

## Event-driven behavior

- `session_before_compact`: auto-write compact checkpoint.
- `session_before_fork`: auto-create handoff packet.
- `session_before_switch`: checkpoint before switching sessions/models.
- `session_shutdown`: write final checkpoint if dirty state exists.
- `turn_end`: if files changed and tests passed, suggest checkpoint without injecting full context.
- `tool_result`: record verification command/result as metadata, not prompt text.

## Anti-bloat rule

Store full details in `extensions/pi-catalog/` or `.model-artifacts/checkpoints/`; inject only a one-line pointer unless `/resume` is invoked.

---

# Idea 2: verify-scope

## Pitch

Infer the smallest honest verification plan from changed files, package scripts, and touched domains.

## Candidate location

- `pi-commands`: `/verify-scope`, `/verify-last`
- `pi-skills`: verification planning workflow
- `pi-primitives`: conditional reminder before final answers when unverified changes exist

## Commands

- `/verify-scope`: list recommended checks for current diff.
- `/verify-scope --run`: run recommended low-risk checks.
- `/verify-last`: show latest verification evidence.
- `/verify-record <command>`: record external/manual verification.

## Shortcuts / aliases

- `/vs` -> `/verify-scope`
- `/vl` -> `/verify-last`

## Event-driven behavior

- `tool_call`: detect edit/write operations and mark verification stale.
- `tool_result`: capture test/build/lint command outcome.
- `turn_end`: if code changed and no verification, inject one concise warning.
- `before_agent_start`: add tiny primitive only when stale verification exists.

## Anti-bloat rule

Never inject full test logs. Store command, exit code, failing test names, and artifact path only.

---

# Idea 3: explain-tree / orientation map

## Pitch

A quick repo/module orientation command that explains what exists, what changed recently, and where to start.

## Candidate location

- `pi-commands`: `/explain-tree`, `/map-module`
- `pi-prompts`: architecture-summary prompt
- Maybe `pi-catalog`: store durable maps and glossary snapshots

## Commands

- `/explain-tree [path]`: summarize directory purpose and entry points.
- `/map-module <path>`: explain module internals, dependencies, and tests.
- `/map-changes`: explain current changed files by domain.

## Shortcuts / aliases

- `/tree?` -> `/explain-tree`
- `/map` -> `/map-module`

## Event-driven behavior

- `session_before_tree`, `session_tree`: provide tree summaries on demand.
- `resources_discover`: catalog surfaces/resources for orientation.
- `before_agent_start`: inject map pointer only when user asks about unfamiliar files.

## Anti-bloat rule

Cache maps as files; inject path plus 3 bullets, not the whole map.

---

# Idea 4: artifact command

## Pitch

Standardize durable generated outputs without treating them as ephemeral chat artifacts.

## Candidate location

- `pi-commands`: `/artifact`
- `pi-prompts`: artifact templates
- Maybe `pi-catalog`: idea bank, durable reference docs, and public catalog notes

## Commands

- `/artifact plan <name>`: create durable plan file.
- `/artifact decision <name>`: create ADR-style decision note.
- `/artifact idea <name>`: append to idea bank.
- `/artifact list`: list known durable artifacts.
- `/artifact promote <file>`: move ephemeral `.model-artifacts` content into durable project docs.

## Shortcuts / aliases

- `/art` -> `/artifact`
- `/idea` -> `/artifact idea`

## Event-driven behavior

- `tool_result`: when a generated plan/report is written, remind agent to record location only.
- `turn_end`: if long plan appears inline, suggest saving as artifact next time.

## Anti-bloat rule

Commands return path + one-line description only.

---

# Idea 5: takeover / do-first guard

## Pitch

A policy layer for conditional takeover before risky or wasteful actions: huge output, unsafe shell, broad edits, missing todo, or missing verification.

## Candidate location

Likely its own extension if it grows: `extensions/pi-guard` or extend `pi-gate`.

## Commands

- `/gate status`: show active guards.
- `/gate enable <guard>` / `/gate disable <guard>`
- `/gate why`: explain last intervention.
- `/do-first list`: show currently required first actions.

## Shortcuts / aliases

- `/gf` -> `/gate status`
- `/why` -> `/gate why`

## Event-driven behavior

- `user_bash`: intercept commands likely to flood context or mutate broadly.
- `tool_call`: block or rewrite risky file operations.
- `tool_result`: detect huge output and require context-mode summarization.
- `before_agent_start`: inject a single do-first instruction, not a full policy block.
- `turn_start`: clear stale guard state.

## Example guards

- use todo before non-read tools.
- use context-mode for commands likely over 20 lines.
- use read before edit.
- use git snapshot before commit/push.
- do not inline generated artifacts.

## Anti-bloat rule

Guard state lives in extension memory/status. Prompt injection is a terse single sentence only when a guard is active.

---

# Idea 6: model/thinking router

## Pitch

Choose model and thinking level based on task risk, command type, and phase.

## Candidate location

Could extend `pi-hud` or become `pi-router` if policy gets complex.

## Commands

- `/router status`: show current routing policy.
- `/router explain`: explain last model/thinking decision.
- `/router pin <model>`: temporarily pin model.
- `/router unpin`: clear pin.

## Shortcuts / aliases

- `/mx` -> `/router explain`
- `/pin` -> `/router pin`

## Event-driven behavior

- `model_select`: choose model from task profile.
- `thinking_level_select`: increase for architecture/debugging, decrease for simple edits.
- `tool_result`: if tests fail repeatedly, raise reasoning level next turn.
- `turn_end`: decay elevated reasoning after resolution.

## Anti-bloat rule

Expose decision in HUD/status, not repeated prompt text.

---

# Idea 7: smart prompt/skill picker

## Pitch

Suggest or auto-activate the right skill/prompt based on user intent and repo state.

## Candidate location

- `pi-primitives`: conditional skill hints.
- `pi-skills`: meta-skill for adding/routing skills.
- Maybe `pi-catalog`: discover available skills/prompts.

## Commands

- `/suggest-skill`: recommend relevant skills.
- `/suggest-prompt`: recommend prompt templates.
- `/use-skill <name>`: activate/read skill.

## Shortcuts / aliases

- `/skill?` -> `/suggest-skill`
- `/prompt?` -> `/suggest-prompt`

## Event-driven behavior

- `input`: classify user request before agent turn.
- `before_agent_start`: inject only skill name + path, not full skill text.
- `resources_discover`: build skill/prompt inventory.

## Anti-bloat rule

Never auto-inject entire skills. Suggest activation or include a pointer unless confidence is very high.

---

# Idea 8: recent-context ledger

## Pitch

Track recent meaningful events in a compact ledger: decisions, files changed, tests run, blockers, and next actions.

## Candidate location

Could be part of checkpoint/resume or separate `pi-ledger`.

## Commands

- `/ledger`: show compact recent ledger.
- `/ledger add <note>`: add manual note.
- `/ledger decisions`: show decisions only.
- `/ledger clear`: archive and reset.

## Shortcuts / aliases

- `/log` -> `/ledger`
- `/decisions` -> `/ledger decisions`

## Event-driven behavior

- `tool_call`, `tool_result`: record edits and verification.
- `message_end`: summarize assistant final answer as a ledger entry.
- `turn_end`: update next-action pointer.
- `session_compact`: restore ledger pointer.

## Anti-bloat rule

Ledger stores structured facts; prompt sees at most latest objective + next action.

---

# Idea 9: package surface scaffolder

## Pitch

Use pi-catalog knowledge to scaffold new skills, prompts, primitives, commands, themes, or extensions consistently.

## Candidate location

Extend `pi-catalog` and `pi-commands`.

## Commands

- `/scaffold skill <name>`
- `/scaffold prompt <name>`
- `/scaffold command <name>`
- `/scaffold primitive <name>`
- `/scaffold extension <name>`
- `/scaffold check`: validate package manifest discovery entries.

## Shortcuts / aliases

- `/new-skill`
- `/new-prompt`
- `/new-command`

## Event-driven behavior

- `resources_discover`: validate discoverable resources.
- `tool_result`: after scaffold writes, remind to update package metadata if needed.

## Anti-bloat rule

Use templates on disk; command output is only created paths and next command.

---

# Idea 10: context budget HUD

## Pitch

Show context pressure and prevent accidental bloat by suggesting summarization/checkpoint before it hurts.

## Candidate location

Extend `pi-hud` or add `pi-context-budget`.

## Commands

- `/context-budget`: show current budget estimate.
- `/context-trim`: suggest what can be summarized or moved to files.
- `/context-rules`: show active output rules.

## Shortcuts / aliases

- `/cb` -> `/context-budget`
- `/trim` -> `/context-trim`

## Event-driven behavior

- `message_update`, `message_end`: estimate assistant output size.
- `tool_result`: detect oversized output.
- `before_provider_request`: warn or compact if request is too large.
- `session_before_compact`: checkpoint before compaction.

## Anti-bloat rule

Only surface warnings at thresholds; default to HUD/status indicators.

---

# Prioritized shortlist

1. Checkpoint/resume workspace: largest daily QoL win.
2. Verify-scope: prevents false confidence and speeds finalization.
3. Takeover/do-first guard: enforces quality without huge prompt policies.
4. Artifact command: keeps durable docs clean and discoverable.
5. Smart prompt/skill picker: improves reuse of existing surfaces.

# Selection criteria

Pick an idea when it satisfies at least two:

- removes repeated manual steps;
- reduces context bloat;
- improves recovery after interruption;
- improves safety before mutation/commit;
- composes with existing events instead of requiring heavy infra;
- can start as command + prompt + primitive before becoming a full extension.
