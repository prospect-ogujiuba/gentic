# pi-context

Lightweight, content-safe reporting for Pi's current context.

## Runtime model

`/pi-context` builds a fresh bounded snapshot from Pi native APIs. It calls `ctx.getContextUsage()`, `ctx.getSystemPromptOptions()`, and `ctx.sessionManager.getBranch()` once per request. It retains no prompt, message, path, identifier, tool argument/result, or per-entry observation.

The extension has four stable lifecycle subscriptions: `session_start`, `turn_end`, `session_compact`, and `session_shutdown`. Each session generation reloads configuration once and resets pressure state; turn and compaction hooks perform no filesystem work. Temporarily unavailable post-compaction usage preserves state until a valid sample reconciles it, and notification thresholds rearm only beyond hysteresis recovery. There are no message-stream, tool-execution, resource-discovery, filesystem-scan, static-inventory, or parallel-ledger subscriptions.

## `/pi-context`

- `/pi-context` or `/pi-context summary` shows remaining context, pressure, and broad aggregate contributors.
- `/pi-context artifact` (or `open`) explicitly writes content-safe Markdown under `.model-artifacts/system/reports/pi-context/`.
- `/pi-context json` explicitly writes the same allowlisted snapshot as JSON.
- Exports use canonical `YYYY-MM-DD_HHMM-<short-name>` artifact filenames, exclusive creation, and reject symlinked or escaping report paths.
- Summary/default mode never writes an artifact.
- Completion remains a local order-independent adapter because mode and compatibility-filter tokens may be combined; forcing this grammar through action-only navigation would remove valid combinations without improving guidance.

Contributor names are fixed categories. Source text is measured within hard character, node, depth, property, content-block, and collection limits, then discarded. Truncation produces bounded fixed diagnostic codes.

## Pressure

Pi native usage is an estimate: `getContextUsage()` uses the last assistant usage when available and estimates trailing messages. Available native estimates are classified with configurable warning, critical, and hysteresis percentages. Missing, null, unknown, or invalid usage remains unavailable and never notifies. Notifications are transition-only, advisory, and content-free. The extension never compacts, interrupts, dispatches work, switches models, or ends a session.

Configure version 1 globally at `~/.pi/agent/pi-context.json` or per project at `.pi/pi-context.json`; project values override global values field-by-field. Pi's native config-directory constant is used internally. Config files must be regular, non-symlinked files no larger than 16 KiB; unsafe or malformed files fail closed to defaults with bounded diagnostics.

## HUD compatibility

The exported `createPiContextHudSnapshot()` adapter preserves the bounded HUD shape using a native snapshot. It exposes numeric usage labeled `estimated` (or `unknown` when unavailable), fixed contributor labels, fixed diagnostics, and pressure only.

## Migration and rollback

The prior runtime ledger, static inventory, per-message/per-tool collectors, forensic entry exports, and maintained session snapshots were removed. The unused `pressure.repeatCooldownMs` field was also removed; version 1 loaders safely ignore it with a bounded migration diagnostic. Command aliases, report locations, pressure defaults, and the HUD adapter remain compatible. Rollback is a source revert; no persisted ledger or data migration is required.
