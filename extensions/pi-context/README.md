# pi-context

Runtime shell and domain model for Pi context ledger collectors and reports.

The extension registers Pi lifecycle hooks on load, initializes an empty per-session ledger, records lightweight usage snapshots when `ctx.getContextUsage()` is available, and records a static source inventory during `before_agent_start` from Pi's structured `systemPromptOptions`.

Static inventory entries store paths/package names, byte/token estimates, SHA-256 hashes, and redaction metadata. Source content is not stored by default; absent optional context files are represented as absent entries.

Earliest capture: Pi documents `session_start` as the first extension lifecycle event. If a future runtime misses it, pi-context lazily initializes at the earliest observed hook (`resources_discover`, `before_agent_start`, `context`, or `before_provider_request`) and records a warning for that unavoidable blind spot.

| Pi lifecycle event | pi-context behavior |
|---|---|
| `session_start` | Reset closure counters/maps and start a fresh ledger generation. |
| `input` → `turn_start` | Record input unassigned, then attach it to the newly known turn; never reuse the prior turn. |
| `message_update` | Sample every 8th streaming update; `message_end` always records final data. |
| `tool_execution_start/update`, `tool_result`, `tool_execution_end` | Merge arguments, paths, partial/final output, details, and status monotonically by tool-call ID. |
| `agent_settled` | Close turn attribution after retries and queued continuations settle. |
| `session_tree` | Drop abandoned-branch observations and begin collection from the selected leaf. |
| `session_compact` | Replace stale observations with the compaction checkpoint. |
| `session_shutdown` | Clear all session closure state and mark the ledger inactive. |

## `/pi-context` command

`/pi-context` or `/pi-context summary` renders a concise terminal report from the maintained in-memory ledger snapshot; it does not rescan the full session history. The summary includes total tokens/bytes, remaining context when exposed by Pi, compaction stats, ordered System/User/Project/Extensions/Session/Tools/Discovered breakdowns, and exact/estimated/unavailable warnings.

Use filters to keep terminal output small: `/pi-context tools`, `/pi-context extensions`, `/pi-context system session`, or `/pi-context artifacts`.

Use `/pi-context artifact` (or `/pi-context open`) to write an expanded markdown report under `.model-artifacts/system/reports/pi-context/`. Use `/pi-context json` to write the same maintained snapshot as deterministic JSON for downstream tools and todo evidence. Summary, markdown, JSON, and the HUD adapter expose the same maintained pressure level and remaining percentage.

## Context-pressure guardrails

Pressure guardrails are advisory only: they never compact, interrupt, dispatch work, switch models, or end a session. Defaults classify exact measured remaining context as `warning` at 25% and `critical` at 10%, with 5 percentage points of hysteresis. Notifications occur only on a downward transition; recovery above the applicable hysteresis boundary rearms that transition. Missing, invalid, or estimated-only usage is reported as `unavailable` and does not notify.

Configure version 1 globally at `~/.pi/agent/pi-context.json` or per project at `.pi/pi-context.json`. Project values override global values field-by-field; invalid files, future versions, and invalid threshold ordering emit bounded diagnostics and fall back safely.

```json
{
  "version": 1,
  "pressure": {
    "warningPercent": 25,
    "criticalPercent": 10,
    "hysteresisPercent": 5,
    "repeatCooldownMs": 300000
  }
}
```

At `warning`, finish the current unit of work or compact soon. At `critical`, compact or start a new session before continuing. `/pi-context` remains available for inspection in every band. Pressure state and notifications contain only the level, numeric usage/policy values, and bounded diagnostics—never prompts, tool arguments/results, credentials, content previews, or source paths.

Qualification scenario: start with exact measured usage above 30% remaining, cross 25% once, repeat samples in the warning band, cross 10% once, then recover above 30%. Expect one warning, one critical notification, no repeats, and matching summary/markdown/JSON/HUD pressure values. Repeat with estimated usage and expect `unavailable` with no notification.

## UI integration

pi-context remains the owner of ledger accounting and exposes a bounded `createPiContextHudSnapshot()` adapter for operator surfaces. `pi-hud` consumes that adapter to show live context pressure in its footer/modal without importing ledger internals or rendering raw ledger entries.

The HUD adapter includes only totals, remaining window, largest group, latest compaction, and a top-N contributor list. Contributor labels are conservative: file paths, prompts, tool arguments, content previews, and artifact locations are not exposed in HUD data.

## Persistence, privacy, and performance policy

- Persistence is per-session and in-memory by default. `session_shutdown` resets the ledger; `session_compact` clears stale entries while preserving a compact compaction observation.
- Artifact export is explicit via `/pi-context artifact` or `/pi-context json`; reports are written under `.model-artifacts/system/reports/pi-context/` and are not generated automatically.
- Project reset/deletion should remove those report artifacts with the rest of `.model-artifacts`; no hidden long-term pi-context store is created.
- Raw prompts, tool arguments, tool results, and large content previews are never stored in ledger entries. Collectors keep byte/token counts, hashes, status flags, path counts, and redaction metadata instead.
- Runtime retention is bounded: ledger entries, usage snapshots, lifecycle events, warnings, HUD contributors, and rendered warnings are capped. Hot-path hooks update maintained state only; report and HUD rendering do not scan full session history or filesystem trees.
