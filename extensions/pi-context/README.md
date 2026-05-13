# pi-context

Runtime shell and domain model for Pi context ledger collectors and reports.

The extension registers Pi lifecycle hooks on load, initializes an empty per-session ledger, records lightweight usage snapshots when `ctx.getContextUsage()` is available, and records a static source inventory during `before_agent_start` from Pi's structured `systemPromptOptions`.

Static inventory entries store paths/package names, byte/token estimates, SHA-256 hashes, and redaction metadata. Source content is not stored by default; absent optional context files are represented as absent entries.

Earliest capture: Pi documents `session_start` as the first extension lifecycle event. If a future runtime misses it, pi-context lazily initializes at the earliest observed hook (`resources_discover`, `before_agent_start`, `context`, or `before_provider_request`) and records a warning for that unavoidable blind spot.

## `/pi-context` command

`/pi-context` or `/pi-context summary` renders a concise terminal report from the maintained in-memory ledger snapshot; it does not rescan the full session history. The summary includes total tokens/bytes, remaining context when exposed by Pi, compaction stats, ordered System/User/Project/Extensions/Session/Tools/Discovered breakdowns, and exact/estimated/unavailable warnings.

Use filters to keep terminal output small: `/pi-context tools`, `/pi-context extensions`, `/pi-context system session`, or `/pi-context artifacts`.

Use `/pi-context artifact` (or `/pi-context open`) to write an expanded markdown report under `.model-artifacts/todo/pi-context/reports/`. Use `/pi-context json` to write the same maintained snapshot as deterministic JSON for downstream tools and todo evidence.

## UI integration

pi-context remains the owner of ledger accounting and exposes a bounded `createPiContextHudSnapshot()` adapter for operator surfaces. `pi-hud` consumes that adapter to show live context pressure in its footer/modal without importing ledger internals or rendering raw ledger entries.

The HUD adapter includes only totals, remaining window, largest group, latest compaction, and a top-N contributor list. Contributor labels are conservative: file paths, prompts, tool arguments, content previews, and artifact locations are not exposed in HUD data.

## Persistence, privacy, and performance policy

- Persistence is per-session and in-memory by default. `session_shutdown` resets the ledger; `session_compact` clears stale entries while preserving a compact compaction observation.
- Artifact export is explicit via `/pi-context artifact` or `/pi-context json`; reports are written under `.model-artifacts/todo/pi-context/reports/` and are not generated automatically.
- Project reset/deletion should remove those report artifacts with the rest of `.model-artifacts`; no hidden long-term pi-context store is created.
- Raw prompts, tool arguments, tool results, and large content previews are never stored in ledger entries. Collectors keep byte/token counts, hashes, status flags, path counts, and redaction metadata instead.
- Runtime retention is bounded: ledger entries, usage snapshots, lifecycle events, warnings, HUD contributors, and rendered warnings are capped. Hot-path hooks update maintained state only; report and HUD rendering do not scan full session history or filesystem trees.
