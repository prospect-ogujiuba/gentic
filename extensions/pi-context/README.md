# pi-context

Lightweight, content-safe reporting for Pi's current context.

## Runtime model

`/pi-context` builds a fresh bounded snapshot from Pi native APIs. It calls `ctx.getContextUsage()`, `ctx.getSystemPromptOptions()`, and `ctx.sessionManager.getBranch()` once per request. It retains no prompt, message, path, identifier, tool argument/result, or per-entry observation.

The extension has four stable lifecycle subscriptions: `session_start`, `turn_end`, `session_compact`, and `session_shutdown`. They maintain only pressure policy and hysteresis state. There are no message-stream, tool-execution, resource-discovery, filesystem-scan, static-inventory, or parallel-ledger subscriptions.

## `/pi-context`

- `/pi-context` or `/pi-context summary` shows remaining context, pressure, and broad aggregate contributors.
- `/pi-context artifact` (or `open`) explicitly writes content-safe Markdown under `.model-artifacts/system/reports/pi-context/`.
- `/pi-context json` explicitly writes the same allowlisted snapshot as JSON.
- Summary/default mode never writes an artifact.

Contributor names are fixed categories. Source text is measured within hard character, node, depth, property, content-block, and collection limits, then discarded. Truncation produces bounded fixed diagnostic codes.

## Pressure

Exact native usage is classified with configurable warning, critical, hysteresis, and cooldown values. Notifications are transition-only, advisory, and content-free. The extension never compacts, interrupts, dispatches work, switches models, or ends a session.

Configure version 1 globally at `~/.pi/agent/pi-context.json` or per project at `.pi/pi-context.json`; project values override global values field-by-field.

## HUD compatibility

The exported `createPiContextHudSnapshot()` adapter preserves the bounded HUD shape using a native snapshot. It exposes numeric usage, fixed contributor labels, fixed diagnostics, and pressure only.

## Migration and rollback

The prior runtime ledger, static inventory, per-message/per-tool collectors, forensic entry exports, and maintained session snapshots were removed. Command aliases, report locations, pressure defaults, and the HUD adapter remain compatible. Rollback is a source revert; no persisted ledger or data migration is required.
