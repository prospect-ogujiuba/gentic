# pi quality-of-life idea bank

Purpose: durable, non-ephemeral idea bank for future Pi/Gentic quality-of-life extensions. Ideas here are candidates to pick, refine, and implement later.

## Current local surfaces

- `skills`: root-owned repeatable agent workflows.
- `prompts`: root-owned reusable prompt templates.
- `extensions/pi-primitives/primitives`: conditional prompt/context primitives.
- `extensions/pi-commands/commands`: slash-command UX.
- `extensions/pi-catalog`: durable catalog/reference docs and introspection helpers.

## Existing command surface

- `/gentic`
- `/catalog`, `/catalog surfaces [id]`, `/catalog events`, `/catalog <capability-group>`
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
- `pi-permission-system`: `session_start`, `resources_discover`, `session_shutdown`, `before_agent_start`, `input`, `tool_call`
- `pi-hud`: `session_start`, `model_select`, `thinking_level_select`, `agent_start`, `agent_end`, `turn_start`, `tool_execution_start`, `tool_execution_end`, `tool_result`, `message_end`, `session_shutdown`
- `pi-primitives/implementation-file-completion`: `before_agent_start`
- `pi-swe`: `session_start`, `turn_start`, `tool_call`, `tool_result`
- `pi-todo`: `session_start`, `turn_end`, `tool_call`

---

# Idea: artifact command

## Pitch

Standardize durable generated outputs without treating them as ephemeral chat artifacts.

## Candidate location

- `pi-commands`: `/artifact`
- root `prompts/`: artifact templates
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

# Idea: model/thinking router

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

# Implemented: package surface scaffolder

`/scaffold` now previews and atomically applies project-aware native Pi templates. It covers extensions, registrations, UI surfaces, package resources, and retained primitives; see `extensions/pi-commands/README.md`.

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
