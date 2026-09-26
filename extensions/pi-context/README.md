# pi-context

Lightweight, content-safe reporting for Pi's current context.

## Runtime model

`/pi-context` builds a fresh bounded snapshot from Pi native APIs. It calls `ctx.getContextUsage()`, `ctx.getSystemPromptOptions()`, and `ctx.sessionManager.getBranch()` once per request. It retains no prompt, message, path, identifier, tool argument/result, or per-entry observation.

The extension has four stable lifecycle subscriptions: `session_start`, `turn_end`, `session_compact`, and `session_shutdown`. Each session generation reloads configuration once and resets pressure state; turn and compaction hooks perform no filesystem work. Temporarily unavailable post-compaction usage preserves state until a valid sample reconciles it, and notification thresholds rearm only beyond hysteresis recovery. There are no message-stream, tool-execution, resource-discovery, filesystem-scan, static-inventory, or parallel-ledger subscriptions.

## `/pi-context`

- `/pi-context` or `/pi-context summary` shows remaining context, pressure, and broad aggregate contributors.
- `/pi-context artifact` (or `open`) explicitly writes content-safe Markdown under `.model-artifacts/system/reports/pi-context/`.
- `/pi-context json` explicitly writes the same allowlisted snapshot as JSON.
- Exports preserve canonical `YYYY-MM-DD_HHMM-<short-name>` filenames and exact rendered bytes while delegating bounded, exclusive, atomic publication to `src/services/safe-file-publication.ts`.
- The backend rejects traversal, symlinked or replaced parents, collisions, partial publication, and every `workflow.json` destination; pi-context has no workflow authority.
- Summary/default mode never writes an artifact.
- Completion remains a local order-independent adapter because mode and compatibility-filter tokens may be combined; forcing this grammar through action-only navigation would remove valid combinations without improving guidance.

Contributor names are fixed categories. The native compatibility adapter reads only named current Pi fields and measures strings or text blocks within hard character, content-block, and collection limits, then discards them. It never recursively walks or enumerates arbitrary objects. Because Pi does not expose authoritative contributor aggregates, `contributorDetail` is explicitly `degraded` when these bounded estimates are available and `unavailable` otherwise; `contributors-degraded` is a fixed diagnostic. Truncation produces bounded fixed diagnostic codes.

## Pressure

Pi's native aggregate is the authoritative source for current usage, but its numeric value is estimated: `getContextUsage()` uses the last assistant usage when available and estimates trailing messages. Available native estimates are classified with configurable warning, critical, and hysteresis percentages. Missing, null, unknown, inconsistent, or invalid usage remains unavailable and never notifies. Notifications are transition-only, advisory, and content-free. The extension never compacts, interrupts, dispatches work, switches models, or ends a session.

Configure version 1 globally at `~/.pi/agent/pi-context.json` or per project at `.pi/pi-context.json`; project values override global values field-by-field. Pi's native config-directory constant is used internally. Config files must be regular, non-symlinked files no larger than 16 KiB; unsafe or malformed files fail closed to defaults with bounded diagnostics.

## Supported consumer boundary

The registration-free package boundary is:

- `src/contracts/context-telemetry.ts`: `ContextTelemetrySnapshot`, its aggregate-only supporting types, and `CONTEXT_TELEMETRY_LIMITS`.
- `src/services/context-telemetry.ts`: `createContextTelemetrySnapshot()` for typed aggregate input and `sanitizeContextTelemetrySnapshot()` for fail-closed untyped/serialized input.
- The `pi-context` public entrypoint: the native Pi compatibility adapter plus `createPiContextHudSnapshot()`.

The shared contract and service have no command registration, event subscriptions, UI, filesystem, or process side effects. Consumers must treat Pi's native usage API as the authoritative source for the current aggregate while treating its numeric value as estimated; contributor values are degraded estimates, diagnostics are fixed codes, and absent fields are unavailable. Numeric aggregates saturate at `CONTEXT_TELEMETRY_LIMITS.maxNumericValue`, including HUD totals, so JSON output remains finite. Consumers must not depend on Pi runtime message, prompt, tool-input, identifier, or path shapes. Initiative 03 may migrate pi-hud to this boundary; it must not import new sibling-extension private `src` modules.

## HUD compatibility

The exported `createPiContextHudSnapshot()` adapter preserves the bounded HUD shape using a native snapshot. It exposes numeric usage labeled `estimated` (or `unknown` when unavailable), fixed contributor labels, fixed diagnostics, and pressure only. Existing snapshot fields remain unchanged; `contributorDetail` is additive in native JSON/Markdown reporting and is surfaced through fixed diagnostics to the current HUD adapter.

## Migration and rollback

The prior runtime ledger, static inventory, per-message/per-tool collectors, forensic entry exports, and maintained session snapshots were removed. The unused `pressure.repeatCooldownMs` field was also removed; version 1 loaders safely ignore it with a bounded migration diagnostic. Command aliases, report locations, pressure defaults, and the HUD adapter remain compatible. Rollback is a source revert; no persisted ledger or data migration is required.
